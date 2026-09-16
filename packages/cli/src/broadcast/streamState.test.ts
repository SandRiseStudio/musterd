import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FLAP_MAX,
  FLAP_WINDOW_MS,
  decideEnsure,
  standDownReport,
  readStreamState,
  writeStreamState,
  type StreamState,
} from './streamState.js';

const NOW = 1_787_000_000_000;

function live(over: Partial<StreamState> = {}): StreamState {
  return { desired: 'live', by: 'miley', at: NOW - 60_000, team: 'revive', restarts: [], ...over };
}

/** The reconcile rule: a machine gone while desired says live is a crash — restart within the flap
 * budget, stand down at it, and never touch anything a human deliberately stopped. */
describe('decideEnsure', () => {
  it('no state at all → noop (never started, nothing to enforce)', () => {
    expect(decideEnsure({ state: null, liveCount: 0, now: NOW }).action).toBe('noop');
  });

  it('desired stopped → noop even with no machine (a deliberate stop stays stopped)', () => {
    const state = live({ desired: 'stopped', reason: 'nick asked' });
    expect(decideEnsure({ state, liveCount: 0, now: NOW }).action).toBe('noop');
  });

  it('desired live + a started machine → noop (healthy)', () => {
    expect(decideEnsure({ state: live(), liveCount: 1, now: NOW }).action).toBe('noop');
  });

  it('desired live + no machine + budget available → restart, stamping the ledger', () => {
    const d = decideEnsure({ state: live(), liveCount: 0, now: NOW });
    expect(d.action).toBe('restart');
    expect(d.state.restarts).toEqual([NOW]);
  });

  it(`stands down at the ${FLAP_MAX}rd restart inside the window and records when`, () => {
    const recent = [NOW - 20 * 60_000, NOW - 10 * 60_000, NOW - 5 * 60_000];
    const d = decideEnsure({ state: live({ restarts: recent }), liveCount: 0, now: NOW });
    expect(d.action).toBe('stand_down');
    expect(d.state.standDownAt).toBe(NOW);
  });

  it('prunes restarts older than the window — an old bad night does not spend today’s budget', () => {
    const stale = [
      NOW - FLAP_WINDOW_MS - 60_000,
      NOW - FLAP_WINDOW_MS - 30_000,
      NOW - FLAP_WINDOW_MS - 10_000,
    ];
    const d = decideEnsure({ state: live({ restarts: stale }), liveCount: 0, now: NOW });
    expect(d.action).toBe('restart');
    expect(d.state.restarts).toEqual([NOW]);
  });

  // ── deploy vs crash (2026-08-21: two image-push replacements burned 2/3 flap slots) ──────────
  it('machine gone but the recorded image changed → deploy: relaunch WITHOUT spending the budget', () => {
    const state = live({ image: 'sha256:' + 'a'.repeat(64) });
    const d = decideEnsure({
      state,
      liveCount: 0,
      now: NOW,
      recordedDigest: 'sha256:' + 'b'.repeat(64),
    });
    expect(d.action).toBe('restart');
    expect(d.state.restarts).toEqual([]);
    expect(d.note).toMatch(/deploy/i);
  });

  it('a deploy replacement updates the state’s image to what the relaunch will run', () => {
    const next = 'sha256:' + 'b'.repeat(64);
    const d = decideEnsure({
      state: live({ image: 'sha256:' + 'a'.repeat(64) }),
      liveCount: 0,
      now: NOW,
      recordedDigest: next,
    });
    expect(d.state.image).toBe(next);
  });

  it('a deploy is not a crash even at the flap cap — it never stands down', () => {
    const recent = [NOW - 20 * 60_000, NOW - 10 * 60_000, NOW - 5 * 60_000];
    const d = decideEnsure({
      state: live({ image: 'sha256:' + 'a'.repeat(64), restarts: recent }),
      liveCount: 0,
      now: NOW,
      recordedDigest: 'sha256:' + 'b'.repeat(64),
    });
    expect(d.action).toBe('restart');
    expect(d.state.restarts).toEqual(recent);
  });

  it('machine gone with the SAME image recorded → a crash, charged as before', () => {
    const same = 'sha256:' + 'a'.repeat(64);
    const d = decideEnsure({
      state: live({ image: same }),
      liveCount: 0,
      now: NOW,
      recordedDigest: same,
    });
    expect(d.action).toBe('restart');
    expect(d.state.restarts).toEqual([NOW]);
  });

  it('legacy state without an image field → a crash (never a free pass by omission)', () => {
    const d = decideEnsure({
      state: live(),
      liveCount: 0,
      now: NOW,
      recordedDigest: 'sha256:' + 'b'.repeat(64),
    });
    expect(d.action).toBe('restart');
    expect(d.state.restarts).toEqual([NOW]);
  });

  it('stood down → noop forever until a human start/stop clears it (one ask, not one per tick)', () => {
    const state = live({ restarts: [NOW - 3000, NOW - 2000, NOW - 1000], standDownAt: NOW - 500 });
    expect(decideEnsure({ state, liveCount: 0, now: NOW }).action).toBe('noop');
    // even after the flap window would have drained the ledger:
    expect(decideEnsure({ state, liveCount: 0, now: NOW + FLAP_WINDOW_MS * 2 }).action).toBe(
      'noop',
    );
  });
});

