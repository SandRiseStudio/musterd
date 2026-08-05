import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig, type ResolvedConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { insertFootprintTick, latestFootprint } from '../store/footprint.js';
import { Hub } from '../transport/hub.js';
import { startFootprintSampler } from './sampler.js';

/**
 * The sampler is a `setInterval` tick like the presence reaper: drive it with
 * fake timers and injected scanners — tests never exec a real `ps`.
 */
describe('startFootprintSampler', () => {
  let db: Database;
  let config: ResolvedConfig;
  let ctx: Ctx;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    db = openDb(':memory:');
    config = resolveConfig();
    ctx = { db, hub: new Hub(), config, rosterRoots: [] };
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    db.close();
  });

  it('a tick persists classified stacks and the machine row', () => {
    stop = startFootprintSampler(ctx, {
      scanProcs: () => [
        { pid: 10, ppid: 1, rssKb: 1000, command: '/Users/n/.local/bin/claude' },
        { pid: 11, ppid: 10, rssKb: 5000, command: 'npm exec chrome-devtools-mcp@1.6.0' },
        { pid: 20, ppid: 1, rssKb: 2000, command: 'npm exec mcp-remote https://x/mcp' },
      ],
      scanMachine: () => ({ swapUsedMb: 9000, swapTotalMb: 11264, freeMemMb: 100 }),
    });
    vi.advanceTimersByTime(ctx.config.footprintIntervalMs + 1);

    const latest = latestFootprint(db);
    expect(latest).not.toBeNull();
    expect(latest!.machine.swap_used_mb).toBe(9000);
    const byClass = Object.fromEntries(latest!.stacks.map((s) => [s.classification, s]));
    expect(byClass['live']).toMatchObject({ procs: 1, rss_kb: 5000, seat: null });
    expect(byClass['orphaned']).toMatchObject({ procs: 1, rss_kb: 2000 });
  });

  it('prunes ticks older than the retention window', () => {
    // A tick from beyond retention, seeded directly.
    insertFootprintTick(db, [], {
      ts: Date.now() - ctx.config.footprintRetentionMs - 60_000,
      swap_used_mb: 1,
      swap_total_mb: 1,
      free_mem_mb: 1,
    });
    stop = startFootprintSampler(ctx, {
      scanProcs: () => [],
      scanMachine: () => ({ swapUsedMb: null, swapTotalMb: null, freeMemMb: null }),
    });
    vi.advanceTimersByTime(ctx.config.footprintIntervalMs + 1);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM footprint_machine').get() as { n: number };
    expect(rows.n).toBe(1); // only the fresh tick survives
  });

  it('a scanner throw skips the tick and never escapes the timer', () => {
    stop = startFootprintSampler(ctx, {
      scanProcs: () => {
        throw new Error('no ps on this platform');
      },
      scanMachine: () => ({ swapUsedMb: null, swapTotalMb: null, freeMemMb: null }),
    });
    expect(() => vi.advanceTimersByTime(ctx.config.footprintIntervalMs + 1)).not.toThrow();
    expect(latestFootprint(db)).toBeNull();
  });
});
