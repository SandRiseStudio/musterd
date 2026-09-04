import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import {
  matchBinding,
  type ContinuityRegistry,
  type WakeExactMatchResult,
} from '@musterd/protocol';
import { fmtBytes } from '../../args.js';
import { invalidateClaudeBinCache, resolveClaudeBin } from '../../claudeBin.js';
import { readRegistry, type RegistryOwner } from '../../session/continuity.js';
import {
  localSessionLiveness,
  RESUME_GC_HORIZON_MS,
  type LocalSessionLiveness,
} from '../../session/liveness.js';
import type {
  ActuatorBackend,
  BackendContext,
  WakeActuation,
  WakeCompletion,
  WakeSpec,
} from '../backend.js';
import { ensurePinnedMusterd, wakeEnv } from '../pinnedBin.js';

/**
 * Backend #1: Claude Code, fresh-first with the increment-4 resume upgrade (ADR 131 §5). The
 * durable identity is the SEAT — its worktree, memory, lanes, primer — so a wake never *requires*
 * a captured session: when the workspace's `binding.session` holds a resumable capture the run is
 * `claude --resume <id>` (the seat continues its own transcript — one life, one transcript), and on
 * ANY resume miss — no capture, harness mismatch, GC horizon, bloated/missing transcript, the
 * resume child dying or not occupying — it degrades to the increment-3 fresh spawn **inside the
 * same lease**. Resume is an upgrade, never a dependency.
 *
 * Capture is self-maintaining: the spawned session's own SessionStart hook records the id this
 * backend minted (fresh) or resumed into `binding.session` — the host never writes the capture.
 *
 * Invariants this file carries (ADR 131 §6):
 * - the prompt is the daemon-composed line, verbatim — no message bodies ever enter a spawn;
 * - reply-only: allowed tools scoped to the musterd MCP server, under the DEFAULT permission mode
 *   — and the wake path never passes a skip-permissions flag (the steward's CI shape does not
 *   transfer to a laptop) on ANY arg builder, fresh or resume;
 * - verification is roster-derived via {@link BackendContext.verifyOccupied} — headless stdout is
 *   never a verification source (headless modes hang and lie);
 * - the watchdog timeout is mandatory and kills the whole process group, per attempt;
 * - the session id stays on this machine — it rides argv to the local harness and never travels
 *   to the daemon (the wake report carries only the `fresh | resumed` axis).
 */

/** How long after SIGTERM before the group gets SIGKILL. */
const KILL_GRACE_MS = 10_000;

/** Roster sub-window for the resume attempt: long enough for a healthy resume to occupy (the
 *  measured fresh wake occupied in ~22s), short enough that a dead resume leaves the bulk of the
 *  90s verify budget for the fresh fallback under the 120s lease TTL. */
const RESUME_VERIFY_WINDOW_MS = 30_000;

/** How long a roster-verified child must stay alive (or have exited 0) before the hit counts —
 *  the anti-debris confirmation beat. A stale-id resume dies in ~2-3s; a real occupant lives on. */
const VERIFY_CONFIRM_BEAT_MS = 3_000;

/** The context-hygiene bound (ADR 131 §5: "prefers resume for continuity but rolls over to a
 *  fresh session when the transcript is bloated or stale" — the cost bound and the compaction
 *  escape are one clause): past it, resume spends more re-ingesting history than a fresh
 *  seat-primer boot costs.
 *
 *  RECALIBRATED 2026-07-29 from 10 MiB to 256 KiB. The old value was derived by counting *lives*
 *  (~108 KiB/life ⇒ 10 MiB ≈ 60 lives) and never checked against the dollar crossover the sentence
 *  above states. All 11 `residency.wake_cost` rows, joined to the pre-wake transcript size their
 *  ladder actually compared against:
 *
 *      fresh   (n=4):  $1.01  $1.51  $0.91  $1.09          → mean $1.13, range $0.91–1.51
 *      resumed 231 KiB  $1.21  | 308 KiB  $1.23 | 373 KiB  $0.76   ← at or under the fresh range
 *      resumed 450 KiB  $2.53  | 3.4 MiB  $9.08                    ← 2.2x and 8.0x a fresh boot
 *
 *  So the crossover is bracketed by [373 KiB, 450 KiB] — 23x below the old bound. Inside the cheap
 *  region cost is NOT monotonic in transcript size ($0.76 at 373 KiB beats $1.21 at 231 KiB),
 *  because `cost_usd` is the whole wake and the work done dominates; those cheap points are
 *  therefore *lower bounds* on ingestion cost, and n=1 per point cannot resolve the crossover more
 *  finely. 256 KiB takes the conservative end of an unresolvable bracket: ~3 lives of continuity at
 *  the measured ~70–80 KiB/life, comfortably below every resume that overran a fresh boot.
 *
 *  This is the fallback only — the server puts the effective policy's `transcript_max_bytes` on
 *  every order, so a team whose stored policy materialized the old value keeps it until rewritten
 *  (see ADR 131 "Observability & Evaluation"). */
