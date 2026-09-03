import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { WakeLeaseFile, WakeUsage } from '@musterd/protocol';
import { z } from 'zod';
import { resolveCodexBin } from '../../codexBin.js';
import { findBinding, saveBinding } from '../../config.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../../session/liveness.js';
import type {
  ActuatorBackend,
  BackendContext,
  WakeActuation,
  WakeCompletion,
  WakeSpec,
} from '../backend.js';
import { ensurePinnedMusterd, wakeEnv } from '../pinnedBin.js';
import { clearWakeLeaseFile, writeWakeLeaseFile } from '../wakeLeaseFile.js';

const KILL_GRACE_MS = 10_000;
const RESUME_VERIFY_WINDOW_MS = 30_000;

/** Codex's documented fresh form. The workspace flag is intentionally absent from resume: that
 * subcommand does not accept it, so the child `cwd` is the workspace boundary.
 *
 * Carries `--dangerously-bypass-hook-trust` (ADR 359): codex gates `.codex/hooks.json` execution
 * behind "persisted hook trust," normally granted by an interactive first-run prompt a headless
 * wake spawn can never show. musterd authors the hooks.json being trusted — onboarding writes it
 * into every provisioned workspace — so bypassing the confirmation is skipping a step guaranteed
 * to answer yes, not opening a new attack surface. Without it, SessionStart/PostToolUse/SessionEnd
 * never fire and a codex seat's resumable attestation, session capture, and ADR 246 model
 * observation are silently absent. */
export function buildCodexFreshArgs(line: string, workspace: string): string[] {
  return ['exec', '--json', '--dangerously-bypass-hook-trust', '-C', workspace, line];
}

/** Exact captured thread only. Carries the same `--dangerously-bypass-hook-trust` as the fresh
 * form, for the same reason (ADR 359) — resume is a wake path too, and hooks must fire on it
 * identically or every resumed session goes right back to being unattested. */
export function buildCodexResumeArgs(line: string, threadId: string): string[] {
  return ['exec', 'resume', '--json', '--dangerously-bypass-hook-trust', threadId, line];
}

const ThreadStartedSchema = z.object({
  type: z.literal('thread.started'),
  thread_id: z.string().min(1),
});

/** Codex's turn-end record (`codex exec --json`, 0.152.1, captured from a real run 2026-09-02):
 *  `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens",
 *  "cache_write_input_tokens","output_tokens","reasoning_output_tokens"}}`. Token counts only — no
 *  model name, no price (ADR 364). Extra keys tolerated; a missing count is a missing count. */
const TurnCompletedSchema = z.object({
  type: z.literal('turn.completed'),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative().optional(),
    cache_write_input_tokens: z.number().int().nonnegative().optional(),
    reasoning_output_tokens: z.number().int().nonnegative().optional(),
  }),
});

/** External JSONL boundary: the usage a turn-end record carries, or nothing. Never a guess. */
export function parseCodexUsageLine(line: string): WakeUsage | undefined {
  try {
    const result = TurnCompletedSchema.safeParse(JSON.parse(line));
    return result.success ? result.data.usage : undefined;
  } catch {
    return undefined;
  }
}

/** Sum two usage records field by field — a run is one exec, but resume can carry more than one
 *  turn, and the ledger wants the run's total. Optional counts sum only when either side has one. */
export function addUsage(a: WakeUsage | undefined, b: WakeUsage): WakeUsage {
  if (!a) return b;
  const opt = (
    k: 'cached_input_tokens' | 'cache_write_input_tokens' | 'reasoning_output_tokens',
  ) => (a[k] === undefined && b[k] === undefined ? {} : { [k]: (a[k] ?? 0) + (b[k] ?? 0) });
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    ...opt('cached_input_tokens'),
    ...opt('cache_write_input_tokens'),
    ...opt('reasoning_output_tokens'),
  };
}

/** External JSONL boundary: only Codex's typed thread-start record supplies an identity. */
export function parseCodexThreadLine(line: string): string | undefined {
  try {
    const result = ThreadStartedSchema.safeParse(JSON.parse(line));
    return result.success ? result.data.thread_id : undefined;
  } catch {
    return undefined;
  }
}

/** An intentionally small child environment: enough to find Codex and its local account/config,
 * never an ambient agent key, grant, binding override, or smoke/trust control.
 *
 * `MUSTERD_WAKE_LEASE` (ADR 241) rides beside `MUSTERD_PROVENANCE`: the adapter inside the child
 * attests it on claim, and that is what makes the resulting presence row identifiably THIS wake's.
 * It is a daemon-minted opaque lease id — not a session id, transcript path, or token — so it
 * carries nothing ADR 128 keeps off the wire, and it is already on the wire in the wake order. */
