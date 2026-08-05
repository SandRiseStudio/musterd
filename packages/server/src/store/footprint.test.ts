import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { insertFootprintTick, latestFootprint, pruneFootprint } from './footprint.js';

describe('footprint store (seat-footprint design)', () => {
  it('round-trips a tick and returns only the latest one', () => {
    const db = openDb(':memory:');
    insertFootprintTick(
      db,
      [
        {
          ts: 1000,
          classification: 'orphaned',
          seat: null,
          procs: 41,
          rss_kb: 600_000,
          pids: '[1,2]',
        },
      ],
      { ts: 1000, swap_used_mb: 9000, swap_total_mb: 11264, free_mem_mb: 120 },
    );
    insertFootprintTick(
      db,
      [{ ts: 2000, classification: 'live', seat: 'kimi', procs: 3, rss_kb: 90_000, pids: '[7]' }],
      { ts: 2000, swap_used_mb: 8000, swap_total_mb: 11264, free_mem_mb: 300 },
    );
    const latest = latestFootprint(db);
    expect(latest).not.toBeNull();
    expect(latest!.ts).toBe(2000);
    expect(latest!.stacks).toHaveLength(1);
    expect(latest!.stacks[0]).toMatchObject({ classification: 'live', seat: 'kimi', procs: 3 });
    expect(latest!.machine.swap_used_mb).toBe(8000);
  });

  it('a machine-only tick (zero sidecar stacks) is still a tick', () => {
    const db = openDb(':memory:');
    insertFootprintTick(db, [], {
      ts: 5000,
      swap_used_mb: 1000,
      swap_total_mb: 2048,
      free_mem_mb: 1700,
    });
    const latest = latestFootprint(db);
    expect(latest!.ts).toBe(5000);
    expect(latest!.stacks).toEqual([]);
  });

  it('prunes ticks older than the cutoff and reports the machine-row count', () => {
    const db = openDb(':memory:');
    insertFootprintTick(
      db,
      [{ ts: 1000, classification: 'live', seat: null, procs: 1, rss_kb: 1, pids: '[]' }],
      { ts: 1000, swap_used_mb: null, swap_total_mb: null, free_mem_mb: null },
    );
    insertFootprintTick(db, [], {
      ts: 2000,
      swap_used_mb: null,
      swap_total_mb: null,
      free_mem_mb: null,
    });
    expect(pruneFootprint(db, 1500)).toBe(1);
    const latest = latestFootprint(db);
    expect(latest!.ts).toBe(2000);
    // The pruned tick's stack rows go with it.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM footprint_stacks').get() as { n: number },
    ).toMatchObject({ n: 0 });
  });

  it('an empty table reads as null, not a fabricated tick', () => {
    const db = openDb(':memory:');
    expect(latestFootprint(db)).toBeNull();
  });
});
