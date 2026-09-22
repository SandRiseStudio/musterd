import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import { DEFAULT_TIERS } from '../guardian/classify.js';
import { emptyStamp, loadStamp, saveStamp } from '../guardian/damp.js';
import {
  classifyPolicyError,
  guardianStatusLine,
  guardianTick,
  type GuardianTickDeps,
} from './guardian.js';

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
    getTiers: async () => ({ tiers: DEFAULT_TIERS, source: 'shipped_default_unprovisioned' }),
    healthBuild: async () => 'goodsha',
    act: async (incidents, stamp) => {
      lines.push(`acted:${incidents.map((i) => i.class).join(',') || 'none'}`);
      return { stamp, acted: [] };
    },
    discharge: async (firing, stamp) => {
      lines.push(`discharged:${[...firing].join(',') || 'none'}`);
      return stamp;
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

  it('records a successful scoped policy read and clears a prior degradation', async () => {
    const { d } = tickDeps({
      getTiers: (async () => ({ tiers: DEFAULT_TIERS, source: 'team_policy' })) as never,
    });
    saveStamp(d.stampPath, {
      ...emptyStamp(),
      policySource: 'shipped_default_degraded',
      lastPolicyErrorAt: NOW - 60_000,
    });

    await guardianTick(d);

    const stamp = loadStamp(d.stampPath);
    expect(stamp.policySource).toBe('team_policy');
    expect(stamp.lastPolicyReadAt).toBe(NOW);
    expect(stamp.lastPolicyErrorAt).toBeNull();
  });

  /**
   * Lane 01M2NZDXPD. The falsifier the lane names: make the read fail for two genuinely different
   * reasons and read the log. Before the fix both ticks produced the same bytes.
   */
  it('a failed policy read names its cause — two different failures are two different lines', async () => {
    const seen: string[] = [];
    for (const thrown of [
      new CliError('unauthorized: seat token is not provisioned', 4, 'unauthorized'),
      new CliError("can't reach team server at http://127.0.0.1:4849 — is the daemon running?", 7),
    ]) {
      const { d, lines } = tickDeps({
        getTiers: async () => {
          throw thrown;
        },
      });
      await guardianTick(d);
      const line = lines.find((l) => l.startsWith('guardian.policy_unreadable'));
      expect(line).toBeDefined();
      seen.push(line!);
    }
    expect(seen[0]).toContain('"reason":"unauthorized"');
    expect(seen[1]).toContain('"reason":"unreachable"');
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('the stamp carries the bound cause, and a degrade run is dated from its FIRST tick', async () => {
    const { d } = tickDeps({
      getTiers: async () => {
        throw new CliError('bad guardian_tiers', 3, 'validation');
      },
    });
    saveStamp(d.stampPath, {
      ...emptyStamp(),
      policySource: 'shipped_default_degraded',
      policyDegradedSince: NOW - 300_000,
      lastPolicyErrorAt: NOW - 120_000,
    });

    await guardianTick(d);

    const stamp = loadStamp(d.stampPath);
    expect(stamp.lastPolicyError?.reason).toBe('malformed');
    expect(stamp.lastPolicyError?.detail).toContain('bad guardian_tiers');
    // The run started five minutes ago; this tick is a continuation, not a new degradation.
    expect(stamp.policyDegradedSince).toBe(NOW - 300_000);
    expect(stamp.lastPolicyErrorAt).toBe(NOW);
  });

  it('a successful read clears the degrade run, not just its timestamp', async () => {
    const { d } = tickDeps({
      getTiers: async () => ({ tiers: DEFAULT_TIERS, source: 'team_policy' }),
    });
    saveStamp(d.stampPath, {
      ...emptyStamp(),
      policySource: 'shipped_default_degraded',
      policyDegradedSince: NOW - 300_000,
      lastPolicyError: { reason: 'unreachable', detail: 'gone', at: NOW - 120_000 },
    });

    await guardianTick(d);

    const stamp = loadStamp(d.stampPath);
    expect(stamp.policyDegradedSince).toBeNull();
    expect(stamp.lastPolicyError).toBeNull();
  });

  it('an unset team policy is a successful read, not a degradation', async () => {
    const { d, lines } = tickDeps({
      getTiers: async () => ({ tiers: DEFAULT_TIERS, source: 'team_policy_unset' }),
    });
    await guardianTick(d);
    const stamp = loadStamp(d.stampPath);
    expect(stamp.policySource).toBe('team_policy_unset');
    expect(stamp.lastPolicyReadAt).toBe(NOW);
    expect(stamp.lastPolicyErrorAt).toBeNull();
    expect(lines.some((l) => l.startsWith('guardian.policy_unreadable'))).toBe(false);
  });

  it('defers a confirmed outage during a current refresh handover', async () => {
    const { d, lines } = tickDeps({
      collect: async () => ({
        now: NOW,
        health: null,
        handover: { startedAt: NOW - 1_000, targetBuild: 'nextsha' },
        launchd: { lastExit: 1, runs: 2 },
        publisherLog: { freshFailure: false },
        errLinesSinceBoot: 0,
        httpErrorRateSinceBoot: 0,
        reaperStormSinceBoot: false,
        lastRefreshAt: null,
      }),
    });
    await guardianTick(d);
    expect(lines).toContain('guardian.handover_deferred');
    expect(lines.some((line) => line.startsWith('acted:'))).toBe(false);
  });

  /**
   * Cross-tick outage confirmation (ADR 274 amendment): a clean-exit unreachable /health defers on
   * its first sighting — the 2026-08-24 77 s stall outlasted every single-tick bound — and raises
   * only when the NEXT tick still cannot reach it. A stall that recovers leaves a measured span in
   * the log instead of a page.
   */
  const unreachableCleanExit =
    (over: Record<string, unknown> = {}) =>
    async () => ({
      now: NOW,
      health: null,
      healthProbe: {
        attempts: 3,
        lastError: 'The operation was aborted due to timeout',
        confirmMs: 10_000,
        confirmError: 'The operation was aborted due to timeout',
      },
      launchd: { lastExit: 0, runs: 15 },
      publisherLog: { freshFailure: false },
      errLinesSinceBoot: 0,
      httpErrorRateSinceBoot: 0,
      reaperStormSinceBoot: false,
      lastRefreshAt: null,
      ...over,
    });

  it('first clean-exit unreachable tick defers: no act, pendingDownSince stamped', async () => {
    const { d, lines } = tickDeps({ collect: unreachableCleanExit() });
    await guardianTick(d);
    expect(lines.some((l) => l.startsWith('guardian.down_deferred'))).toBe(true);
    expect(lines.some((l) => l.startsWith('acted:'))).toBe(false);
    expect(loadStamp(d.stampPath).pendingDownSince).toBe(NOW);
  });

  it('second unreachable tick raises daemon_down, evidence carrying the persistence', async () => {
    const { d, lines } = tickDeps({ collect: unreachableCleanExit() });
    saveStamp(d.stampPath, { ...emptyStamp(), pendingDownSince: NOW - 120_000 });
    await guardianTick(d);
    expect(lines).toContain('acted:daemon_down');
  });

  it('a healthy tick after a pending down logs the measured stall and clears it', async () => {
    const { d, lines } = tickDeps();
    saveStamp(d.stampPath, { ...emptyStamp(), pendingDownSince: NOW - 120_000 });
    await guardianTick(d);
    expect(lines.some((l) => l.startsWith('guardian.stall_recovered'))).toBe(true);
    expect(loadStamp(d.stampPath).pendingDownSince).toBeNull();
  });

  it('a stale pending down (guardian itself was quiet) re-arms instead of raising on old memory', async () => {
    const { d, lines } = tickDeps({ collect: unreachableCleanExit() });
    saveStamp(d.stampPath, { ...emptyStamp(), pendingDownSince: NOW - 3_600_000 });
    await guardianTick(d);
    expect(lines.some((l) => l.startsWith('guardian.down_deferred'))).toBe(true);
    expect(lines.some((l) => l.startsWith('acted:'))).toBe(false);
    expect(loadStamp(d.stampPath).pendingDownSince).toBe(NOW);
  });

  it('a nonzero-exit down raises immediately — deferral is only for the maybe-just-slow shape', async () => {
    const { d, lines } = tickDeps({
      collect: unreachableCleanExit({ launchd: { lastExit: 1, runs: 3 } }),
    });
    await guardianTick(d);
    expect(lines).toContain('acted:daemon_down');
  });

  /**
   * ADR 389's Eval dataset. The arming decision is meant to read 30 days of `guardian.sampled`
   * rows rather than the ADR, so the rows have to include the ones that argue AGAINST arming — a
   * row written only when the class was promoted would be a dataset of confirmations.
   */
  describe('guardian.sampled is the Eval dataset, not a promotion log', () => {
    // Persistence comes from the STAMP, never from the collector — the tick overwrites
    // `firstUnreachableAt` at line 1 of classification, so these cases set `pendingDownSince`.
    const sampled = (stack: Record<string, unknown>) => unreachableCleanExit({ stack });

    const row = (lines: string[]) => {
      const l = lines.find((x) => x.startsWith('guardian.sampled '));
      return l === undefined ? null : JSON.parse(l.slice('guardian.sampled '.length));
    };

    it('a promoted wedge writes the frame, the share and promoted:true', async () => {
      const { d, lines } = tickDeps({
        collect: sampled({
          taken: true,
          pid: 11116,
          total: 2407,
          inFrame: 2406,
          share: 2406 / 2407,
          frame: 'sqlite3_step',
          wedged: true,
        }),
      });
      saveStamp(d.stampPath, { ...emptyStamp(), pendingDownSince: NOW - 120_000 });
      await guardianTick(d);
      expect(row(lines)).toMatchObject({
        taken: true,
        wedged: true,
        frame: 'sqlite3_step',
        pid: 11116,
        promoted: true,
      });
      expect(lines).toContain('acted:daemon_wedged');
    });

    it('a parked sample is written too — promoted:false is the row that could stop the arming', async () => {
      const { d, lines } = tickDeps({
        collect: sampled({
          taken: true,
          total: 2400,
          share: 2399 / 2400,
          frame: 'kevent',
          wedged: false,
          reason: 'dominant frame kevent is a wait primitive — parked, not held',
        }),
      });
      saveStamp(d.stampPath, { ...emptyStamp(), pendingDownSince: NOW - 120_000 });
      await guardianTick(d);
      expect(row(lines)).toMatchObject({ taken: true, wedged: false, promoted: false });
      expect(lines).toContain('acted:daemon_down');
    });

    it('a sample that could not be taken is written with its reason, never dropped', async () => {
      const { d, lines } = tickDeps({
        collect: sampled({ taken: false, reason: 'sample(1) not on PATH', wedged: false }),
      });
      saveStamp(d.stampPath, { ...emptyStamp(), pendingDownSince: NOW - 120_000 });
      await guardianTick(d);
      expect(row(lines)).toMatchObject({
        taken: false,
        reason: 'sample(1) not on PATH',
        promoted: false,
      });
    });

    it('a DEFERRED first sighting still writes its row — the raise is held, the evidence is not', async () => {
      const { d, lines } = tickDeps({
        collect: sampled({ taken: true, frame: 'sqlite3_step', total: 2407, wedged: true }),
      });
      await guardianTick(d); // no prior stamp → first sighting → deferred
      expect(lines.some((l) => l.startsWith('guardian.down_deferred'))).toBe(true);
      expect(row(lines)).toMatchObject({ wedged: true, promoted: false });
    });

    it('a healthy tick pays for no sample and writes no row', async () => {
      const { d, lines } = tickDeps();
      await guardianTick(d);
      expect(row(lines)).toBeNull();
    });
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

  it('names a degraded policy read, when it first failed, and WHY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-status-'));
    const p = join(dir, 'stamp.json');
    saveStamp(p, {
      ...emptyStamp(),
      lastTickAt: NOW - 40_000,
      policySource: 'shipped_default_degraded',
      policyDegradedSince: NOW - 120_000,
      lastPolicyError: { reason: 'unauthorized', detail: 'seat token revoked', at: NOW - 60_000 },
    });
    const line = guardianStatusLine(p, NOW);
    expect(line).toContain('policy defaults — degraded since');
    expect(line).toContain('unauthorized: seat token revoked');
  });

  it('a stamp written before the cause was bound says so rather than inventing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-status-'));
    const p = join(dir, 'stamp.json');
    saveStamp(p, {
      ...emptyStamp(),
      lastTickAt: NOW - 40_000,
      policySource: 'shipped_default_degraded',
      lastPolicyErrorAt: NOW - 120_000,
    });
    expect(guardianStatusLine(p, NOW)).toContain('cause not recorded');
  });

  it('an unset team policy reads as configured-nothing, not as a fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-status-'));
    const p = join(dir, 'stamp.json');
    saveStamp(p, { ...emptyStamp(), lastTickAt: NOW - 40_000, policySource: 'team_policy_unset' });
    expect(guardianStatusLine(p, NOW)).toContain('team has set no tiers');
  });
});