export function codexWakeEnv(
  base: NodeJS.ProcessEnv,
  leaseId?: string,
  pinnedDir?: string,
): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (base[key] !== undefined) env[key] = base[key];
  return wakeEnv(env, pinnedDir, leaseId);
}

function killTree(child: ChildProcess, graceMs: number): void {
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };
  kill('SIGTERM');
  const hard = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) kill('SIGKILL');
  }, graceMs);
  hard.unref();
}

export interface CodexDeps {
  resolveBin?: () => Promise<string | null>;
  spawn?: typeof nodeSpawn;
  readSession?: (workspace: string) => LocalSessionLiveness;
  recordFreshThread?: (workspace: string, id: string, startedAt: number) => void;
  /** The wake-lease file channel (ADR 354): written at spawn, cleared at settle. Injectable so the
   *  tests assert the contract without touching a filesystem. */
  writeWakeLease?: (workspace: string, lease: WakeLeaseFile) => void;
  clearWakeLease?: (workspace: string, leaseId: string) => void;
  killGraceMs?: number;
  resumeVerifyWindowMs?: number;
  /** Injectable pinned-shim write; wake PATH must resolve this actuator's CLI before Homebrew. */
  ensurePinned?: (opts: { node: string; binJs: string }) => string | undefined;
}

function recordFreshThread(workspace: string, id: string, startedAt: number): void {
  const binding = findBinding(workspace, {});
  if (!binding) return;
  saveBinding(workspace, { ...binding, session: { harness: 'codex', id, started_at: startedAt } });
}

function capturedId(liveness: LocalSessionLiveness): string | undefined {
  return liveness.state === 'resumable' && liveness.session?.harness === 'codex'
    ? liveness.session.id
    : undefined;
}

interface Attempt {
  occupied: boolean;
  exactCleanWithoutPresence: boolean;
  reason: string;
  /** Resolves when the child finishes (exit, or watchdog kill), carrying the HOST-measured wall
   *  clock for the supplementary wake-cost report. Codex prints no cost the host can attest, so
   *  `cost_usd` is absent — but duration needs no cooperation from the child to exist, and it is
   *  what puts every codex wake on the `residency.wake_cost` rail at all (lane 01M1G310Y7: this was
   *  `Promise<undefined>`, and 130 gptbot spawns had produced 0 cost rows). */
  settled: Promise<WakeCompletion | undefined>;
  /** ADR 238: the seat is held by a session this wake did not create — defer, never charge. */
  deferred?: boolean;
}

