import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveClaudeBin } from '../../claudeBin.js';
import type { ActuatorBackend, BackendContext, WakeActuation, WakeSpec } from '../backend.js';

/**
 * Backend #1: Claude Code, fresh-first (ADR 131 §5). The durable identity is the SEAT — its
 * worktree, memory, lanes, primer — so a wake never *requires* a captured session: this increment
 * ships fresh-spawn only (`--session-id` pre-minted, so the host knows the id even before the
 * increment-4 capture hooks exist); resume lands in increment 4 as an upgrade, never a dependency.
 *
 * Invariants this file carries (ADR 131 §6):
 * - the prompt is the daemon-composed line, verbatim — no message bodies ever enter a spawn;
 * - reply-only: allowed tools scoped to the musterd MCP server, under the DEFAULT permission mode
 *   — and the wake path never passes a skip-permissions flag (the steward's CI shape does not
 *   transfer to a laptop);
 * - verification is roster-derived via {@link BackendContext.verifyOccupied} — headless stdout is
 *   never a verification source (headless modes hang and lie);
 * - the watchdog timeout is mandatory and kills the whole process group.
 */

/** How long after SIGTERM before the group gets SIGKILL. */
const KILL_GRACE_MS = 10_000;

/** Injectables so tests never spawn a real harness. */
export interface ClaudeCodeDeps {
  resolveBin?: () => Promise<string | null>;
  spawn?: typeof nodeSpawn;
  mintSessionId?: () => string;
  killGraceMs?: number;
}

/**
 * The exact spawn argv (exported for the invariant tests). `MUSTERD_PROVENANCE=wake` rides the env
 * (never argv): the MCP adapter already resolves it, so the woken occupancy attests `wake` with
 * zero adapter changes. `--output-format json` is for the *completion log only* (cost/duration
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

      // Fresh-first: pre-mint the session id so the host knows it even if capture hooks (inc 4)
      // don't exist yet. The id stays host-side — it never travels to the daemon (ADR 131 §5).
      const sessionId = (deps.mintSessionId ?? randomUUID)();
      const spawnedAt = Date.now();
      let child: ChildProcess;
      try {
        child = (deps.spawn ?? nodeSpawn)(bin, buildWakeArgs(spec.order.composed_line, sessionId), {
          cwd: spec.workspace,
          env: { ...process.env, MUSTERD_PROVENANCE: 'wake' },
          detached: true, // its own process group, so the watchdog can kill harness + MCP children
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return {
          outcome: {
            occupied: false,
            session: 'fresh',
            reason: `spawn failed: ${(err as Error).message}`.slice(0, 200),
          },
          settled: Promise.resolve(),
        };
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

      // The mandatory watchdog (ADR 131 §6): the one bound every backend enforces.
      let timedOut = false;
      const watchdog = setTimeout(() => {
        timedOut = true;
        killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
      }, spec.bounds.timeout_ms);
      watchdog.unref();

      const settled = exited.then((code) => {
        clearTimeout(watchdog);
        const summary = parseRunSummary(stdout);
        const cost = summary?.cost_usd !== undefined ? ` cost=$${summary.cost_usd.toFixed(4)}` : '';
        ctx.log(
          `run for ${seat} settled: exit=${code ?? 'error'}${timedOut ? ' (watchdog)' : ''}${cost} ` +
            `wall=${((Date.now() - spawnedAt) / 1000).toFixed(1)}s`,
        );
      });

      // Verify from the roster, never stdout. The second race arm handles a run that exits before
      // the windowed poller concludes (instant crash, or a wake so fast the session is already
      // gone): give presence a beat, then take one final read. A won race leaves the loser's
      // windowed poll running to its deadline — harmless presence-neutral reads, accepted for inc 3.
      const verified = await Promise.race([
        ctx.verifyOccupied(seat),
        exited
          .then(() => new Promise((r) => setTimeout(r, 2_000)))
          .then(() => ctx.verifyOccupied(seat)),
      ]);

      if (verified.occupied) {
        const wakeLatencyMs = Date.now() - spawnedAt;
        ctx.log(
          `⚡ woke ${seat}: spawn→roster ${(wakeLatencyMs / 1000).toFixed(1)}s, ` +
            `session=fresh provenance=${verified.provenance ?? 'unknown'}`,
        );
        if (verified.provenance !== 'wake') {
          ctx.log(
            `note: occupancy attests provenance "${verified.provenance ?? 'none'}", not "wake" — ` +
              `the workspace's musterd MCP dist may predate ADR 131 inc 3 (rebuild it)`,
          );
        }
        return { outcome: { occupied: true, session: 'fresh' }, settled };
      }

      // Not on the roster: a session that never joined must not keep burning — kill what's left.
      killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
      const reason = spawnError
        ? `spawn failed: ${(spawnError as Error).message}`
        : timedOut
          ? `watchdog timeout (${spec.bounds.timeout_ms}ms) before roster occupancy`
          : child.exitCode !== null
            ? `run exited (code ${child.exitCode}) without occupying the seat`
            : 'no roster occupancy within the verify window';
      return {
        outcome: { occupied: false, session: 'fresh', reason: reason.slice(0, 200) },
        settled,
      };
    },
  };
}
