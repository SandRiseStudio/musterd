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
      // ADR 389 §3: ships dark. The only class whose remediation is destructive, and the tier is
      // deliberately not sufficient to arm it on its own.
      daemon_wedged: 'alert',
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

  it('a first-observation clean-exit down is marked defer, not raised', () => {
    // 2026-08-24, 16:10:13: a 77 s event-loop stall outlasted the 2 s probes AND the 10 s confirm,
    // against a daemon that had answered /health 200 in 1.8 ms minutes later. No single-tick bound
    // outwaits an arbitrary stall; only the NEXT tick (~120 s away) can. First sighting defers.
    const out = classify(wedged);
    expect(out).toHaveLength(1);
    expect(out[0]!.class).toBe('daemon_down');
    expect(out[0]!.defer).toBe(true);
  });

  it('a clean-exit down already seen by a previous tick raises, with the persistence in evidence', () => {
    const out = classify({ ...wedged, firstUnreachableAt: wedged.now - 120_000 });
    expect(out[0]!.defer).toBeUndefined();
    expect(out[0]!.evidence).toMatch(/120\s?s|two ticks|persisted/i);
  });

  it('a nonzero last exit never defers — launchd witnessed a real exit', () => {
    const out = classify({ ...wedged, launchd: { lastExit: 1, runs: 15 } });
    expect(out[0]!.class).toBe('daemon_down');
    expect(out[0]!.defer).toBeUndefined();
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

/**
 * ADR 389 §1. The four circumstantial conditions above are jointly satisfied by BOTH "wedged with
 * the socket still held" and "went away without launchd noticing" — different incidents with
 * different owners. Only the stack sample separates them, so only the sample may make this class.
 *
 * The direction that matters is asymmetric: failing to promote costs a slightly vaguer raise at
 * the same tier, while promoting wrongly points a destructive remediation at an incident whose
 * evidence never supported it. Every degradation path below therefore lands on `daemon_down`.
 */
describe('daemon_wedged is made by the sample, never by the circumstances', () => {
  const persisted = {
    ...healthy,
    health: null,
    launchd: { lastExit: 0, runs: 15 },
    healthProbe: {
      attempts: 3,
      lastError: 'The operation was aborted due to timeout',
      confirmMs: 10_000,
      confirmError: 'The operation was aborted due to timeout',
    },
    firstUnreachableAt: healthy.now - 120_000,
  };

  const heldSample = {
    taken: true,
    pid: 11116,
    total: 2407,
    inFrame: 2406,
    share: 2406 / 2407,
    frame: 'sqlite3_step',
    wedged: true,
  };

  it('promotes only with a sample naming one synchronous frame, and names it in the raise', () => {
    const out = classify({ ...persisted, stack: heldSample });
    expect(out).toHaveLength(1);
    expect(out[0]!.class).toBe('daemon_wedged');
    expect(out[0]!.defer).toBeUndefined();
    expect(out[0]!.evidence).toContain('sqlite3_step');
    expect(out[0]!.evidence).toMatch(/ALIVE and blocked/);
  });

  it('ships dark: the promoted class still carries the alert tier, not auto', () => {
    // The whole safety of increment 1 is that nothing new can act. If this ever reads 'auto' by
    // default, ADR 389 §3 has been violated by one line of policy.
    expect(DEFAULT_TIERS.daemon_wedged).toBe('alert');
  });

  it('the identical circumstances WITHOUT a sample stay daemon_down', () => {
    const out = classify(persisted);
    expect(out[0]!.class).toBe('daemon_down');
  });

  it('a sample that could not be taken degrades to daemon_down and says why', () => {
    const out = classify({
      ...persisted,
      stack: { taken: false, reason: 'sample(1) not on PATH', wedged: false },
    });
    expect(out[0]!.class).toBe('daemon_down');
    expect(out[0]!.evidence).toContain('sample(1) not on PATH');
  });

  it('a parked process is NOT wedged — an idle loop concentrates just as hard', () => {
    // The one direction this class must never be wrong in: a daemon whose HTTP server died on an
    // otherwise quiet event loop looks identical in every circumstantial signal.
    const out = classify({
      ...persisted,
      stack: {
        taken: true,
        total: 2400,
        inFrame: 2399,
        share: 2399 / 2400,
        frame: 'kevent',
        wedged: false,
        reason: 'dominant frame kevent is a wait primitive — parked, not held',
      },
    });
    expect(out[0]!.class).toBe('daemon_down');
    expect(out[0]!.evidence).toMatch(/parked, not held/);
  });

  it('a first sighting still defers even with a held sample — persistence is not optional', () => {
    // The sample proves ALIVE-and-blocked; only the next tick proves it did not recover. A 77 s
    // event-loop stall is alive and blocked too, and it ends by itself.
    const out = classify({ ...persisted, firstUnreachableAt: null, stack: heldSample });
    expect(out[0]!.class).toBe('daemon_down');
    expect(out[0]!.defer).toBe(true);
    // The evidence rides the deferred raise anyway — it is most useful while it is fresh.
    expect(out[0]!.evidence).toContain('sqlite3_step');
  });

  it('a witnessed nonzero exit is never wedged, whatever the sample says', () => {
    // launchd saw the process leave; a stack sample of a pid it no longer owns cannot outrank that.
    const out = classify({ ...persisted, launchd: { lastExit: 1, runs: 15 }, stack: heldSample });
    expect(out[0]!.class).toBe('daemon_down');
  });
});
