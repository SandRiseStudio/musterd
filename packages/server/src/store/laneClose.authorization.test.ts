import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { recordLaneClose } from './laneClose.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

/**
 * ADR 202 gave a lane's acceptance a confirmed door: the acceptor answers the `lane_review` ask
 * from THEIR OWN seat, and `verified` falls out of `closer !== owner-at-close`. This file is about
 * the other door — the one a seat uses when the human's verdict arrives in-session, spoken to the
 * agent rather than sent from the human's seat, and relayed as `lane_resolve {authorized_by}`.
 *
 * That relay must not be promoted to `verified`: a client-attested name (see the ADR 109 note in
 * `recordLaneClose`) would let any seat mint its own acceptance, which is the failure ADR 192
 * exists to prevent. But it must not VANISH either, and that is what these pin.
 */
function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  addMember(db, team, { name: 'nick', kind: 'human' });
  addMember(db, team, { name: 'izzo', kind: 'agent' });
  return { db, team };
}

function auditRows(db: ReturnType<typeof openDb>, action: string, target: string) {
  return db
    .prepare<[string, string], { actor: string; detail: string }>(
      `SELECT actor, detail FROM audit WHERE action = ? AND target = ? ORDER BY ts DESC`,
    )
    .all(action, target)
    .map((r) => ({ actor: r.actor, detail: JSON.parse(r.detail) as Record<string, unknown> }));
}

/** A lane owned by izzo, parked in review, closed `done` by izzo relaying nick's verdict. */
function relayedClose(db: ReturnType<typeof openDb>, teamId: string, opts: { branch?: string }) {
  const lane = openLane(db, teamId, 'revive', 'izzo', {
    title: 'harness residency increment 6',
    claim: true,
    ...(opts.branch ? { branch: opts.branch } : {}),
  });
  updateLane(db, teamId, lane.id, 'revive', { state: 'awaiting_acceptance' });
  const before = { ...lane, state: 'awaiting_acceptance' as const };
  const done = { ...before, state: 'done' as const };
  recordLaneClose(db, teamId, { name: 'izzo', kind: 'agent' }, before, done, {
    authorized_by: 'nick',
  });
  return lane;
}

describe('a relayed human authorization is recorded, never promoted (ADR 192 / 202)', () => {
  // THE defect. A branchless lane takes the `git.pr_merged` early-out, so before the fix the only
  // place `authorized_by` landed was the lane row — and the ledger, which is the artifact ADR 109
  // and ADR 127 exist to make joinable, held no trace of the claimed authorizer at all. The name of
  // the human who actually gave the verdict was accepted by the API and silently dropped.
  it('records the claimed authorizer on a branchless lane, where there is no git row to carry it', () => {
    const { db, team } = seed();
    const lane = relayedClose(db, team.id, {});

    const [close] = auditRows(db, 'lane.closed', lane.id);
    expect(close?.detail['authorization_claimed']).toBe('nick');
  });

  // The other half, and the reason this cannot simply be promoted: the claim is client-attested.
  // `verified` must still read false, and the reason must still be the honest `self_close`.
  // The relay must not buy a better reason either. This lane WAS asked for (it passed through
  // awaiting_acceptance), so ADR 217's wait verdict owns the label — `review_timeout` here, the
  // abstaining form, because nothing recorded a promised window. The claimed authorizer rides
  // beside that verdict; it never replaces it.
  it('does not promote the relay to verified, and leaves the wait verdict owning the reason', () => {
    const { db, team } = seed();
    const lane = relayedClose(db, team.id, {});

    const [close] = auditRows(db, 'lane.closed', lane.id);
    expect(close?.detail['verified']).toBe(false);
    expect(close?.detail['reason']).toBe('review_timeout');
    // Countable as a distinct shape: a self-close that claimed an authorizer is NOT the same event
    // as a self-close that claimed nothing, and ADR 169's review-catch rate must be able to tell
    // them apart rather than folding both into silence.
    expect(close?.detail['authorization_claimed']).toBe('nick');
  });

  // A self-close claiming nobody must stay exactly as it was — the field is absent, not null or
  // empty. ADR 173: an absent key and a present-but-empty one are different facts.
  it('writes no authorization key when the close claimed no authorizer', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'revive', 'izzo', { title: 'plain', claim: true });
    updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
    const before = { ...lane, state: 'awaiting_acceptance' as const };
    recordLaneClose(
      db,
      team.id,
      { name: 'izzo', kind: 'agent' },
      before,
      { ...before, state: 'done' as const },
      undefined,
    );

    const [close] = auditRows(db, 'lane.closed', lane.id);
    expect(close?.detail).not.toHaveProperty('authorization_claimed');
  });

  // A counterpart close needs no relay: the closer IS the authority, and asserting a second,
  // client-attested one alongside `verified: true` would muddy which fact carried the confirmation.
  it('writes no authorization key when a counterpart genuinely confirmed', () => {
    const { db, team } = seed();
    const lane = openLane(db, team.id, 'revive', 'izzo', { title: 'confirmed', claim: true });
    updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
    const before = { ...lane, state: 'awaiting_acceptance' as const };
    recordLaneClose(
      db,
      team.id,
      { name: 'nick', kind: 'human' },
      before,
      { ...before, state: 'done' as const },
      { authorized_by: 'nick' },
    );

    const [close] = auditRows(db, 'lane.closed', lane.id);
    expect(close?.detail['verified']).toBe(true);
    expect(close?.detail).not.toHaveProperty('authorization_claimed');
  });

  // The branch-carrying path already carried the name into `git.pr_merged` (ADR 109). That join is
  // load-bearing and must survive the new key rather than move.
  it('keeps the ADR 109 git join intact on a branch-carrying lane', () => {
    const { db, team } = seed();
    const lane = relayedClose(db, team.id, { branch: 'izzo/residency-inc6' });

    const [git] = auditRows(db, 'git.pr_merged', 'izzo/residency-inc6');
    expect(git?.detail['authorized_by']).toBe('nick');
    const [close] = auditRows(db, 'lane.closed', lane.id);
    expect(close?.detail['authorization_claimed']).toBe('nick');
  });
});