export const RESUME_TRANSCRIPT_MAX_BYTES = 256 * 1024;

/** Per-run argv options (increment 5) — delivered on the wake order by the daemon's effective
 *  policy, applied identically to the fresh and resume paths (one permission posture per run). */
export interface WakeArgOpts {
  /** `reply-only` (default) scopes the run to the musterd tools via `--allowedTools`; `seat-policy`
   *  omits the flag so the workspace's own settings govern. NEITHER ever passes a skip-permissions
   *  flag — the explicit ADR 131 §6 invariant, enforced by the argv tests for both policies. */
  toolPolicy?: 'reply-only' | 'seat-policy';
  /** `--max-turns` where set (the claude CLI supports it; other backends may not). */
  maxTurns?: number;
}

function argTail(opts: WakeArgOpts): string[] {
  return [
    ...(opts.toolPolicy === 'seat-policy' ? [] : ['--allowedTools', 'mcp__musterd']),
    ...(opts.maxTurns !== undefined ? ['--max-turns', String(opts.maxTurns)] : []),
    '--output-format',
    'json',
  ];
}

/** Injectables so tests never spawn a real harness. */
export interface ClaudeCodeDeps {
  resolveBin?: () => Promise<string | null>;
  spawn?: typeof nodeSpawn;
  mintSessionId?: () => string;
  killGraceMs?: number;
  /** Injectable capture read (default: the shared {@link localSessionLiveness}). */
  readSession?: (workspace: string) => LocalSessionLiveness;
  /** Injectable pinned-shim write (default: {@link ensurePinnedMusterd}); tests never touch $HOME. */
  ensurePinned?: (opts: { node: string; binJs: string }) => string | undefined;
  /** Injectable cache drop (default: {@link invalidateClaudeBinCache}) for the stale-bin re-resolve. */
  invalidateBin?: () => void;
  resumeVerifyWindowMs?: number;
  confirmBeatMs?: number;
  /** Injectable continuity-registry read (default: {@link readRegistry}) — ADR 210. */
  readContinuity?: (dir: string, owner: RegistryOwner) => ContinuityRegistry;
  /** Injectable transcript stat (default: the real filesystem) for the ADR 210 byte/age ladder. */
  statTranscript?: (path: string) => { bytes: number; mtimeMs: number } | undefined;
}

