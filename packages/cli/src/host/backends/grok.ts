import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { findBinding, saveBinding } from '../../config.js';
import { resolveGrokBin } from '../../grokBin.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../../session/liveness.js';
import type { ActuatorBackend, WakeActuation } from '../backend.js';
import { ensurePinnedMusterd, wakeEnv } from '../pinnedBin.js';

const KILL_GRACE_MS = 10_000;
const RESUME_VERIFY_WINDOW_MS = 30_000;

export function buildGrokFreshArgs(line: string, workspace: string): string[] {
  return ['-p', line, '--cwd', workspace];
}

export function buildGrokResumeArgs(line: string, sessionId: string, workspace: string): string[] {
  return ['-p', line, '-r', sessionId, '--cwd', workspace];
}

export function grokWakeEnv(
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
    'GROK_HOME',
    'MUSTERD_MODEL',
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

export interface GrokDeps {
  resolveBin?: () => Promise<string | null>;
  spawn?: typeof nodeSpawn;
  readSession?: (workspace: string) => LocalSessionLiveness;
  recordFreshSession?: (workspace: string, id: string, startedAt: number) => void;
  killGraceMs?: number;
  resumeVerifyWindowMs?: number;
  ensurePinned?: (opts: { node: string; binJs: string }) => string | undefined;
}

function recordFreshSession(workspace: string, id: string, startedAt: number): void {
  const binding = findBinding(workspace, {});
  if (!binding) return;
  saveBinding(workspace, {
    ...binding,
    session: { harness: 'grok', id, started_at: startedAt },
  });
}

function capturedId(liveness: LocalSessionLiveness): string | undefined {
  return liveness.state === 'resumable' && liveness.session?.harness === 'grok'
    ? liveness.session.id
    : undefined;
}

export function grokBackend(deps: GrokDeps = {}): ActuatorBackend {
  return {
    harness: 'grok',
    async wake(spec, ctx): Promise<WakeActuation> {
      const bin = await (deps.resolveBin ?? resolveGrokBin)();
      if (!bin)
        return {
          outcome: {
            occupied: false,
            deferred: true,
            reason: 'grok CLI not found (PATH + known install locations)',
          },
          settled: Promise.resolve(undefined),
        };
      const liveness =
        deps.readSession?.(spec.workspace) ??
        localSessionLiveness(spec.workspace, Date.now(), undefined, 'grok');
      if (liveness.state === 'live' || liveness.slotState === 'live')
        return {
          outcome: { occupied: false, deferred: true, reason: 'local-session-live' },
          settled: Promise.resolve(undefined),
        };
      const pinnedDir = (deps.ensurePinned ?? ensurePinnedMusterd)({
        node: process.execPath,
        binJs: process.argv[1] ?? '',
      });
      const spawn = deps.spawn ?? nodeSpawn;
      const run = async (
        args: string[],
        label: 'fresh' | 'resumed',
        timeoutMs: number,
      ): Promise<{
        occupied: boolean;
        deferred?: boolean;
        reason: string;
        settled: Promise<undefined>;
      }> => {
        const startedAt = Date.now();
        let child: ChildProcess;
        try {
          child = spawn(bin, args, {
            cwd: spec.workspace,
            env: grokWakeEnv(process.env, spec.order.lease_id, pinnedDir),
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore'],
          });
        } catch (err) {
          return {
            occupied: false,
            reason: `spawn failed: ${(err as Error).message}`.slice(0, 200),
            settled: Promise.resolve(undefined),
          };
        }
        const watchdog = setTimeout(
          () => killTree(child, deps.killGraceMs ?? KILL_GRACE_MS),
          timeoutMs,
        );
        watchdog.unref();
        const settled = new Promise<undefined>((resolve) => {
          child.once('exit', () => {
            clearTimeout(watchdog);
            resolve(undefined);
          });
          child.once('error', () => {
            clearTimeout(watchdog);
            resolve(undefined);
          });
        });
        const verified = await ctx.verifyOccupied(
          spec.order.seat,
          label === 'resumed' ? (deps.resumeVerifyWindowMs ?? RESUME_VERIFY_WINDOW_MS) : undefined,
          startedAt,
        );
        if (verified.occupied && verified.lease_matched) {
          ctx.log(
            `⚡ woke ${spec.order.seat}: session=${label} lease=${spec.order.lease_id} ` +
              `provenance=${verified.provenance ?? 'none'}`,
          );
          if (label === 'fresh')
            (deps.recordFreshSession ?? recordFreshSession)(
              spec.workspace,
              `wake-${spec.order.lease_id}`,
              startedAt,
            );
          return { occupied: true, reason: '', settled };
        }
        killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
        const heldByOther = verified.occupied && !verified.lease_matched;
        return {
          occupied: false,
          ...(heldByOther ? { deferred: true } : {}),
          reason: heldByOther
            ? `the seat is held by another session (provenance ${verified.provenance ?? 'none'})`
            : 'no roster Presence attesting this wake lease',
          settled,
        };
      };

      const captured = capturedId(liveness);
      const wantsResume = spec.order.intended_delivery !== 'fresh';
      if (captured && wantsResume) {
        const resumed = await run(
          buildGrokResumeArgs(spec.order.composed_line, captured, spec.workspace),
          'resumed',
          spec.bounds.timeout_ms,
        );
        if (resumed.occupied)
          return { outcome: { occupied: true, session: 'resumed' }, settled: resumed.settled };
        if (resumed.deferred)
          return {
            outcome: {
              occupied: false,
              deferred: true,
              session: 'resumed',
              reason: resumed.reason,
            },
            settled: resumed.settled,
          };
        ctx.log(
          `resume failed for ${spec.order.seat} (${resumed.reason}) — fresh fallback in the same lease`,
        );
      }
      const fresh = await run(
        buildGrokFreshArgs(spec.order.composed_line, spec.workspace),
        'fresh',
        spec.bounds.timeout_ms,
      );
      return {
        outcome: {
          occupied: fresh.occupied,
          ...(fresh.deferred ? { deferred: true } : {}),
          session: 'fresh',
          ...(fresh.occupied ? {} : { reason: fresh.reason }),
        },
        settled: fresh.settled,
      };
    },
  };
}
