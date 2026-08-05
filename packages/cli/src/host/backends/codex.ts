import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { resolveCodexBin } from '../../codexBin.js';
import { findBinding, saveBinding } from '../../config.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../../session/liveness.js';
import type { ActuatorBackend, BackendContext, WakeActuation, WakeSpec } from '../backend.js';

const KILL_GRACE_MS = 10_000;
const RESUME_VERIFY_WINDOW_MS = 30_000;

/** Codex's documented fresh form. The workspace flag is intentionally absent from resume: that
 * subcommand does not accept it, so the child `cwd` is the workspace boundary. */
export function buildCodexFreshArgs(line: string, workspace: string): string[] {
  return ['exec', '--json', '-C', workspace, line];
}

/** Exact captured thread only; production wake never carries a trust, sandbox, or approval bypass. */
export function buildCodexResumeArgs(line: string, threadId: string): string[] {
  return ['exec', 'resume', '--json', threadId, line];
}

const ThreadStartedSchema = z.object({
  type: z.literal('thread.started'),
  thread_id: z.string().min(1),
});

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
export function codexWakeEnv(base: NodeJS.ProcessEnv, leaseId?: string): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'];
  const env: NodeJS.ProcessEnv = { MUSTERD_PROVENANCE: 'wake' };
  if (leaseId) env['MUSTERD_WAKE_LEASE'] = leaseId;
  for (const key of allowed) if (base[key] !== undefined) env[key] = base[key];
  return env;
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
  killGraceMs?: number;
  resumeVerifyWindowMs?: number;
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
  settled: Promise<undefined>;
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
): Promise<Attempt> {
  const startedAt = Date.now();
  let child: ChildProcess;
  try {
    child = (deps.spawn ?? nodeSpawn)(bin, args, {
      cwd: spec.workspace,
      env: codexWakeEnv(process.env, spec.order.lease_id),
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
  let threadId: string | undefined;
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) threadId ??= parseCodexThreadLine(line);
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
  const settled = exited.then(() => {
    clearTimeout(watchdog);
    return undefined;
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
      if (liveness.state === 'live')
        return {
          outcome: { occupied: false, deferred: true, reason: 'local-session-live' },
          settled: Promise.resolve(undefined),
        };
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
                ? { transcript_age_ms: Math.max(0, Date.now() - liveness.transcriptMtime) }
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