/** Stat a transcript for the exact-match ladder; a missing/unreadable file reads as absent. */
function statTranscriptOnDisk(path: string): { bytes: number; mtimeMs: number } | undefined {
  try {
    const st = statSync(path);
    return { bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * ADR 210's exact-match rung, and the ONLY resume path a `resume_eligible` wake may take.
 *
 * The daemon marked this wake as *worth considering*; proving causality is entirely local. A hit
 * must clear the same byte/age hygiene the ADR 131 ladder applies, because an exact match to a
 * bloated or ancient transcript is still a resume that costs more than a fresh boot. Every failure
 * returns a skip, never a guess — "cannot prove" is answered with fresh, which is always valid.
 */
function exactMatchRung(
  deps: ClaudeCodeDeps,
  spec: WakeSpec,
  transcriptMaxBytes: number,
  now: number,
): { id: string; result: WakeExactMatchResult } | { skip: string; result: WakeExactMatchResult } {
  const threadId = spec.order.thread_id;
  // An eligible order with no thread is a daemon older than the thread_id field: nothing to look
  // up, and nothing that reads as a local miss either.
  if (threadId === undefined)
    return { skip: 'eligible but the order named no thread', result: 'missing' };
  const owner: RegistryOwner = { team: spec.team, seat: spec.order.seat };
  const registry = (deps.readContinuity ?? readRegistry)(spec.workspace, owner);
  const hit = matchBinding(registry, { ...owner, thread_id: threadId, harness: 'claude-code' });
  if (!hit) {
    // `readRegistry` already discards a registry belonging to another team/seat (ADR 143 posture),
    // so a foreign one arrives here as empty and reads `missing`. The mismatch still visible at this
    // point is harness drift: this thread IS bound, but to a session of another harness class.
    const otherHarness = registry.bindings.some((b) => b.thread_id === threadId);
    return otherHarness
      ? { skip: 'this thread is bound to another harness', result: 'mismatched' }
      : { skip: 'no local binding for this thread', result: 'missing' };
  }
  // Everything below is an exact hit that cannot be USED — one bucket (`stale`) on purpose: the
  // distinction that matters to the Eval is bound-vs-not, and splitting unusable four ways would
  // invite tuning the bounds on noise. The precise cause still reaches the operator via the log.
  if (hit.transcript_path === undefined)
    return { skip: 'the local binding names no transcript', result: 'stale' };
  const stat = (deps.statTranscript ?? statTranscriptOnDisk)(hit.transcript_path);
  if (!stat) return { skip: 'the bound transcript is missing', result: 'stale' };
  if (stat.bytes > transcriptMaxBytes)
    return {
      skip: `bound transcript is ${fmtBytes(stat.bytes)} (hygiene bound ${fmtBytes(transcriptMaxBytes)})`,
      result: 'stale',
    };
  if (now - stat.mtimeMs > RESUME_GC_HORIZON_MS)
    return { skip: 'the bound transcript is past the GC horizon', result: 'stale' };
  return { id: hit.session_id, result: 'bound' };
}

/**
 * The exact fresh-spawn argv (exported for the invariant tests). `MUSTERD_PROVENANCE=wake` rides
 * the env (never argv): the MCP adapter already resolves it, so the woken occupancy attests `wake`
 * with zero adapter changes. `--output-format json` is for the *completion log only* (cost/duration
 * telemetry) — never verification.
 */
export function buildWakeArgs(
  composedLine: string,
  sessionId: string,
  opts: WakeArgOpts = {},
): string[] {
  return ['-p', composedLine, '--session-id', sessionId, ...argTail(opts)];
}

/** The exact resume argv (exported for the invariant tests): identical permission posture to the
 *  fresh path — same tool-policy scope, same default permission mode, never a skip flag — only
 *  the session source differs (`--resume <captured id>` instead of `--session-id <minted>`). */
export function buildResumeArgs(
  composedLine: string,
  sessionId: string,
  opts: WakeArgOpts = {},
): string[] {
  return ['--resume', sessionId, '-p', composedLine, ...argTail(opts)];
}

/** SIGTERM the child's process group (detached ⇒ it leads one), escalating to SIGKILL. */
function killTree(child: ChildProcess, graceMs: number): void {
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  signalGroup('SIGTERM');
  const hardKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL');
  }, graceMs);
  hardKill.unref();
}

/** Best-effort cost/duration out of `--output-format json` stdout — telemetry, never verification. */
export function parseRunSummary(
  stdout: string,
): { cost_usd?: number; duration_ms?: number; is_error?: boolean } | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return {
      ...(typeof parsed['total_cost_usd'] === 'number'
        ? { cost_usd: parsed['total_cost_usd'] }
        : {}),
      ...(typeof parsed['duration_ms'] === 'number' ? { duration_ms: parsed['duration_ms'] } : {}),
      ...(typeof parsed['is_error'] === 'boolean' ? { is_error: parsed['is_error'] } : {}),
    };
  } catch {
    return null;
  }
}

/** One spawn attempt (fresh or resume): spawn, watchdog, roster-verify, kill-on-fail. */
interface AttemptResult {
  occupied: boolean;
  provenance?: string | null;
  /** ADR 241: the seat is occupied by a session this wake did not create — a deferral, never a
   *  failure (no attempt budget) and never a success (no delivery claimed). */
  deferred?: boolean;
  /** Host-composed failure summary; null when occupied. */
  reason: string | null;
  /** Resolves when the spawned run finishes (exit or watchdog kill), carrying the run's parsed
   *  cost/duration summary for the supplementary wake report (increment 5). */
  settled: Promise<WakeCompletion | undefined>;
  /** Set when the run had ALREADY settled at verification time (instant crash, fast run) — the
   *  loop merges it into the primary report instead of posting a supplement. */
  completion?: WakeCompletion;
}

interface AttemptOpts {
  label: 'fresh' | 'resumed';
  timeoutMs: number;
  verifyWindowMs?: number;
  confirmBeatMs: number;
}

