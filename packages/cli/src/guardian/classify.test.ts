import { describe, expect, it } from 'vitest';
import {
  classify,
  DEFAULT_TIERS,
  ERROR_RATE_FLOOR,
  resolveGuardianTiers,
  type GuardianSignals,
} from './classify.js';

const healthy: GuardianSignals = {
  now: 1_000_000,
  health: { ok: true, bootedAt: 900_000, schemaOk: true, dbPathExpected: true },
  launchd: { lastExit: 0, runs: 1 },
  publisherLog: { freshFailure: false },
  errLinesSinceBoot: 0,
  httpErrorRateSinceBoot: 0,
  reaperStormSinceBoot: false,
  lastRefreshAt: null,
};

describe('classify (guardian spec §4)', () => {
  it('healthy signals classify to no incidents', () => {
    expect(classify(healthy)).toEqual([]);
  });

  it('publisher failure with a healthy daemon is publisher_failed', () => {
    const out = classify({ ...healthy, publisherLog: { freshFailure: true } });
    expect(out).toEqual([{ class: 'publisher_failed' }]);
  });

  it('climbing runs + fresh err lines within 30m of a refresh is crashloop', () => {
    const out = classify({
      ...healthy,
      health: null,
      launchd: { lastExit: 1, runs: 5 },
      errLinesSinceBoot: 12,
      lastRefreshAt: 1_000_000 - 10 * 60_000,
    });
    expect(out.map((i) => i.class)).toContain('crashloop');
    expect(out.map((i) => i.class)).not.toContain('daemon_down');
  });

  it('unreachable health + nonzero last exit, no recent refresh, is daemon_down', () => {
    const out = classify({ ...healthy, health: null, launchd: { lastExit: 1, runs: 3 } });
    expect(out).toEqual([{ class: 'daemon_down' }]);
  });

  it('a reachable healthy daemon never classifies from stale evidence — the 8-day-old-log ghost', () => {
    // errLinesSinceBoot is boot-filtered by the collector; a huge stale log contributes zero.
    expect(classify({ ...healthy, launchd: { lastExit: 1, runs: 40 } })).toEqual([]);
  });

  it('schema_drift and wrong_db come from the health payload', () => {
    expect(classify({ ...healthy, health: { ...healthy.health!, schemaOk: false } })).toEqual([
      { class: 'schema_drift' },
    ]);
    expect(classify({ ...healthy, health: { ...healthy.health!, dbPathExpected: false } })).toEqual(
      [{ class: 'wrong_db' }],
    );
  });

  it('error_rate fires at the floor, not below it', () => {
    expect(classify({ ...healthy, httpErrorRateSinceBoot: ERROR_RATE_FLOOR - 1 })).toEqual([]);
    expect(classify({ ...healthy, httpErrorRateSinceBoot: ERROR_RATE_FLOOR })).toEqual([
      { class: 'error_rate' },
    ]);
  });

  it('presence_churn fires on a reaper storm since boot', () => {
    expect(classify({ ...healthy, reaperStormSinceBoot: true })).toEqual([
      { class: 'presence_churn' },
    ]);
  });

  it('auto classes order before alert classes when both fire', () => {
    const out = classify({
      ...healthy,
      publisherLog: { freshFailure: true },
      reaperStormSinceBoot: true,
    });
    expect(out.map((i) => i.class)).toEqual(['publisher_failed', 'presence_churn']);
  });
});

describe('resolveGuardianTiers (policy over defaults, read-time)', () => {
  it('absent policy yields the defaults; a sparse override changes one class only', () => {
    expect(resolveGuardianTiers(undefined)).toEqual(DEFAULT_TIERS);
    const tiers = resolveGuardianTiers({ daemon_down: 'auto' });
    expect(tiers.daemon_down).toBe('auto');
    expect(tiers.publisher_failed).toBe('auto');
    expect(tiers.presence_churn).toBe('alert');
  });
});

describe('DEFAULT_TIERS (spec §4 shipped defaults)', () => {
  it('matches the spec table exactly', () => {
    expect(DEFAULT_TIERS).toEqual({
      publisher_failed: 'auto',
      crashloop: 'auto',
      daemon_down: 'alert',
      schema_drift: 'alert',
      wrong_db: 'alert',
      error_rate: 'alert',
      presence_churn: 'alert',
    });
  });
});
