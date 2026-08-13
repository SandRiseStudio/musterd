import { describe, expect, it } from 'vitest';
import { collectSignals, parseLaunchctlPrint, type SignalDeps } from './signals.js';

const NOW = 2_000_000;

function deps(over: Partial<SignalDeps> = {}): SignalDeps {
  return {
    now: () => NOW,
    fetchHealth: async () => ({
      ok: true,
      db: '/Users/nick/.musterd/musterd.db',
      schema: 39,
      booted_at: 1_500_000,
    }),
    launchctlPrint: async () => 'state = running\n\truns = 1\n\tlast exit code = 0\n',
    readSince: async () => [],
    statMtime: async () => null,
    expected: { dbPath: '/Users/nick/.musterd/musterd.db', schema: 39 },
    daemonErrLogPath: '/tmp/err.log',
    publisherBuildLogPath: '/tmp/build.log',
    publisherOkStampPath: '/tmp/build.ok',
    lastRefreshAt: async () => null,
    ...over,
  };
}

describe('collectSignals', () => {
  it('maps a healthy daemon: schema and db compared against expectations', async () => {
    const s = await collectSignals(deps());
    expect(s.health).toEqual({
      ok: true,
      bootedAt: 1_500_000,
      schemaOk: true,
      dbPathExpected: true,
    });
    expect(s.launchd).toEqual({ lastExit: 0, runs: 1 });
  });

  it('schema mismatch and unexpected db path surface as flags, not throws', async () => {
    const s = await collectSignals(
      deps({
        fetchHealth: async () => ({ ok: true, db: '/tmp/other.db', schema: 38, booted_at: 1 }),
      }),
    );
    expect(s.health!.schemaOk).toBe(false);
    expect(s.health!.dbPathExpected).toBe(false);
  });

  it('unreachable /health yields health: null, never a thrown tick', async () => {
    const s = await collectSignals(
      deps({
        fetchHealth: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );
    expect(s.health).toBeNull();
  });

  it('err lines are boot-filtered: readSince is called with booted_at, its count is trusted', async () => {
    let calledWith: number | null = null;
    const s = await collectSignals(
      deps({
        readSince: async (_path, epochMs) => {
          calledWith = epochMs;
          return ['line1', 'line2'];
        },
      }),
    );
    expect(calledWith).toBe(1_500_000);
    expect(s.errLinesSinceBoot).toBe(2);
  });

  it('absent booted_at (older daemon) falls back to now minus zero-window: lines count as stale', async () => {
    // Skew tolerance: an older daemon omits booted_at. We cannot boot-filter, so we filter
    // against `now` — zero fresh lines, never a false classification from stale evidence.
    let calledWith: number | null = null;
    const s = await collectSignals(
      deps({
        fetchHealth: async () => ({ ok: true, db: '/Users/nick/.musterd/musterd.db', schema: 39 }),
        readSince: async (_path, epochMs) => {
          calledWith = epochMs;
          return [];
        },
      }),
    );
    expect(calledWith).toBe(NOW);
    expect(s.errLinesSinceBoot).toBe(0);
  });

  it('publisher freshFailure = failure log newer than the last success stamp', async () => {
    const fresh = await collectSignals(
      deps({
        statMtime: async (p) => (p === '/tmp/build.log' ? NOW - 1_000 : NOW - 60_000),
        readSince: async (p) => (p === '/tmp/build.log' ? ['ERROR build failed'] : []),
      }),
    );
    expect(fresh.publisherLog.freshFailure).toBe(true);

    const stale = await collectSignals(
      deps({
        statMtime: async (p) => (p === '/tmp/build.log' ? NOW - 60_000 : NOW - 1_000),
        readSince: async (p) => (p === '/tmp/build.log' ? ['ERROR build failed'] : []),
      }),
    );
    expect(stale.publisherLog.freshFailure).toBe(false);
  });
});

describe('parseLaunchctlPrint', () => {
  it('parses runs and last exit code', () => {
    expect(
      parseLaunchctlPrint('\tstate = running\n\truns = 5\n\tlast exit code = 78\n'),
    ).toEqual({ lastExit: 78, runs: 5 });
  });

  it('absent service (print fails / empty) is zeros, not a throw', () => {
    expect(parseLaunchctlPrint('')).toEqual({ lastExit: 0, runs: 0 });
  });

  it('"(never exited)" reads as exit 0', () => {
    expect(
      parseLaunchctlPrint('runs = 1\nlast exit code = (never exited)\n'),
    ).toEqual({ lastExit: 0, runs: 1 });
  });
});
