import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { openLane, updateLane } from './lanes.js';
import { createTeam, setPolicy } from './teams.js';

/**
 * ADR 244 — an admin default writes a lane's stakes, and the ledger still knows WHO decided.
 *
 * The provenance field exists to protect ADR 234's rollback test, which asks whether *declared*
 * stakes predict the answer rate. A policy that writes `low` without saying so would pool worker
 * judgement and policy assumption into one bucket and destroy that test silently — so these cases
 * are about the split staying legible, not merely about the default firing.
 */
describe('openLane + admin default stakes', () => {
  const seed = (rules?: { surface: string; stakes: 'low' | 'normal' | 'high' }[]) => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'revive' });
    if (rules) setPolicy(db, team.id, { stakes_defaults: rules });
    return { db, team };
  };
  const web = [{ surface: 'packages/web/**', stakes: 'low' as const }];

  it('is inert with no policy — every lane opens exactly as it did before', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'revive', 'ada', {
      title: 't',
      scope: ['packages/web/src/x.ts'],
    });
    expect(lane.stakes).toBe('normal');
    expect(lane.stakes_provenance).toBe('declared');
  });

  it('applies the default and records it as DEFAULTED, not declared', () => {
    const { db, team } = seed(web);
    const lane = openLane(db, team.id, 'revive', 'ada', {
      title: 't',
      scope: ['packages/web/src/live/client.ts'],
    });
    expect(lane.stakes).toBe('low');
    // The whole point. Without this the Eval sees a `low` it cannot attribute.
    expect(lane.stakes_provenance).toBe('defaulted');
  });

  it('an explicit declaration wins over the policy, and stays DECLARED — upward', () => {
    // Frictionless upward override: a seat that believes its web change deserves eyes must be able
    // to say so without an admin.
    const { db, team } = seed(web);
    const lane = openLane(db, team.id, 'revive', 'ada', {
      title: 't',
      scope: ['packages/web/src/live/client.ts'],
      stakes: 'high',
    });
    expect(lane.stakes).toBe('high');
    expect(lane.stakes_provenance).toBe('declared');
  });

  it('an explicit declaration matching the policy is still DECLARED, not defaulted', () => {
    // The subtle one: the seat said `low` and the policy would also have said `low`. Recording that
    // as `defaulted` would credit the policy with a judgement the worker actually made, and inflate
    // the policy bucket with lanes that prove nothing about it.
    const { db, team } = seed(web);
    const lane = openLane(db, team.id, 'revive', 'ada', {
      title: 't',
      scope: ['packages/web/src/live/client.ts'],
      stakes: 'low',
    });
    expect(lane.stakes).toBe('low');
    expect(lane.stakes_provenance).toBe('declared');
  });

  it('records DEFAULTED even when the rule changes nothing', () => {
    // A rule defaulting to `normal` leaves the value untouched but DID fire. If that recorded as
    // `declared`, "the policy is inert on this surface" would be unfalsifiable from the ledger.
    const { db, team } = seed([{ surface: 'packages/server/**', stakes: 'normal' }]);
    const lane = openLane(db, team.id, 'revive', 'ada', {
      title: 't',
      scope: ['packages/server/src/store/x.ts'],
    });
    expect(lane.stakes).toBe('normal');
    expect(lane.stakes_provenance).toBe('defaulted');
  });

  it('a lane touching web AND server does not get the web default', () => {
    const { db, team } = seed(web);
    const lane = openLane(db, team.id, 'revive', 'ada', {
      title: 't',
      scope: ['packages/web/src/x.ts', 'packages/server/src/y.ts'],
    });
    expect(lane.stakes).toBe('normal');
    expect(lane.stakes_provenance).toBe('declared');
  });

  it('a later policy change cannot rewrite a lane that is already open', () => {
    // Resolution happens at open and never again — the ADR 234 increment-2 discipline applied one
    // edge earlier. A policy that resolved late would be a policy that can rewrite history.
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'revive', 'ada', {
      title: 't',
      scope: ['packages/web/src/x.ts'],
    });
    expect(lane.stakes).toBe('normal');
    setPolicy(db, team.id, { stakes_defaults: web });
    const after = updateLane(db, team.id, lane.id, 'revive', { detail: 'unrelated' });
    expect(after?.stakes).toBe('normal');
    expect(after?.stakes_provenance).toBe('declared');
  });

  it('a worker editing stakes after open takes ownership of the value', () => {
    // A defaulted lane the worker then re-declares is theirs, and the ledger must say so — otherwise
    // an override would keep counting toward the policy bucket it was overriding.
    const { db, team } = seed(web);
    const lane = openLane(db, team.id, 'revive', 'ada', {
      title: 't',
      scope: ['packages/web/src/x.ts'],
    });
    expect(lane.stakes_provenance).toBe('defaulted');
    const after = updateLane(db, team.id, lane.id, 'revive', { stakes: 'high' });
    expect(after?.stakes).toBe('high');
    expect(after?.stakes_provenance).toBe('declared');
  });
});