describe('stream state file', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'musterd-streamstate-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips, creating parent directories', () => {
    const p = join(dir, 'stream', 'state.json');
    const state = live({ reason: 'nick asked' });
    writeStreamState(p, state);
    expect(readStreamState(p)).toEqual(state);
  });

  it('reads null for a missing or unparseable file (fail-safe: no state, no enforcement)', () => {
    const p = join(dir, 'nope.json');
    expect(readStreamState(p)).toBeNull();
    writeStreamState(p, live());
    rmSync(p);
    expect(readStreamState(p)).toBeNull();
  });
});

/*
 * Lane 01M2K6BWVR. The supervisor stood down twice and told a human "the broadcast crashed 3× in
 * 30min" both times. Nothing had crashed either time: once the laptop had lost DNS
 * (`dial tcp: lookup api.fly.io: no such host`, 10 occurrences in ensure.log), once flyctl was
 * logged out (`no access token available`, 4). All 15 relaunch failures in that log are laptop-side
 * environment faults; not one is the stream dying.
 *
 * The counting is right and stays: a failed launch leaves no machine, the next tick sees none, and
 * three ticks reach the budget — converging on "ask a human" is exactly what should happen when the
 * environment is broken. What was wrong is that the ask named the one thing the supervisor had NOT
 * observed and withheld the three it had (exit code, fly's error text, that no machine ever came up).
 * It is the only channel a human gets, because standing down means it stops trying — so that sentence
 * IS the incident report, and it sent nick hunting a crashing stream twice, eleven days apart.
 */