function runAttempt(
  deps: ClaudeCodeDeps,
  bin: string,
  args: string[],
  spec: WakeSpec,
  ctx: BackendContext,
  opts: AttemptOpts,
): { result: Promise<AttemptResult> } | { spawnFailure: string } {
  const seat = spec.order.seat;
  const spawnedAt = Date.now();
  let child: ChildProcess;
  try {
    child = (deps.spawn ?? nodeSpawn)(bin, args, {
      cwd: spec.workspace,
      // The woken session's musterd hooks call a bare `musterd`, so PATH decides which BUILD runs
      // inside the wake — and the host's PATH is not the operator's (it resolved a frozen Homebrew
      // tarball on the dogfood machine, 147 commits behind). Pin the actuator's own build instead of
      // inheriting the question; best-effort, so an unwritable pin degrades to the inherited PATH.
      env: wakeEnv(
        process.env,
        (deps.ensurePinned ?? ensurePinnedMusterd)({
          node: process.execPath,
          binJs: process.argv[1] ?? '',
        }),
        spec.order.lease_id,
      ),
      detached: true, // its own process group, so the watchdog can kill harness + MCP children
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { spawnFailure: `spawn failed: ${(err as Error).message}`.slice(0, 200) };
  }

  let stdout = '';
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString();
    if (stdout.length > 262_144) stdout = stdout.slice(-262_144);
  });
  let spawnError: Error | null = null;
  const exited = new Promise<number | null>((res) => {
    child.once('exit', (code) => res(code));
    child.once('error', (err) => {
      spawnError = err;
      res(null);
    });
  });

  // The mandatory watchdog (ADR 131 §6): the one bound every backend enforces, per attempt.
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
  }, opts.timeoutMs);
  watchdog.unref();

  const settled: Promise<WakeCompletion | undefined> = exited.then((code) => {
    clearTimeout(watchdog);
    const summary = parseRunSummary(stdout);
    const cost = summary?.cost_usd !== undefined ? ` cost=$${summary.cost_usd.toFixed(4)}` : '';
    ctx.log(
      `run for ${seat} (${opts.label}) settled: exit=${code ?? 'error'}` +
        `${timedOut ? ' (watchdog)' : ''}${cost} wall=${((Date.now() - spawnedAt) / 1000).toFixed(1)}s`,
    );
    // The completion record (increment 5): harness-reported cost + measured wall clock. Cost only
    // exists at exit — the loop posts it as a supplementary report against the settled lease.
    //
    // A run with NO parseable summary still settles WITH a completion (lane 01M1G310Y7). Until
    // 2026-09-02 this returned undefined here, so a watchdog kill, an `exit=error`, or a clean exit
    // that printed no JSON produced no `residency.wake_cost` row at all — 55 of 171 claude-code
    // settles on the live host log, and the watchdog case is the MOST expensive shape a wake can
    // take. The child's cost needs the child's cooperation; the host's wall clock does not.
    return {
      ...(summary?.cost_usd !== undefined ? { cost_usd: summary.cost_usd } : {}),
      duration_ms: summary?.duration_ms ?? Date.now() - spawnedAt,
    };
  });

  const result = (async (): Promise<AttemptResult> => {
    // Verify from the roster, never stdout. The second race arm handles a run that exits before
    // the windowed poller concludes (instant crash, or a wake so fast the session is already
    // gone): give presence a beat, then take one final short read. A won race leaves the loser's
    // windowed poll running to its deadline — harmless presence-neutral reads.
    const verified = await Promise.race([
      ctx.verifyOccupied(seat, opts.verifyWindowMs, spawnedAt),
      exited
        .then(() => new Promise((r) => setTimeout(r, 2_000)))
        .then(() => ctx.verifyOccupied(seat, opts.verifyWindowMs, spawnedAt)),
    ]);

    // ADR 241 increment 3 (2026-09-02, lane 01M1HQC9JJ): the success bar is `lease_matched` — a
    // fresh row attesting THIS lease's token — not `occupied`. This was the last of five backends
    // to gate on occupancy alone, so a presence row belonging to ANOTHER session (a human in the
    // worktree; a prior wake still inside its 30m timeout) was credited as this wake's own: the act
    // reported delivered to a session that never received it, and the child spawned here kept
    // running beside the real occupant. `occupied && !lease_matched` is the contract's deferral
    // (backend.ts): nothing about the act or the host is wrong, so it must not be charged — kill
    // what we spawned and let the act wait for the session that holds the seat.
    // ADR 379: unless the unattested occupant is demonstrably the child spawned here (same
    // workspace, created after spawn) — then it is ours, it just could not attest the lease, and
    // killing it is the self-kill ADR 354 §Consequences named.
    if (verified.occupied && !verified.lease_matched && !verified.own_unattested) {
      killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
      return {
        occupied: false,
        deferred: true,
        reason: `the seat is held by another session (not lease ${spec.order.lease_id})`.slice(
          0,
          200,
        ),
        settled,
      };
    }

    if (verified.occupied) {
      // Confirmation beat (first live fallback rehearsal, 2026-07-13): a stale-id `--resume` died
      // with exit 1 at 2.3s, but its adapter had already blipped a presence row at 2.1s — the
      // roster read credited a dead child as woke and the act went unanswered. A roster hit only
      // counts if the child is still alive (or finished cleanly) a beat later; a legit
      // faster-than-verify run exits 0. Exit-status-as-a-NEGATIVE-signal does not breach the
      // never-verify-from-stdout bar — a nonzero-exited process cannot be a live occupant.
      await new Promise((r) => setTimeout(r, opts.confirmBeatMs));
      if (child.exitCode !== null && child.exitCode !== 0) {
        return {
          occupied: false,
          reason: `run exited (code ${child.exitCode}) moments after the roster read — debris presence, not an occupant`,
          settled,
        };
      }
      const wakeLatencyMs = Date.now() - spawnedAt;
      ctx.log(
        `⚡ woke ${seat}: spawn→roster ${(wakeLatencyMs / 1000).toFixed(1)}s, ` +
          `session=${opts.label} provenance=${verified.provenance ?? 'unknown'}`,
      );
      if (verified.own_unattested) {
        ctx.log(
          `note: ${seat}'s occupancy attests no lease (${spec.order.lease_id}) — credited as this ` +
            `wake's own on its evidence: created in ${spec.workspace} after spawn (ADR 379). ` +
            `The workspace's musterd MCP dist may predate the lease token (rebuild it).`,
        );
      } else if (verified.provenance !== 'wake') {
        ctx.log(
          `note: occupancy attests provenance "${verified.provenance ?? 'none'}", not "wake" — ` +
            `the workspace's musterd MCP dist may predate ADR 131 inc 3 (rebuild it)`,
        );
      }
      return {
        occupied: true,
        provenance: verified.provenance ?? null,
        reason: null,
        settled,
      };
    }

    // Not on the roster: a session that never joined must not keep burning — kill what's left.
    killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
    const reason = spawnError
      ? `spawn failed: ${(spawnError as Error).message}`
      : timedOut
        ? `watchdog timeout (${opts.timeoutMs}ms) before roster occupancy`
        : child.exitCode !== null
          ? `run exited (code ${child.exitCode}) without occupying the seat`
          : 'no roster occupancy within the verify window';
    // Fast-fail merge (increment 5): a run that already EXITED has its summary in hand — carry it
    // on the primary report so no supplement is needed. A watchdogged/live child stays deferred to
    // `settled` (awaiting the kill grace here would delay the report for no gain).
    const completion = child.exitCode !== null || spawnError ? await settled : undefined;
    return {
      occupied: false,
      reason: reason.slice(0, 200),
      settled,
      ...(completion ? { completion } : {}),
    };
  })();

  return { result };
}

