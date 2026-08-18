/**
 * The planner and the swap guard are the two units worth testing: the planner decides what a
 * scheduled run captures (and, more importantly, what it SKIPS — the 4.2 GB of reproducible cookoff
 * clones), and the guard decides whether it runs at all on a machine that lives in swap.
 *
 * The copy/gzip/hash path is deliberately not unit-tested here: it is three stdlib calls in a
 * pipeline, and the property that matters — that a VACUUM INTO of a live WAL database restores —
 * is verified by the restore drill in ADR 280 §3, against the real corpus, not a fixture.
 */
import { describe, expect, it } from 'vitest';
import { defaultSources, launchAgentSources, parseFreeSwapMb, planSnapshot } from './snapshot.ts';

const stat = (sizes: Record<string, number>) => (p: string) =>
  sizes[p] === undefined ? null : { bytes: sizes[p] as number };

describe('parseFreeSwapMb', () => {
  it('reads the free field out of sysctl vm.swapusage', () => {
    expect(
      parseFreeSwapMb(
        'vm.swapusage: total = 5120.00M  used = 4568.44M  free = 551.56M  (encrypted)',
      ),
    ).toBe(551.56);
  });

  it('returns null rather than 0 when the shape is unrecognised', () => {
    // A parse failure that returned 0 would read as "no swap free" and block every run on a machine
    // whose sysctl simply prints something else.
    expect(parseFreeSwapMb('swap: none')).toBeNull();
  });
});

describe('planSnapshot', () => {
  it('captures the cookoff daemon DBs and never the git clones beside them', () => {
    const sources = defaultSources('/home/x').filter((s) => s.id === 'cookoff-daemons');
    const { items } = planSnapshot(
      sources,
      stat({
        '/home/x/cookoff-run/cookoff-d.db': 200_000,
        '/home/x/cookoff-run/cookoff-s2.db': 180_000,
      }),
      // The real lister is `find -maxdepth 1 -name '*.db'`: cells are directories one level down,
      // so a 50 MB clone cannot be reached by it even by accident.
      () => ['/home/x/cookoff-run/cookoff-d.db', '/home/x/cookoff-run/cookoff-s2.db'],
    );
    expect(items.map((i) => i.id)).toEqual([
      'cookoff-daemons/cookoff-d.db',
      'cookoff-daemons/cookoff-s2.db',
    ]);
    expect(items.every((i) => i.kind === 'sqlite')).toBe(true);
    expect(items.reduce((n, i) => n + i.bytes, 0)).toBe(380_000);
  });

  it('treats a missing optional source as normal and a missing required one as fatal', () => {
    const { items, missing } = planSnapshot(
      defaultSources('/home/x'),
      stat({ '/home/x/.musterd/musterd.db': 15_986_688 }),
      () => [],
    );
    // Only the DB exists: the sweep series is required, so its absence is reported.
    expect(items.map((i) => i.id)).toEqual(['musterd.db']);
    expect(missing).toEqual(['/home/x/.musterd/research/adr-166-slot-sweep.jsonl']);
  });

  it('carries the why-string into every planned item so a bare archive is still legible', () => {
    const { items } = planSnapshot(
      defaultSources('/home/x'),
      stat({
        '/home/x/.musterd/musterd.db': 1,
        '/home/x/.musterd/research/adr-166-slot-sweep.jsonl': 1,
      }),
      () => [],
    );
    expect(items.every((i) => i.why.length > 0)).toBe(true);
  });

  it('plans no LaunchAgent when none is installed, without failing the run', () => {
    // The schedule is optional by design: a fresh machine has no plists and is still snapshottable.
    const { items, missing } = planSnapshot(launchAgentSources('/home/x'), stat({}), () => []);
    expect(items).toEqual([]);
    expect(missing).toEqual([]);
  });
});
