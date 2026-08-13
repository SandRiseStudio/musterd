import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIERS } from '../guardian/classify.js';
import { emptyStamp, loadStamp, saveStamp } from '../guardian/damp.js';
import { guardianStatusLine, guardianTick, type GuardianTickDeps } from './guardian.js';

const NOW = 9_000_000;

function tickDeps(over: Partial<GuardianTickDeps> = {}): {
  d: GuardianTickDeps;
  lines: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-tick-'));
  const lines: string[] = [];
  const d: GuardianTickDeps = {
    now: () => NOW,
    stampPath: join(dir, 'stamp.json'),
    collect: async () => ({
      now: NOW,
      health: { ok: true, bootedAt: NOW - 60_000, schemaOk: true, dbPathExpected: true },
      launchd: { lastExit: 0, runs: 1 },
      publisherLog: { freshFailure: false },
      errLinesSinceBoot: 0,
      httpErrorRateSinceBoot: 0,
      reaperStormSinceBoot: false,
      lastRefreshAt: null,
    }),
    getTiers: async () => DEFAULT_TIERS,
    healthBuild: async () => 'goodsha',
    act: async (incidents, stamp) => {
      lines.push(`acted:${incidents.map((i) => i.class).join(',') || 'none'}`);
      return { stamp, acted: [] };
    },
    heartbeat: async () => {
      lines.push('heartbeat');
    },
    log: (l) => lines.push(l),
    ...over,
  };
  return { d, lines };
}

describe('guardianTick', () => {
  it('healthy tick: records lastTickAt + lastGoodBuild, acts on nothing, never throws', async () => {
    const { d, lines } = tickDeps();
    const code = await guardianTick(d);
    expect(code).toBe(0);
    const stamp = loadStamp(d.stampPath);
    expect(stamp.lastTickAt).toBe(NOW);
    expect(stamp.lastGoodBuild).toBe('goodsha');
    expect(lines.some((l) => l.startsWith('acted:'))).toBe(false); // no incidents → act not called
  });

  it('incident tick: collect → classify → act, in order, stamp persisted from the action report', async () => {
    const { d, lines } = tickDeps({
      collect: async () => ({
        now: NOW,
        health: { ok: true, bootedAt: NOW - 60_000, schemaOk: true, dbPathExpected: true },
        launchd: { lastExit: 0, runs: 1 },
        publisherLog: { freshFailure: true },
        errLinesSinceBoot: 0,
        httpErrorRateSinceBoot: 0,
        reaperStormSinceBoot: false,
        lastRefreshAt: null,
      }),
    });
    expect(await guardianTick(d)).toBe(0);
    expect(lines).toContain('acted:publisher_failed');
  });

  it('an unreachable daemon still ticks: tiers fall back, stamp still records the tick', async () => {
    const { d } = tickDeps({
      collect: async () => ({
        now: NOW,
        health: null,
        launchd: { lastExit: 1, runs: 2 },
        publisherLog: { freshFailure: false },
        errLinesSinceBoot: 0,
        httpErrorRateSinceBoot: 0,
        reaperStormSinceBoot: false,
        lastRefreshAt: null,
      }),
      getTiers: async () => {
        throw new Error('policy unreachable');
      },
    });
    expect(await guardianTick(d)).toBe(0);
    expect(loadStamp(d.stampPath).lastTickAt).toBe(NOW);
  });

  it('daily heartbeat fires once and stamps lastHeartbeatAt', async () => {
    const { d, lines } = tickDeps();
    await guardianTick(d);
    expect(lines).toContain('heartbeat');
    expect(loadStamp(d.stampPath).lastHeartbeatAt).toBe(NOW);
    const again = tickDeps({ stampPath: d.stampPath }); // same stamp, one hour later
    again.d.now = () => NOW + 3_600_000;
    await guardianTick(again.d);
    expect(again.lines).not.toContain('heartbeat');
  });
});

describe('guardianStatusLine (instrument-silence: guardian dead ≠ quiet)', () => {
  it('renders last tick age and incident state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-status-'));
    const p = join(dir, 'stamp.json');
    saveStamp(p, { ...emptyStamp(), lastTickAt: NOW - 40_000 });
    const line = guardianStatusLine(p, NOW);
    expect(line).toContain('last tick 40s ago');
    expect(line).toContain('no incident');
  });

  it('a stale stamp (>10m) is loud, and a missing stamp is "never ticked"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-status-'));
    const p = join(dir, 'stamp.json');
    saveStamp(p, { ...emptyStamp(), lastTickAt: NOW - 11 * 60_000 });
    expect(guardianStatusLine(p, NOW)).toContain('STALE');
    expect(guardianStatusLine(join(dir, 'none.json'), NOW)).toContain('never ticked');
  });
});