/**
 * The resume decision ladder (ADR 131 §5 + design §3, claude-code row). Returns the resumable
 * session id, or the skip reason — every rung degrades to fresh, and only a *skippable* judgement
 * lives here (liveness itself is the loop's guard; a `live` state reaching this backend is a
 * caller bug handled defensively in `wake`).
 */
function resumeLadder(
  liveness: LocalSessionLiveness,
  transcriptMaxBytes: number,
): { id: string; via: 'slot' | 'enumerated' } | { skip: string | null } {
  if (liveness.state === 'none') return { skip: null }; // the pre-capture world — quiet fresh
  const slot = slotRung(liveness, transcriptMaxBytes);
  if ('id' in slot) return { ...slot, via: 'slot' };
  // ADR 166 increment 3 — the resume question, split from the guard. When the slot cannot name a
  // usable resume target but enumeration judged this workspace resumable, resume the enumerated
  // newest session instead of paying for a full-price fresh spawn (the phantom-slot compounding
  // failure in the ADR's Context). Anything short of a confident target still degrades to fresh —
  // the resume question's cheap failure direction.
  const e = liveness.enumerated;
  if (liveness.state === 'resumable' && e?.id !== undefined && e.bytes !== undefined) {
    if (e.bytes > transcriptMaxBytes)
      return {
        skip: `newest transcript is ${fmtBytes(e.bytes)} (hygiene bound ${fmtBytes(transcriptMaxBytes)})`,
      };
    return { id: e.id, via: 'enumerated' };
  }
  return slot;
}

