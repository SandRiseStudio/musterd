import { z } from 'zod';
import type { Parsed } from '../args.js';
import { flagStr } from '../args.js';
import type { ActuatorBackend } from '../host/backend.js';
import { claudeCodeBackend } from '../host/backends/claudeCode.js';
import { pollHostOnce, type HostPollDeps } from '../host/loop.js';
import { hostRegistryPath, loadHostRegistry } from '../host/registry.js';
import { theme } from '../render/theme.js';

/**
 * `musterd host [--once]` (ADR 131, increment 3) — the wake actuator: the resident, per-machine
 * loop that makes enrolled seats actually wakeable. The `musterd notify` shape: poll the daemon
 * (agent-key, presence-neutral), spawn the harness in the seat's own workspace, verify from the
 * roster, kill on watchdog, report. The daemon decides *who* is due (lanes, cooldowns, caps,
 * leases); this process only ever executes reachability policy — it never decides work (ADR 131
 * §7, the no-orchestrator principle). LaunchAgent management lands with increment 5's service
 * label; until then it runs in a terminal, exactly like `notify`.
 */

const HostOptionsSchema = z.object({
  /** Poll cadence (seconds → ms). The floor keeps a typo from hammering the daemon; the poll is
   *  also the immediate-lane wake-latency floor, so the default leans tight. */
  intervalMs: z.number().int().min(2_000).max(3_600_000).default(10_000),
  /** The mandatory watchdog bound on each wake run (seconds → ms). */
  timeoutMs: z.number().int().min(30_000).max(3_600_000).default(300_000),
  once: z.boolean().default(false),
});

function parseOptions(flags: Record<string, string | boolean>): z.infer<typeof HostOptionsSchema> {
  const secs = (name: string): number | undefined => {
    const raw = flags[name];
    const n = typeof raw === 'string' ? Number(raw) : undefined;
    return n != null && Number.isFinite(n) ? Math.round(n * 1000) : undefined;
  };
  return HostOptionsSchema.parse({
    intervalMs: secs('interval'),
    timeoutMs: secs('timeout'),
    once: flags['once'] === true,
  });
}

export async function hostCommand(
  parsed: Parsed,
  deps: Partial<HostPollDeps> = {},
): Promise<number> {
  const opts = parseOptions(parsed.flags);
  const backends = new Map<string, ActuatorBackend>();
  const claude = claudeCodeBackend();
  backends.set(claude.harness, claude);

  const log = deps.log ?? ((line: string) => process.stdout.write(theme.meta(`  ${line}`) + '\n'));
  const hostLabel = flagStr(parsed.flags, 'host');
  const pollDeps: HostPollDeps = {
    backends,
    bounds: { timeout_ms: opts.timeoutMs },
    log,
    ...(hostLabel !== undefined ? { hostLabel } : {}),
    ...deps,
  };

  const registry = loadHostRegistry();
  if (registry.entries.length === 0) {
    process.stdout.write(
      theme.warn(`no seats in this machine's host registry (${hostRegistryPath()})`) + '\n',
    );
    process.stdout.write(
      theme.meta('  run `musterd residency on` in each seat’s workspace, then start the host') +
        '\n',
    );
    if (opts.once) return 1;
  }

  if (opts.once) {
    const result = await pollHostOnce(pollDeps);
    if (result.orders === 0) process.stdout.write(theme.meta('no wakes due') + '\n');
    // Await in-flight runs so the mandatory watchdog outlives every spawn (never orphaned).
    await Promise.allSettled(result.settled);
    return 0;
  }

  process.stdout.write(`${theme.accent('host')} — wake actuator  ${theme.ok('◉ polling')}\n`);
  process.stdout.write(
    theme.meta(
      `  ${registry.entries.length} seat(s) registered · every ${Math.round(opts.intervalMs / 1000)}s · ` +
        `watchdog ${Math.round(opts.timeoutMs / 1000)}s · Ctrl-C to stop`,
    ) + '\n',
  );
  return new Promise<number>((resolveP) => {
    let timer: NodeJS.Timeout | undefined;
    const inFlight = new Set<Promise<void>>();
    const tick = async () => {
      // Best-effort: a transient daemon/registry failure must not kill the resident loop.
      const result = await pollHostOnce(pollDeps).catch((err: Error) => {
        log(`! poll failed: ${err.message}`);
        return null;
      });
      for (const p of result?.settled ?? []) {
        inFlight.add(p);
        void p.finally(() => inFlight.delete(p));
      }
      // NB: not unref'd — nothing else holds the event loop open (the `notify` lesson).
      timer = setTimeout(tick, opts.intervalMs);
    };
    void tick();
    process.on('SIGINT', () => {
      if (timer) clearTimeout(timer);
      process.stdout.write('\n');
      // In-flight wake runs keep their own watchdogs; report already went out per actuation.
      void Promise.allSettled([...inFlight]).then(() => resolveP(0));
      if (inFlight.size > 0) {
        process.stdout.write(
          theme.meta(`waiting for ${inFlight.size} wake run(s) to settle…`) + '\n',
        );
      }
    });
  });
}