describe('classifyPolicyError (cannot-separate-two-causes: name the cause or say you cannot)', () => {
  it('maps each protocol refusal to the repair it implies', () => {
    const at = NOW;
    expect(classifyPolicyError(new CliError('no', 4, 'unauthorized'), at).reason).toBe(
      'unauthorized',
    );
    expect(classifyPolicyError(new CliError('no', 5, 'expired_grant'), at).reason).toBe(
      'unauthorized',
    );
    expect(classifyPolicyError(new CliError('no', 5, 'forbidden'), at).reason).toBe('forbidden');
    expect(classifyPolicyError(new CliError('no', 3, 'validation'), at).reason).toBe('malformed');
    expect(classifyPolicyError(new CliError('no', 12, 'hub_unreachable'), at).reason).toBe(
      'unreachable',
    );
  });

  it('recognises the transport failures that all mean "the daemon is not answering"', () => {
    expect(classifyPolicyError(new CliError("can't reach team server", 7), NOW).reason).toBe(
      'unreachable',
    );
    expect(classifyPolicyError(new Error('fetch failed'), NOW).reason).toBe('unreachable');
    expect(
      classifyPolicyError(new Error('The operation was aborted due to timeout'), NOW).reason,
    ).toBe('unreachable');
    expect(classifyPolicyError(new SyntaxError('Unexpected token < in JSON'), NOW).reason).toBe(
      'malformed',
    );
  });

  it('an unrecognised failure is `unknown` and keeps its message — never filed under a known one', () => {
    const out = classifyPolicyError(new CliError('server error (500)', 1), NOW);
    expect(out.reason).toBe('unknown');
    expect(out.detail).toBe('server error (500)');
  });

  it('truncates a pathological message so one error cannot own the log file', () => {
    const out = classifyPolicyError(new Error('x'.repeat(5_000)), NOW);
    expect(out.detail.length).toBeLessThanOrEqual(201);
    expect(out.detail.endsWith('…')).toBe(true);
  });
});