/** The slot capture's rung — the pre-increment-3 checks, unchanged in order and wording. */
function slotRung(
  liveness: LocalSessionLiveness,
  transcriptMaxBytes: number,
): { id: string } | { skip: string } {
  const s = liveness.session;
  if (!s) return { skip: 'no captured session to resume (verdict was enumerated)' };
  if (s.harness !== 'claude-code') return { skip: `captured harness is "${s.harness}"` };
  if (liveness.state === 'gc-expired') return { skip: 'capture past the 30d GC horizon' };
  if (!s.transcript_path || liveness.transcriptBytes === undefined)
    return { skip: 'captured transcript is missing' };
  if (liveness.transcriptBytes > transcriptMaxBytes)
    return {
      skip: `transcript is ${fmtBytes(liveness.transcriptBytes)} (hygiene bound ${fmtBytes(transcriptMaxBytes)})`,
    };
  return { id: s.id };
}

/**
 * A spawn failure that means "the binary is not there" — the stale-cache signature. Narrow on
 * purpose: a permission error or a crashed harness must NOT trigger a re-resolve, because those say
 * the path is right and something else is wrong, and retrying them would double-spend the attempt.
 */
function isMissingBinary(spawnFailure: string): boolean {
  return /\bENOENT\b/.test(spawnFailure);
}

/**
 * Re-resolve `claude` after a spawn proved the cached path stale. Returns the NEW path, or
 * `undefined` when nothing changed — so the caller only retries when retrying can differ.
 */
async function respawnAfterStaleBin(
  deps: ClaudeCodeDeps,
  staleBin: string,
  spawnFailure: string,
): Promise<string | undefined> {
  if (!isMissingBinary(spawnFailure)) return undefined;
  (deps.invalidateBin ?? invalidateClaudeBinCache)();
  const fresh = await (deps.resolveBin ?? resolveClaudeBin)();
  return fresh && fresh !== staleBin ? fresh : undefined;
}

