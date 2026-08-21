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
    // Matched on class rather than whole-object equality: the incident now also carries `evidence`,
    // and this assertion is about WHICH class fires, not about the incident being empty.
    expect(out.map((i) => i.class)).toEqual(['daemon_down']);
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

/**
 * The two `daemon_down` branches describe genuinely different situations and used to produce the
 * identical raise. The second one — unreachable while launchd reports a clean exit and no restart —
 * is the shape a daemon that is merely TOO BUSY TO ANSWER presents, and it is what actually happened
 * on 2026-08-19: booted_at predated the raise by 69 minutes and never moved, so the daemon never
 * died. `hydrate.ts` already records the mechanism ("time any handler holds is time /health waits …
 * Four of those alarms were false for exactly this reason"); the raise just never said so.
 */
describe('daemon_down says which kind of down, and what the probe saw', () => {
  const unreachable = {
    ...healthy,
    health: null,
    healthProbe: { attempts: 3, lastError: 'The operation timed out' },
  };

  it('a nonzero last exit names the exit code and the probe error', () => {
    const out = classify({ ...unreachable, launchd: { lastExit: 1, runs: 3 } });
    expect(out).toHaveLength(1);
    expect(out[0]!.class).toBe('daemon_down');
    expect(out[0]!.evidence).toContain('exit 1');
    expect(out[0]!.evidence).toContain('timed out');
  });

  it('a clean exit with no restart says the daemon may be alive but unanswering', () => {
    const out = classify({ ...unreachable, launchd: { lastExit: 0, runs: 1 } });
    expect(out[0]!.evidence).toMatch(/never restarted|did not restart|still running/i);
    expect(out[0]!.evidence).toContain('3 attempts');
  });

  it('the two branches do not read alike — the whole point', () => {
    const a = classify({ ...unreachable, launchd: { lastExit: 1, runs: 3 } })[0]!.evidence;
    const b = classify({ ...unreachable, launchd: { lastExit: 0, runs: 1 } })[0]!.evidence;
    expect(a).not.toBe(b);
  });

  it('survives a probe that recorded nothing — evidence is still present, never undefined', () => {
    const out = classify({ ...healthy, health: null, launchd: { lastExit: 1, runs: 3 } });
    expect(out[0]!.evidence).toBeTruthy();
  });
});

/**
 * The raise used to end by telling a human to "check /health directly and compare booted_at before
 * treating this as an outage" — prescribing a check the guardian could run itself, then raising at
 * standard tier anyway. Every one of the six false alarms on 2026-08-21 carried that sentence. Now
 * the confirming probe HAS run, so the raise reports a result instead of assigning homework.
 */
describe('the raise reports the confirming probe rather than prescribing it', () => {
  const wedged = {
    ...healthy,
    health: null,
    launchd: { lastExit: 0, runs: 15 },
    healthProbe: {
      attempts: 3,
      lastError: 'The operation was aborted due to timeout',
      confirmMs: 10_000,
      confirmError: 'The operation was aborted due to timeout',
    },
  };

  it('names the longer bound, so the reader can see slow was ruled out', () => {
    const e = classify(wedged)[0]!.evidence!;
    expect(e).toContain('3 attempts');
    expect(e).toContain('10000ms');
    // The homework sentence is gone: the guardian did the check it used to delegate.
    expect(e).not.toMatch(/check \/health directly/i);
  });

  it('a confirm that failed with a REFUSAL reads differently from one that timed out', () => {
    const refused = classify({
      ...wedged,
      healthProbe: { ...wedged.healthProbe, confirmError: 'connect ECONNREFUSED 127.0.0.1:4849' },
    })[0]!.evidence!;
    expect(refused).toContain('ECONNREFUSED');
    expect(refused).not.toEqual(classify(wedged)[0]!.evidence);
  });

  it('an old signal with no confirm recorded still classifies and still says what it saw', () => {
    // Forward-compat: a tick from a build before the confirming probe existed must not lose its
    // evidence or throw — it simply cannot report a bound it never applied.
    const e = classify({
      ...wedged,
      healthProbe: { attempts: 3, lastError: 'The operation timed out' },
    })[0]!.evidence!;
    expect(e).toContain('3 attempts');
    expect(e).not.toContain('10000ms');
  });
});
