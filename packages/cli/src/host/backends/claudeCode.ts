import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveClaudeBin } from '../../claudeBin.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../../session/liveness.js';
import type { ActuatorBackend, BackendContext, WakeActuation, WakeSpec } from '../backend.js';

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
 *  escape are one clause). 10 MiB of transcript JSONL is several compaction cycles deep; past it,
 *  resume spends more re-ingesting history than a fresh seat-primer boot costs. A placeholder
 *  constant — increment 5's metrics re-tune it into a policy knob. */
export const RESUME_TRANSCRIPT_MAX_BYTES = 10 * 1024 * 1024;

/** Injectables so tests never spawn a real harness. */
export interface ClaudeCodeDeps {
  resolveBin?: () => Promise<string | null>;
  spawn?: typeof nodeSpawn;
  mintSessionId?: () => string;
  killGraceMs?: number;
  /** Injectable capture read (default: the shared {@link localSessionLiveness}). */
  readSession?: (workspace: string) => LocalSessionLiveness;
  resumeVerifyWindowMs?: number;
  confirmBeatMs?: number;
}

/**
 * The exact fresh-spawn argv (exported for the invariant tests). `MUSTERD_PROVENANCE=wake` rides
 * the env (never argv): the MCP adapter already resolves it, so the woken occupancy attests `wake`
 * with zero adapter changes. `--output-format json` is for the *completion log only* (cost/duration
 * telemetry) — never verification.
 */
export function buildWakeArgs(composedLine: string, sessionId: string): string[] {
  return [
    '-p',
    composedLine,
    '--session-id',
    sessionId,
    '--allowedTools',
    'mcp__musterd',
    '--output-format',
    'json',
  ];
}

/** The exact resume argv (exported for the invariant tests): identical permission posture to the
 *  fresh path — same allowed-tools scope, same default permission mode, never a skip flag — only
 *  the session source differs (`--resume <captured id>` instead of `--session-id <minted>`). */
export function buildResumeArgs(composedLine: string, sessionId: string): string[] {
  return [
    '--resume',
    sessionId,
    '-p',
    composedLine,
    '--allowedTools',
    'mcp__musterd',
    '--output-format',
    'json',
  ];
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
  /** Host-composed failure summary; null when occupied. */
  reason: string | null;
  /** Resolves when the spawned run finishes (exit or watchdog kill). */
  settled: Promise<void>;
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
      env: { ...process.env, MUSTERD_PROVENANCE: 'wake' },
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

  const settled = exited.then((code) => {
    clearTimeout(watchdog);
    const summary = parseRunSummary(stdout);
    const cost = summary?.cost_usd !== undefined ? ` cost=$${summary.cost_usd.toFixed(4)}` : '';
    ctx.log(
      `run for ${seat} (${opts.label}) settled: exit=${code ?? 'error'}` +
        `${timedOut ? ' (watchdog)' : ''}${cost} wall=${((Date.now() - spawnedAt) / 1000).toFixed(1)}s`,
    );
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
      if (verified.provenance !== 'wake') {
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
    return { occupied: false, reason: reason.slice(0, 200), settled };
  })();

  return { result };
}

/**
 * The resume decision ladder (ADR 131 §5 + design §3, claude-code row). Returns the resumable
 * session id, or the skip reason — every rung degrades to fresh, and only a *skippable* judgement
 * lives here (liveness itself is the loop's guard; a `live` state reaching this backend is a
 * caller bug handled defensively in `wake`).
 */
function resumeLadder(liveness: LocalSessionLiveness): { id: string } | { skip: string | null } {
  if (liveness.state === 'none') return { skip: null }; // the pre-capture world — quiet fresh
  const s = liveness.session!;
  if (s.harness !== 'claude-code') return { skip: `captured harness is "${s.harness}"` };
  if (liveness.state === 'gc-expired') return { skip: 'capture past the 30d GC horizon' };
  if (!s.transcript_path || liveness.transcriptBytes === undefined)
    return { skip: 'captured transcript is missing' };
  if (liveness.transcriptBytes > RESUME_TRANSCRIPT_MAX_BYTES)
    return {
      skip: `transcript is ${(liveness.transcriptBytes / 1_048_576).toFixed(1)} MiB (hygiene bound ${RESUME_TRANSCRIPT_MAX_BYTES / 1_048_576} MiB)`,
    };
  return { id: s.id };
}

export function claudeCodeBackend(deps: ClaudeCodeDeps = {}): ActuatorBackend {
  return {
    harness: 'claude-code',

    async wake(spec: WakeSpec, ctx: BackendContext): Promise<WakeActuation> {
      const seat = spec.order.seat;
      const bin = await (deps.resolveBin ?? resolveClaudeBin)();
      if (!bin) {
        return {
          outcome: {
            occupied: false,
            session: 'fresh',
            reason: 'claude CLI not found (PATH + known install locations)',
          },
          settled: Promise.resolve(),
        };
      }

      // Defensive re-check of the loop's local-session guard: this backend must never spawn —
      // fresh OR resume — beside a live local session, regardless of caller.
      const liveness = (deps.readSession ?? localSessionLiveness)(spec.workspace);
      if (liveness.state === 'live') {
        return {
          outcome: { occupied: false, deferred: true, reason: 'local-session-live' },
          settled: Promise.resolve(),
        };
      }

      const deadline = Date.now() + spec.bounds.timeout_ms;
      const settledParts: Promise<void>[] = [];

      // ── The resume upgrade (increment 4) ──────────────────────────────────────────────────
      const rung = resumeLadder(liveness);
      if ('skip' in rung) {
        if (rung.skip) ctx.log(`resume skipped for ${seat}: ${rung.skip} — fresh spawn`);
      } else {
        const attempt = runAttempt(
          deps,
          bin,
          buildResumeArgs(spec.order.composed_line, rung.id),
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
              outcome: { occupied: true, session: 'resumed' },
              settled: Promise.all(settledParts).then(() => undefined),
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
        buildWakeArgs(spec.order.composed_line, sessionId),
        spec,
        ctx,
        {
          label: 'fresh',
          timeoutMs: remaining,
          confirmBeatMs: deps.confirmBeatMs ?? VERIFY_CONFIRM_BEAT_MS,
        },
      );
      if ('spawnFailure' in fresh) {
        return {
          outcome: { occupied: false, session: 'fresh', reason: fresh.spawnFailure },
          settled: Promise.all(settledParts).then(() => undefined),
        };
      }
      const outcome = await fresh.result;
      settledParts.push(outcome.settled);
      return {
        outcome: {
          occupied: outcome.occupied,
          session: 'fresh',
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        },
        settled: Promise.all(settledParts).then(() => undefined),
      };
    },
  };
}