async function attempt(
  deps: CodexDeps,
  bin: string,
  args: string[],
  expectedId: string | undefined,
  spec: WakeSpec,
  ctx: BackendContext,
  label: 'fresh' | 'resumed',
  timeoutMs: number,
  pinnedDir: string | undefined,
): Promise<Attempt> {
  const startedAt = Date.now();
  let child: ChildProcess;
  try {
    child = (deps.spawn ?? nodeSpawn)(bin, args, {
      cwd: spec.workspace,
      env: codexWakeEnv(process.env, spec.order.lease_id, pinnedDir),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return {
      occupied: false,
      exactCleanWithoutPresence: false,
      reason: `spawn failed: ${(err as Error).message}`.slice(0, 200),
      settled: Promise.resolve(undefined),
    };
  }
  // ADR 354: Codex does not forward this process's env to the MCP servers it launches, so the lease
  // `codexWakeEnv` put in the child's environment stops at the child. Hand it over on disk as well,
  // naming the child's pid so only a process THAT codex spawned can honour it. Written now, before
  // verification, because the adapter autojoins ~15s in; cleared when the run settles (below).
  if (child.pid !== undefined) {
    (deps.writeWakeLease ?? writeWakeLeaseFile)(spec.workspace, {
      lease_id: spec.order.lease_id,
      provenance: 'wake',
      harness: 'codex',
      spawner_pid: child.pid,
      started_at: startedAt,
      expires_at: startedAt + timeoutMs,
    });
  }
  let threadId: string | undefined;
  let usage: WakeUsage | undefined;
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      threadId ??= parseCodexThreadLine(line);
      const turn = parseCodexUsageLine(line);
      if (turn) usage = addUsage(usage, turn);
    }
  });
  let timedOut = false;
  let spawnError = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
  }, timeoutMs);
  watchdog.unref();
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => {
      spawnError = true;
      resolve(null);
    });
  });
  const settled: Promise<WakeCompletion | undefined> = exited.then((code) => {
    clearTimeout(watchdog);
    // The lease file dies with the run, success or failure — a killed wake must not leave a lease
    // for the next occupant of this workspace to find (ADR 354).
    if (child.pid !== undefined)
      (deps.clearWakeLease ?? clearWakeLeaseFile)(spec.workspace, spec.order.lease_id);
    const duration_ms = Date.now() - startedAt;
    // The same settle line the claude backend writes, so host.log can be measured the same way
    // across harnesses — the absence of one is how this backend's hole stayed invisible.
    ctx.log(
      `run for ${spec.order.seat} (${label}) settled: exit=${code ?? 'error'}` +
        `${timedOut ? ' (watchdog)' : ''} wall=${(duration_ms / 1000).toFixed(1)}s`,
    );
    // ADR 364: the tokens codex printed ride the row; a price does not exist to print. The reason
    // is a property of the harness, so it is stated even on a run that died before turn end.
    return {
      duration_ms,
      ...(usage ? { usage } : {}),
      unpriced_reason: 'harness_prints_no_price',
    };
  });
  const verified = await Promise.race([
    ctx.verifyOccupied(
      spec.order.seat,
      label === 'resumed' ? (deps.resumeVerifyWindowMs ?? RESUME_VERIFY_WINDOW_MS) : undefined,
      startedAt,
    ),
    exited.then(() =>
      ctx.verifyOccupied(
        spec.order.seat,
        label === 'resumed' ? (deps.resumeVerifyWindowMs ?? RESUME_VERIFY_WINDOW_MS) : undefined,
        startedAt,
      ),
    ),
  ]);
  threadId ??= parseCodexThreadLine(buffer);
  const exact = threadId !== undefined && (expectedId === undefined || threadId === expectedId);
  if (label === 'fresh' && threadId)
    (deps.recordFreshThread ?? recordFreshThread)(spec.workspace, threadId, startedAt);
  const processOk =
    !spawnError && child.signalCode === null && (child.exitCode === null || child.exitCode === 0);
  // ADR 241: the success bar is `lease_matched` — a fresh row attesting THIS lease's token. It
  // replaces `provenance === 'wake'`, which was a description every wake session in history
  // satisfies: a prior wake still inside its 30m work-order timeout kept a fresh `wake` row and was
  // credited to this lease instantly, reporting an act as delivered that no session ever received.
  if (verified.occupied && verified.lease_matched && exact && processOk) {
    ctx.log(
      `⚡ woke ${spec.order.seat}: session=${label} lease=${spec.order.lease_id} ` +
        `provenance=${verified.provenance ?? 'none'}`,
    );
    return { occupied: true, exactCleanWithoutPresence: false, reason: '', settled };
  }
  const cleanExact = label === 'resumed' && exact && child.exitCode === 0 && !verified.occupied;
  killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
  // ADR 238: the seat is OCCUPIED, just not by us — another session holds it and verify waited the
  // whole window for our own `wake`-provenance row without seeing one. Nothing about this act went
  // wrong and nothing about the host is broken, so the attempt must not be charged: it defers, on
  // ADR 221/236's discipline (budget-neutral by construction; the awake-time ceiling still bounds
  // it). Distinguished from `!verified.occupied`, which IS a real failure and keeps burning.
  // ADR 241: "not mine" is now decided by the lease token, so a seat held by ANOTHER WAKE's session
  // defers too. Under the old provenance test that case read as `provenance === 'wake'` ⇒ not
  // held-by-other ⇒ a charged failure, which is exactly backwards: the other session is alive and
  // working, and this act should wait for it rather than pay for it.
  const heldByOther = verified.occupied && !verified.lease_matched;
  return {
    occupied: false,
    ...(heldByOther ? { deferred: true } : {}),
    exactCleanWithoutPresence: cleanExact,
    reason: !exact
      ? expectedId
        ? 'thread id missing or mismatched'
        : 'thread id missing'
      : !processOk
        ? `run exited with code ${child.exitCode ?? 'error'}`
        : timedOut
          ? `watchdog timeout (${timeoutMs}ms)`
          : !verified.occupied
            ? 'no roster Presence attesting this wake lease'
            : `the seat is held by another session (provenance ${verified.provenance ?? 'none'}, ` +
              `not lease ${spec.order.lease_id})`,
    settled,
  };
}