describe('standDownReport — what the human is told when the supervisor gives up', () => {
  /* The REAL line flyctl emitted on nick's laptop, 2026-09-04, copied out of ensure.log rather than
     abbreviated. The first version of this fixture was a tidy short one, and it hid a defect in the
     fix: the cause sits at the END of a ~380-char line, so capping from the front kept the GraphQL
     query body and threw away `no such host`. A fixture that cannot fail is not a fixture. */
  const dnsErr =
    'Error: failed to run query ($appName: String!) { appcompact:app(name: $appName) { id ' +
    'internalNumericId name hostname cnameTarget deployed network status appUrl platformVersion ' +
    'organization { id internalNumericId slug paidPlan } postgresAppRole: role { name } } }: ' +
    'Post "https://api.fly.io/graphql": dial tcp: lookup api.fly.io: no such host';

  it('names the launch failure and its cause when the machine never came up', () => {
    const state = live({
      restarts: [NOW - 3000, NOW - 2000, NOW - 1000],
      failures: [
        { at: NOW - 3000, code: 1, error: dnsErr },
        { at: NOW - 2000, code: 1, error: dnsErr },
        { at: NOW - 1000, code: 1, error: dnsErr },
      ],
    });
    const r = standDownReport(state, NOW);
    expect(r).toContain('3 launch attempts failed');
    expect(r).toContain('lookup api.fly.io: no such host'); // the operator's actual next step
    // The word that sent a human looking in the wrong place, twice.
    expect(r).not.toContain('crashed');
  });

  it('still says the broadcast stopped when machines really did vanish', () => {
    const state = live({ restarts: [NOW - 3000, NOW - 2000, NOW - 1000], failures: [] });
    const r = standDownReport(state, NOW);
    expect(r).toContain('stopped 3×');
    expect(r).not.toContain('launch attempts failed');
  });

  it('reports both counts when some launched and some never got off the ground', () => {
    const state = live({
      restarts: [NOW - 3000, NOW - 2000, NOW - 1000],
      failures: [{ at: NOW - 1000, code: 1, error: 'Error: no access token available' }],
    });
    const r = standDownReport(state, NOW);
    expect(r).toContain('1 of them'); // the launches that never produced a machine
    expect(r).toContain('no access token available');
  });

  it('a state written before failures were recorded degrades to a count, and claims no cause', () => {
    const state = live({ restarts: [NOW - 3000, NOW - 2000, NOW - 1000] }); // no `failures` key
    const r = standDownReport(state, NOW);
    expect(r).toContain('3×');
    expect(r).not.toContain('crashed'); // still must not assert what it did not see
    expect(r).not.toContain('undefined');
  });

  it('carries the fly error as one line, capped — an ask is read in a notification', () => {
    const state = live({
      restarts: [NOW - 1000],
      failures: [{ at: NOW - 1000, code: 1, error: `${dnsErr}\nsecond line\nthird line` }],
    });
    const r = standDownReport(state, NOW);
    expect(r).not.toContain('\n');
    expect(r.length).toBeLessThan(400);
  });

  it('drops the embedded query fly quotes and keeps the six words that matter', () => {
    const state = live({
      restarts: [NOW - 1000],
      failures: [{ at: NOW - 1000, code: 1, error: dnsErr }],
    });
    const r = standDownReport(state, NOW);
    expect(r).toContain('failed to run query'); // what fly was doing
    expect(r).toContain('dial tcp: lookup api.fly.io: no such host'); // …and why it could not
    expect(r).not.toContain('internalNumericId'); // …without the document it was sending
    expect(r).not.toContain('…l'); // never a mid-word head-trim: the cause survives intact
  });

  it('quotes the fault, not whatever fly printed last', () => {
    // Real capture shape: flyctl emits a metrics warning alongside the failure, and on a DNS
    // outage the warning is about DNS too — so "the last line" can look plausible and still be
    // the wrong subject.
    const state = live({
      restarts: [NOW - 1000],
      failures: [
        {
          at: NOW - 1000,
          code: 1,
          error: `Error: no access token available. Please login with 'flyctl auth login'\nWarning: Metrics send issue: failed to send metrics`,
        },
      ],
    });
    const r = standDownReport(state, NOW);
    expect(r).toContain('no access token available');
    expect(r).not.toContain('Metrics send issue');
  });

  it('prunes failures to the flap window with the restarts they belong to', () => {
    const stale = NOW - FLAP_WINDOW_MS - 1;
    const state = live({
      restarts: [stale, NOW - 2000, NOW - 1000],
      failures: [{ at: stale, code: 1, error: 'ancient history' }],
    });
    const d = decideEnsure({ state, liveCount: 0, now: NOW });
    expect(d.state.failures ?? []).toEqual([]);
    expect(standDownReport(d.state, NOW)).not.toContain('ancient history');
  });
});
