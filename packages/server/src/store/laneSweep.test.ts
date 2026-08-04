import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { openLane, updateLane } from './lanes.js';
import { SWEEP_GRACE_MS, sweepAbandonedAcceptance } from './laneSweep.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  addMember(db, team, { name: 'nick', kind: 'human' });
  addMember(db, team, { name: 'dolly', kind: 'agent' });
  return { db, team };
}

/** The `lane.closed` audit row the sweep owes, decoded. */
function closeRow(db: ReturnType<typeof openDb>, laneId: string) {
  const row = db
    .prepare<
      [string],
      { actor: string; detail: string }
    >(`SELECT actor, detail FROM audit WHERE action = 'lane.closed' AND target = ? ORDER BY ts DESC LIMIT 1`)
    .get(laneId);
  return row
    ? { actor: row.actor, detail: JSON.parse(row.detail) as Record<string, unknown> }
    : null;
}

/** A lane parked in awaiting_acceptance `agedMs` ago. */
function stranded(db: ReturnType<typeof openDb>, teamId: string, agedMs: number, title = 'lane') {
  const lane = openLane(db, teamId, 'revive', 'dolly', { title, claim: true });
  updateLane(db, teamId, lane.id, 'revive', { state: 'awaiting_acceptance' });
  db.prepare(`UPDATE lanes SET updated_at = ? WHERE id = ?`).run(Date.now() - agedMs, lane.id);
  return lane;
}

describe('sweepAbandonedAcceptance — the backstop (ADR 229)', () => {
  it('closes a lane that has waited past the grace, and says the system did it', () => {
    const { db, team } = seed();
    const lane = stranded(db, team.id, SWEEP_GRACE_MS + 60_000);

    const swept = sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());
    expect(swept.map((s) => s.id)).toEqual([lane.id]);

    const row = closeRow(db, lane.id);
    expect(row?.actor).toBe('musterd');
    expect(row?.detail['closed_by']).toBe('musterd');
    expect(row?.detail['state']).toBe('done');
  });

  // THE dangerous one. `verified` is derived as "closed by a seat other than the owner", which the
  // system satisfies trivially — so the naive version records every swept lane as a genuine
  // cross-seat review. ADR 056's diversity conclusions read this exact field, so a regression here
  // silently fabricates research data rather than breaking anything visible.
  it('never records a swept close as verified, and never as a counterpart confirm', () => {
    const { db, team } = seed();
    const lane = stranded(db, team.id, SWEEP_GRACE_MS + 1);

    sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());

    const row = closeRow(db, lane.id);
    // Asserted as an explicit false, not a falsy absence (ADR 173 clause 3): a reader folding
    // `undefined` into truthy must not be able to read this as a confirm.
    expect(row?.detail).toHaveProperty('verified', false);
    expect(row?.detail['reason']).toBe('review_swept');
    expect(row?.detail['reason']).not.toBe('counterpart_confirm');
    // A reviewer family is only written for a real confirm — the system has none to claim.
    expect(row?.detail['reviewer_family']).toBeUndefined();
  });

  it('leaves a lane still inside the grace completely alone', () => {
    const { db, team } = seed();
    const lane = stranded(db, team.id, SWEEP_GRACE_MS - 60_000);
    const before = db
      .prepare<[string], { updated_at: number }>(`SELECT updated_at FROM lanes WHERE id = ?`)
      .get(lane.id)!.updated_at;

    expect(sweepAbandonedAcceptance(db, team.id, 'revive', Date.now())).toEqual([]);

    // Not merely unclosed — UNTOUCHED. recordLaneClose derives time_in_review_ms from updated_at,
    // so a sweep that stamped lanes as it inspected them would corrupt that figure for every later
    // close, including the human-accepted ones this feature is not even about.
    const after = db
      .prepare<
        [string],
        { updated_at: number; state: string }
      >(`SELECT updated_at, state FROM lanes WHERE id = ?`)
      .get(lane.id)!;
    expect(after.updated_at).toBe(before);
    expect(after.state).toBe('awaiting_acceptance');
    expect(closeRow(db, lane.id)).toBeNull();
  });

  it('ignores lanes in every other state, however old', () => {
    const { db, team } = seed();
    const old = Date.now() - SWEEP_GRACE_MS * 10;
    for (const state of ['open', 'claimed', 'active', 'blocked'] as const) {
      const lane = openLane(db, team.id, 'revive', 'dolly', { title: state, claim: true });
      updateLane(db, team.id, lane.id, 'revive', { state });
      db.prepare(`UPDATE lanes SET updated_at = ? WHERE id = ?`).run(old, lane.id);
    }
    expect(sweepAbandonedAcceptance(db, team.id, 'revive', Date.now())).toEqual([]);
  });

  it('records how long the lane actually waited', () => {
    const { db, team } = seed();
    const waited = SWEEP_GRACE_MS + 3 * 60 * 60 * 1000;
    stranded(db, team.id, waited);

    const [s] = sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());
    expect(s!.waited_ms).toBeGreaterThanOrEqual(waited);
    expect(s!.owner_seat).toBe('dolly');
  });
});
