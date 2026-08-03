import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { findBinding, saveBinding } from '../../config.js';
import { resolveCodexBin } from '../../codexBin.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../../session/liveness.js';
import type { ActuatorBackend, BackendContext, WakeActuation, WakeSpec } from '../backend.js';
import { z } from 'zod';

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
 * never an ambient agent key, grant, binding override, or smoke/trust control. */
export function codexWakeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'];
  const env: NodeJS.ProcessEnv = { MUSTERD_PROVENANCE: 'wake' };
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
      env: codexWakeEnv(process.env),
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
  const watchdog = setTimeout(() => {
    timedOut = true;
    killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
  }, timeoutMs);
  watchdog.unref();
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
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
  if (verified.occupied && verified.provenance === 'wake' && exact && child.exitCode !== 1) {
    ctx.log(`⚡ woke ${spec.order.seat}: session=${label} provenance=wake`);
    return { occupied: true, exactCleanWithoutPresence: false, reason: '', settled };
  }
  const cleanExact = label === 'resumed' && exact && child.exitCode === 0 && !verified.occupied;
  killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
  return {
    occupied: false,
    exactCleanWithoutPresence: cleanExact,
    reason: !exact
      ? expectedId
        ? 'thread id missing or mismatched'
        : 'thread id missing'
      : timedOut
        ? `watchdog timeout (${timeoutMs}ms)`
        : !verified.occupied
          ? 'no wake-provenance roster Presence'
          : `roster provenance ${verified.provenance ?? 'none'} is not wake`,
    settled,
  };
}

export function codexBackend(deps: CodexDeps = {}): ActuatorBackend {
  return {
    harness: 'codex',
    async wake(spec, ctx): Promise<WakeActuation> {
      const bin = await (deps.resolveBin ?? resolveCodexBin)();
      if (!bin)
        return {
          outcome: {
            occupied: false,
            reason: 'codex CLI not found (PATH + known install locations)',
          },
          settled: Promise.resolve(undefined),
        };
      const liveness = (deps.readSession ?? localSessionLiveness)(spec.workspace);
      if (liveness.state === 'live')
        return {
          outcome: { occupied: false, deferred: true, reason: 'local-session-live' },
          settled: Promise.resolve(undefined),
        };
      const deadline = Date.now() + spec.bounds.timeout_ms;
      const captured = capturedId(liveness);
      if (captured) {
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
          return { outcome: { occupied: true, session: 'resumed' }, settled: resumed.settled };
        if (resumed.exactCleanWithoutPresence)
          return {
            outcome: { occupied: false, session: 'resumed', reason: resumed.reason },
            settled: resumed.settled,
          };
        ctx.log(
          `resume failed for ${spec.order.seat} (${resumed.reason}) — fresh fallback in the same lease`,
        );
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
          session: 'fresh',
          ...(fresh.occupied ? {} : { reason: fresh.reason }),
        },
        settled: fresh.settled,
      };
    },
  };
}