export function claudeCodeBackend(deps: ClaudeCodeDeps = {}): ActuatorBackend {
  return {
    harness: 'claude-code',

    async wake(spec: WakeSpec, ctx: BackendContext): Promise<WakeActuation> {
      const seat = spec.order.seat;
      const bin = await (deps.resolveBin ?? resolveClaudeBin)();
      if (!bin) {
        // DEFERRED, not failed (ADR 221). The act is deliverable and the seat is fine — THIS HOST
        // cannot actuate, which is a property of the machine, not of the work. A failure would
        // consume an attempt against `attempt_cap` and an hourly-cap slot, and three would retire
        // the act as `residency.wake_exhausted`: terminally undeliverable, with the seat reading as
        // if it refused. Same shape and same budget-neutrality as the local-session guard below.
        return {
          outcome: {
            occupied: false,
            deferred: true,
            reason: 'claude CLI not found (PATH + known install locations)',
          },
          settled: Promise.resolve(undefined),
        };
      }

      // Defensive re-check of the loop's local-session guard: this backend must never spawn —
      // fresh OR resume — beside a live local session, regardless of caller. ADR 166 increment 3:
      // the guard question resolves disagreement toward LIVE — if EITHER the enumerated verdict or
      // the demoted slot says a session is live here, refuse. A wrongly-refused wake costs a delay;
      // a wrongly-permitted one costs money and displaces presence (ADR 068).
      const liveness = (deps.readSession ?? localSessionLiveness)(spec.workspace);
      if (liveness.state === 'live' || liveness.slotState === 'live') {
        return {
          outcome: { occupied: false, deferred: true, reason: 'local-session-live' },
          settled: Promise.resolve(undefined),
        };
      }

      const deadline = Date.now() + spec.bounds.timeout_ms;
      // Every attempt's settle is awaited (watchdogs never orphaned); the merged completion sums
      // the attempts' attested spend — a failed resume burned real tokens in the SAME lease, so
      // its cost belongs to the same supplementary record as the fresh fallback's.
      const settledParts: Promise<WakeCompletion | undefined>[] = [];
      const settleAll = (): Promise<WakeCompletion | undefined> =>
        Promise.all(settledParts).then((parts) => {
          const known = parts.filter((p): p is WakeCompletion => p !== undefined);
          if (known.length === 0) return undefined;
          const costs = known.filter((k) => k.cost_usd !== undefined);
          const durations = known.filter((k) => k.duration_ms !== undefined);
          return {
            ...(costs.length > 0 ? { cost_usd: costs.reduce((a, k) => a + k.cost_usd!, 0) } : {}),
            ...(durations.length > 0
              ? { duration_ms: durations.reduce((a, k) => a + k.duration_ms!, 0) }
              : {}),
          };
        });
      // Per-order knobs (increment 5): tool policy + turn cap ride the argv; the transcript bound
      // parameterizes the ladder. `budget_usd` is carried for the report only (no CLI can enforce
      // a dollar cap mid-run) — the loop already logged the clamped watchdog.
      const argOpts: WakeArgOpts = {
        ...(spec.order.tool_policy !== undefined ? { toolPolicy: spec.order.tool_policy } : {}),
        ...(spec.bounds.max_turns !== undefined ? { maxTurns: spec.bounds.max_turns } : {}),
      };
      const deliveryTracked = spec.order.intended_delivery !== undefined;

      // ADR 210: the daemon may mark a wake eligible for an EXACT local thread match. This is
      // checked before the ADR 209 delivery gate on purpose — the daemon sends `intended_delivery:
      // 'fresh'` alongside the mark, because portability is what it can reason about and exactness
      // is what only the host can prove. Not eligible ⇒ the registry is never read at all: the
      // daemon's bit gates the local lookup, never the other way round.
      const bound = spec.order.transcript_max_bytes ?? RESUME_TRANSCRIPT_MAX_BYTES;
      const exactEligible = spec.order.resume_eligible === true;
      const exact = exactEligible
        ? exactMatchRung(deps, spec, bound, Date.now())
        : { skip: null as string | null };

      // `exact_match` rides EVERY outcome this wake can produce, and is deliberately outside the
      // `deliveryTracked` gate: it is the axis ADR 210's Eval splits eligible wakes on, so an
      // eligible wake that ended fresh has to say WHY. Absent ⇒ the wake was never eligible.
      const deliveryMetadata = () => ({
        ...('result' in exact ? { exact_match: exact.result } : {}),
        ...(!deliveryTracked
          ? {}
          : {
              ...(liveness.transcriptBytes !== undefined
                ? { transcript_bytes: liveness.transcriptBytes }
                : {}),
              ...(liveness.transcriptMtime !== undefined
                ? // `mtimeMs` is fractional on APFS, so this difference is a float. The wire schema
                  // now rounds it, but send the integer we mean rather than relying on that: the
                  // boundary's tolerance is a backstop for pinned hosts, not this code's excuse.
                  {
                    transcript_age_ms: Math.round(
                      Math.max(0, Date.now() - liveness.transcriptMtime),
                    ),
                  }
                : {}),
            }),
      });
      // Absent is legacy: mixed daemon/host versions retain the existing resume ladder. An explicit
      // portable/fresh order bypasses every transcript read decision and spawns fresh immediately.
      const wantsResume = spec.order.intended_delivery !== 'fresh';
      let resumeAttempted = false;

      // ── The resume upgrade (increment 4) ──────────────────────────────────────────────────
      const rung = exactEligible
        ? exact
        : wantsResume
          ? resumeLadder(liveness, bound)
          : { skip: null as string | null };
      if (exactEligible && 'skip' in rung) {
        if (rung.skip)
          ctx.log(`exact-match resume skipped for ${seat}: ${rung.skip} — fresh spawn`);
      } else if (!exactEligible && !wantsResume) {
        ctx.log(`portable delivery for ${seat}: fresh spawn (resume bypassed)`);
      } else if ('skip' in rung) {
        if (rung.skip) ctx.log(`resume skipped for ${seat}: ${rung.skip} — fresh spawn`);
      } else {
        resumeAttempted = true;
        if ('via' in rung && rung.via === 'enumerated')
          ctx.log(
            `resume target for ${seat} from enumeration (${rung.id}) — the slot named nothing usable`,
          );
        const attempt = runAttempt(
          deps,
          bin,
          buildResumeArgs(spec.order.composed_line, rung.id, argOpts),
          spec,
          ctx,
          {
            label: 'resumed',
            timeoutMs: spec.bounds.timeout_ms,
            verifyWindowMs: deps.resumeVerifyWindowMs ?? RESUME_VERIFY_WINDOW_MS,
            confirmBeatMs: deps.confirmBeatMs ?? VERIFY_CONFIRM_BEAT_MS,
          },
        );
        if ('result' in attempt) {
          const resumed = await attempt.result;
          settledParts.push(resumed.settled);
          if (resumed.occupied) {
            return {
              outcome: {
                occupied: true,
                session: 'resumed',
                ...(deliveryTracked ? { delivery_outcome: 'resumed' as const } : {}),
                ...deliveryMetadata(),
              },
              settled: settleAll(),
            };
          }
          if (resumed.deferred) {
            // The seat is someone else's. A fresh fallback here would be a second process aimed
            // into a worktree another session is sitting in — the exact duplicate this increment
            // exists to stop. Defer the whole wake; the act waits for the occupant.
            ctx.log(
              `resume deferred for ${seat} (${resumed.reason ?? 'unknown'}) — no fresh fallback`,
            );
            return {
              outcome: {
                occupied: false,
                deferred: true,
                session: 'resumed',
                ...(deliveryTracked ? { delivery_outcome: 'resumed' as const } : {}),
                ...deliveryMetadata(),
                ...(resumed.reason ? { reason: resumed.reason } : {}),
              },
              settled: settleAll(),
            };
          }
          ctx.log(
            `resume failed for ${seat} (${resumed.reason ?? 'unknown'}) — ` +
              `fresh fallback in the same lease`,
          );
        } else {
          ctx.log(`resume failed for ${seat} (${attempt.spawnFailure}) — fresh fallback`);
        }
      }

      // ── Fresh: the complete inc-3 path, with whatever watchdog budget remains ─────────────
      // The floor keeps a fallback viable when resume ate most of the lease, but never inflates a
      // caller's configured bound (a 50ms test timeout must stay 50ms when no resume ran).
      const sessionId = (deps.mintSessionId ?? randomUUID)();
      const remaining = Math.max(deadline - Date.now(), Math.min(10_000, spec.bounds.timeout_ms));
      const fresh = runAttempt(
        deps,
        bin,
        buildWakeArgs(spec.order.composed_line, sessionId, argOpts),
        spec,
        ctx,
        {
          label: 'fresh',
          timeoutMs: remaining,
          confirmBeatMs: deps.confirmBeatMs ?? VERIFY_CONFIRM_BEAT_MS,
        },
      );
      if ('spawnFailure' in fresh) {
        // A resident host caches its `claude` path, and a CLI upgrade that moves the install turns
        // every later wake into ENOENT on a path that no longer exists — 8 of 14 recorded wake
        // failures. A spawn failure is the only honest proof the cached answer went stale, so react
        // to it: re-resolve once and retry, rather than burning this attempt (three exhaust the act).
        const healed = await respawnAfterStaleBin(deps, bin, fresh.spawnFailure);
        if (!healed) {
          return {
            outcome: {
              occupied: false,
              session: 'fresh',
              ...(deliveryTracked
                ? {
                    delivery_outcome: resumeAttempted
                      ? ('fresh_fallback' as const)
                      : ('fresh' as const),
                  }
                : {}),
              ...deliveryMetadata(),
              reason: fresh.spawnFailure,
            },
            settled: settleAll(),
          };
        }
        ctx.log(`claude moved (${bin} → ${healed}) — re-resolved and retrying ${seat}`);
        const retry = runAttempt(
          deps,
          healed,
          buildWakeArgs(spec.order.composed_line, sessionId, argOpts),
          spec,
          ctx,
          {
            label: 'fresh',
            timeoutMs: Math.max(deadline - Date.now(), Math.min(10_000, spec.bounds.timeout_ms)),
            confirmBeatMs: deps.confirmBeatMs ?? VERIFY_CONFIRM_BEAT_MS,
          },
        );
        if ('spawnFailure' in retry) {
          return {
            outcome: {
              occupied: false,
              session: 'fresh',
              ...(deliveryTracked
                ? {
                    delivery_outcome: resumeAttempted
                      ? ('fresh_fallback' as const)
                      : ('fresh' as const),
                  }
                : {}),
              ...deliveryMetadata(),
              reason: retry.spawnFailure,
            },
            settled: settleAll(),
          };
        }
        const healedOutcome = await retry.result;
        settledParts.push(healedOutcome.settled);
        return {
          outcome: {
            occupied: healedOutcome.occupied,
            ...(healedOutcome.deferred ? { deferred: true } : {}),
            session: 'fresh',
            ...(deliveryTracked
              ? {
                  delivery_outcome: resumeAttempted
                    ? ('fresh_fallback' as const)
                    : ('fresh' as const),
                }
              : {}),
            ...deliveryMetadata(),
            ...(healedOutcome.reason ? { reason: healedOutcome.reason } : {}),
          },
          settled: settleAll(),
        };
      }
      const outcome = await fresh.result;
      settledParts.push(outcome.settled);
      return {
        outcome: {
          occupied: outcome.occupied,
          ...(outcome.deferred ? { deferred: true } : {}),
          session: 'fresh',
          ...(deliveryTracked
            ? {
                delivery_outcome: resumeAttempted
                  ? ('fresh_fallback' as const)
                  : ('fresh' as const),
              }
            : {}),
          ...deliveryMetadata(),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          // Fast-fail merge: an already-settled run's summary rides the primary report.
          ...(outcome.completion?.cost_usd !== undefined
            ? { cost_usd: outcome.completion.cost_usd }
            : {}),
          ...(outcome.completion?.duration_ms !== undefined
            ? { duration_ms: outcome.completion.duration_ms }
            : {}),
        },
        settled: settleAll(),
      };
    },
  };
}