export function codexBackend(deps: CodexDeps = {}): ActuatorBackend {
  return {
    harness: 'codex',
    async wake(spec, ctx): Promise<WakeActuation> {
      const bin = await (deps.resolveBin ?? resolveCodexBin)();
      if (!bin)
        // DEFERRED, not failed (ADR 221) — see the claude backend for the full rationale. A host
        // that cannot resolve its harness must not spend the act's attempt budget on a condition
        // local to the machine.
        return {
          outcome: {
            occupied: false,
            deferred: true,
            reason: 'codex CLI not found (PATH + known install locations)',
          },
          settled: Promise.resolve(undefined),
        };
      // This backend is itself the harness authority. Before its first fresh capture there is no
      // `binding.session` to select a scanner, so leaving the harness unspecified would fall back to
      // Claude's scanner and could mistake a live Codex task for an idle workspace.
      const liveness =
        deps.readSession?.(spec.workspace) ??
        localSessionLiveness(spec.workspace, Date.now(), undefined, 'codex');
      // ADR 166 increment 3: the guard question resolves disagreement toward LIVE — if EITHER the
      // enumerated verdict or the demoted slot says a session is live here, refuse. The slot only
      // says live while its own transcript is being written, so a demoted conflict is enumeration
      // failing to see a session, not a stale slot (the 2026-08-21 inspection of all 109 sweep
      // demotions found no other resolvable cause).
      if (liveness.state === 'live' || liveness.slotState === 'live')
        return {
          outcome: { occupied: false, deferred: true, reason: 'local-session-live' },
          settled: Promise.resolve(undefined),
        };
      const pinnedDir = (deps.ensurePinned ?? ensurePinnedMusterd)({
        node: process.execPath,
        binJs: process.argv[1] ?? '',
      });
      const deadline = Date.now() + spec.bounds.timeout_ms;
      // Absent is legacy: mixed daemon/host versions retain the existing resume path. An explicit
      // portable/fresh order bypasses resume and spawns fresh immediately (ADR 209).
      const deliveryTracked = spec.order.intended_delivery !== undefined;
      const wantsResume = spec.order.intended_delivery !== 'fresh';
      const deliveryMetadata = () =>
        !deliveryTracked
          ? {}
          : {
              ...(liveness.transcriptBytes !== undefined
                ? { transcript_bytes: liveness.transcriptBytes }
                : {}),
              ...(liveness.transcriptMtime !== undefined
                ? // Float on APFS — see the sibling note in claudeCode.ts; the schema rounds too.
                  {
                    transcript_age_ms: Math.round(
                      Math.max(0, Date.now() - liveness.transcriptMtime),
                    ),
                  }
                : {}),
            };
      const captured = capturedId(liveness);
      let resumeAttempted = false;
      if (captured && wantsResume) {
        resumeAttempted = true;
        const resumed = await attempt(
          deps,
          bin,
          buildCodexResumeArgs(spec.order.composed_line, captured),
          captured,
          spec,
          ctx,
          'resumed',
          spec.bounds.timeout_ms,
          pinnedDir,
        );
        if (resumed.occupied)
          return {
            outcome: {
              occupied: true,
              session: 'resumed',
              ...(deliveryTracked ? { delivery_outcome: 'resumed' as const } : {}),
              ...deliveryMetadata(),
            },
            settled: resumed.settled,
          };
        if (resumed.exactCleanWithoutPresence)
          return {
            outcome: {
              occupied: false,
              session: 'resumed',
              reason: resumed.reason,
              ...(deliveryTracked ? { delivery_outcome: 'resumed' as const } : {}),
              ...deliveryMetadata(),
            },
            settled: resumed.settled,
          };
        // ADR 238: a seat someone else holds will not be freed by spawning again — take the
        // deferral now rather than spending a second doomed child on the same lease.
        if (resumed.deferred)
          return {
            outcome: {
              occupied: false,
              deferred: true,
              session: 'resumed',
              reason: resumed.reason,
              ...(deliveryTracked ? { delivery_outcome: 'resumed' as const } : {}),
              ...deliveryMetadata(),
            },
            settled: resumed.settled,
          };
        ctx.log(
          `resume failed for ${spec.order.seat} (${resumed.reason}) — fresh fallback in the same lease`,
        );
      } else if (captured && !wantsResume) {
        ctx.log(`portable delivery for ${spec.order.seat}: fresh spawn (resume bypassed)`);
      }
      const fresh = await attempt(
        deps,
        bin,
        buildCodexFreshArgs(spec.order.composed_line, spec.workspace),
        undefined,
        spec,
        ctx,
        'fresh',
        Math.max(1, deadline - Date.now()),
        pinnedDir,
      );
      return {
        outcome: {
          occupied: fresh.occupied,
          ...(fresh.deferred ? { deferred: true } : {}),
          session: 'fresh',
          ...(deliveryTracked
            ? {
                delivery_outcome: resumeAttempted
                  ? ('fresh_fallback' as const)
                  : ('fresh' as const),
              }
            : {}),
          ...deliveryMetadata(),
          ...(fresh.occupied ? {} : { reason: fresh.reason }),
        },
        settled: fresh.settled,
      };
    },
  };
}