/**
 * ADR 438 — the discharge must run on a tick with NOTHING firing.
 *
 * These are at the TICK level on purpose. `dischargeCleared`'s own unit tests passed throughout the
 * bug: they call it directly, and the defect was that nothing called it. A test that exercises a
 * function production never reaches proves the mechanism and says nothing about the wiring — the
 * same shape as the `publisher.ok` fixture in ADR 435. The assertion that matters is which ticks
 * reach the discharge, so that is what is asserted.
 */
describe('ADR 438: discharge is reachable on a healthy tick', () => {
  it('runs on a tick with no incidents — the tick that IS the observation', async () => {
    const { d, lines } = tickDeps();
    await guardianTick(d);
    // The regression in one line: before this, `act` was the only path to the discharge and `act`
    // is not called here, so a raise could sit open through any number of healthy ticks.
    expect(lines.some((l) => l.startsWith('acted:'))).toBe(false);
    expect(lines).toContain('discharged:none');
  });

  it('runs on an incident tick too, AFTER act, carrying the firing classes', async () => {
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
    await guardianTick(d);
    // Order is load-bearing: a class this tick RAISED must be in `firing`, or the same tick that
    // made a raise would discharge it.
    expect(lines.indexOf('acted:publisher_failed')).toBeLessThan(
      lines.indexOf('discharged:publisher_failed'),
    );
  });

  it('does NOT discharge under a handover — an empty classification there means unknown', async () => {
    // ADR 274: the daemon is restarting on purpose, so `classified` is empty for a reason that is
    // not health. Discharging on it would close every open raise on the strength of a tick that
    // deliberately observed nothing (ADR 173: absent is unknown, never zero).
    const { d, lines } = tickDeps({
      collect: async () => ({
        now: NOW,
        health: null,
        handover: { reason: 'refresh', startedAt: NOW - 1_000 },
        launchd: { lastExit: 0, runs: 1 },
        publisherLog: { freshFailure: false },
        errLinesSinceBoot: 0,
        httpErrorRateSinceBoot: 0,
        reaperStormSinceBoot: false,
        lastRefreshAt: null,
      }),
    });
    await guardianTick(d);
    expect(lines).toContain('guardian.handover_deferred');
    expect(lines.some((l) => l.startsWith('discharged:'))).toBe(false);
  });

  it('a failing discharge does not fail the tick — raises stay open and next tick retries', async () => {
    const { d, lines } = tickDeps({
      discharge: async () => {
        throw new Error('daemon unreachable — it may BE the incident');
      },
    });
    expect(await guardianTick(d)).toBe(0);
    expect(loadStamp(d.stampPath).lastTickAt).toBe(NOW);
    expect(lines.some((l) => l.startsWith('discharge failed'))).toBe(true);
  });
});
