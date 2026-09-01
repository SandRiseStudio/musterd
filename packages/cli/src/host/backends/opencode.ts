import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { findBinding, saveBinding } from '../../config.js';
import { resolveOpencodeBin } from '../../opencodeBin.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../../session/liveness.js';
import type { ActuatorBackend, BackendContext, WakeActuation, WakeSpec } from '../backend.js';
import { ensurePinnedMusterd, wakeEnv } from '../pinnedBin.js';

const KILL_GRACE_MS = 10_000;
const RESUME_VERIFY_WINDOW_MS = 30_000;

/** OpenCode's documented non-interactive form (run.ts upstream): one prompt, JSON event stream,
 *  exits when the session goes idle. No `--dir`: the child `cwd` is the workspace boundary. The
 *  default permission posture is kept deliberately — non-interactive run auto-rejects permission
 *  asks rather than hanging on them, and production wake never carries a bypass flag. */
export function buildOpencodeFreshArgs(line: string): string[] {
  return ['run', '--format', 'json', line];
}

/** Exact captured session only; opencode exits(1) up front when the id does not exist. */
export function buildOpencodeResumeArgs(line: string, sessionId: string): string[] {
  return ['run', '--format', 'json', '--session', sessionId, line];
}

/** Every `--format json` event line carries the acting session's id at top level (upstream
 *  run.ts `emit()`): `{ type, timestamp, sessionID, … }`. Only that shape is identity evidence —
 *  the payload parts are never parsed. */
export const OpencodeEventSchema = z.object({
  type: z.string().min(1),
  sessionID: z.string().min(1),
});

/** External JSONL boundary: only a typed event record supplies an identity. */
export function parseOpencodeSessionLine(line: string): string | undefined {
  try {
    const result = OpencodeEventSchema.safeParse(JSON.parse(line));
    return result.success ? result.data.sessionID : undefined;
  } catch {
    return undefined;
  }
}

/** An intentionally small child environment: enough to find opencode and its local auth/config,
 *  never an ambient agent key, grant, binding override, or smoke/trust control.
 *
 *  `MUSTERD_WAKE_LEASE` (ADR 241) rides beside `MUSTERD_PROVENANCE` exactly as in every sibling
 *  backend: the adapter inside the child attests it on claim, and that is what makes the resulting
 *  presence row identifiably THIS wake's. */
export function opencodeWakeEnv(
  base: NodeJS.ProcessEnv,
  leaseId?: string,
  pinnedDir?: string,
): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'PATH',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'MUSTERD_MODEL',
    'ANTHROPIC_MODEL',
  ];
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

export interface OpencodeDeps {
  resolveBin?: () => Promise<string | null>;
  spawn?: typeof nodeSpawn;
  readSession?: (workspace: string) => LocalSessionLiveness;
  recordFreshSession?: (workspace: string, id: string, startedAt: number) => void;
  killGraceMs?: number;
  resumeVerifyWindowMs?: number;
  /** Injectable pinned-shim write; wake PATH must resolve this actuator's CLI before Homebrew. */
  ensurePinned?: (opts: { node: string; binJs: string }) => string | undefined;
}

function recordFreshSession(workspace: string, id: string, startedAt: number): void {
  const binding = findBinding(workspace, {});
  if (!binding) return;
  saveBinding(workspace, {
    ...binding,
    session: { harness: 'opencode', id, started_at: startedAt },
  });
}

function capturedId(liveness: LocalSessionLiveness): string | undefined {
  return liveness.state === 'resumable' && liveness.session?.harness === 'opencode'
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
  deps: OpencodeDeps,
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
      env: opencodeWakeEnv(process.env, spec.order.lease_id, pinnedDir),
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
  let sessionId: string | undefined;
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) sessionId ??= parseOpencodeSessionLine(line);
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
  sessionId ??= parseOpencodeSessionLine(buffer);
  const exact = sessionId !== undefined && (expectedId === undefined || sessionId === expectedId);
  if (label === 'fresh' && sessionId)
    (deps.recordFreshSession ?? recordFreshSession)(spec.workspace, sessionId, startedAt);
  const processOk =
    !spawnError && child.signalCode === null && (child.exitCode === null || child.exitCode === 0);
  // ADR 241: the success bar is `lease_matched` — a fresh row attesting THIS lease's token.
  // Shared mechanics with every sibling backend; nothing here is opencode-specific.
  if (verified.occupied && verified.lease_matched && exact && processOk) {
    ctx.log(
      `⚡ woke ${spec.order.seat}: session=${label} lease=${spec.order.lease_id} ` +
        `provenance=${verified.provenance ?? 'none'}`,
    );
    return { occupied: true, exactCleanWithoutPresence: false, reason: '', settled };
  }
  const cleanExact = label === 'resumed' && exact && child.exitCode === 0 && !verified.occupied;
  killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
  // ADR 238/241 deferral taxonomy, identical to the codex backend: held-by-other defers
  // (budget-neutral), everything else is a charged failure with its reason named.
  const heldByOther = verified.occupied && !verified.lease_matched;
  return {
    occupied: false,
    ...(heldByOther ? { deferred: true } : {}),
    exactCleanWithoutPresence: cleanExact,
    reason: !exact
      ? expectedId
        ? 'session id missing or mismatched'
        : 'session id missing'
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

export function opencodeBackend(deps: OpencodeDeps = {}): ActuatorBackend {
  return {
    harness: 'opencode',
    async wake(spec, ctx): Promise<WakeActuation> {
      const bin = await (deps.resolveBin ?? resolveOpencodeBin)();
      if (!bin)
        // DEFERRED, not failed (ADR 221) — a host that cannot resolve its harness must not spend
        // the act's attempt budget on a condition local to this machine.
        return {
          outcome: {
            occupied: false,
            deferred: true,
            reason: 'opencode CLI not found (PATH + known install locations)',
          },
          settled: Promise.resolve(undefined),
        };
      // This backend is itself the harness authority (same rationale as codex.ts): before its
      // first fresh capture there is no `binding.session` to select a scanner, and an unspecified
      // harness would fall back to Claude's scanner and could mistake a live task for an idle
      // workspace — or vice versa.
      const liveness =
        deps.readSession?.(spec.workspace) ??
        localSessionLiveness(spec.workspace, Date.now(), undefined, 'opencode');
      // ADR 166 increment 3: disagreement resolves toward LIVE — refuse to spawn.
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
            };
      const captured = capturedId(liveness);
      let resumeAttempted = false;
      if (captured && wantsResume) {
        resumeAttempted = true;
        const resumed = await attempt(
          deps,
          bin,
          buildOpencodeResumeArgs(spec.order.composed_line, captured),
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
        // ADR 238: a seat someone else holds will not be freed by spawning again.
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
        buildOpencodeFreshArgs(spec.order.composed_line),
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
