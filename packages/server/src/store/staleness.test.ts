import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { staleLaneWarnings } from './staleness.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  return { db, team, nick };
}

/** Emit a `defer`/`steer` naming a Goal at a controlled ts (a plan-epoch bump). */
let mid = 0;
function bump(
  db: ReturnType<typeof seed>['db'],
  teamId: string,
  fromId: string,
  goalId: string,
  ts: number,
  act: 'defer' | 'steer' = 'defer',
) {
  insertMessage(
    db,
    teamId,
    fromId,
    null,
    makeEnvelope({
      id: `b${++mid}`,
      team: 'revive',
      from: 'nick',
      to: { kind: 'team' },
      act,
      body: `[${act}]`,
      meta: { goal_id: goalId, ...(act === 'defer' ? { wave: 'later' } : {}) },
      ts,
    }),
  );
}

describe('staleLaneWarnings (ADR 109 — stale-plan detection, ADR 088 §5)', () => {
  it('no warning when a lane was claimed at the Goal’s current epoch', () => {
    const { db, team, nick } = seed();
    // lane claimed at ts 100; a defer at ts 50 (BEFORE the claim) — the owner already had it.
    bump(db, team.id, nick.id, 'spine', 50);
    openLane(db, team.id, 'revive', 'stanley', { title: 'a', goal_id: 'spine', claim: true }, 100);
    expect(staleLaneWarnings(db, team.id, 'revive')).toEqual([]);
  });

  it('stale_plan fires when the lane’s own Goal advances an epoch after it was claimed', () => {
    const { db, team, nick } = seed();
    const lane = openLane(
      db,
      team.id,
      'revive',
      'stanley',
      { title: 'a', goal_id: 'spine', claim: true },
      100,
    );
    bump(db, team.id, nick.id, 'spine', 200); // plan moved AFTER the claim
    const warnings = staleLaneWarnings(db, team.id, 'revive');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: 'stale_plan',
      subject: lane.id,
      with: 'spine',
      owner: 'stanley',
    });
  });

  it('only warns live owned lanes — a done or unowned lane is never stale', () => {
    const { db, team, nick } = seed();
    const done = openLane(
      db,
      team.id,
      'revive',
      'stanley',
      { title: 'done', goal_id: 'spine', claim: true },
      100,
    );
    updateLane(db, team.id, done.id, 'revive', { state: 'done' });
    openLane(db, team.id, 'revive', 'stanley', { title: 'open', goal_id: 'spine' }, 100); // unowned
    bump(db, team.id, nick.id, 'spine', 200);
    expect(staleLaneWarnings(db, team.id, 'revive')).toEqual([]);
  });

  it('stale_dependency: a lane building on a lane whose Goal moved is flagged specifically', () => {
    const { db, team, nick } = seed();
    // A on goal spine (claimed early), B depends on A (claimed early on a different goal).
    const a = openLane(
      db,
      team.id,
      'revive',
      'june',
      { title: 'schema', goal_id: 'spine', claim: true },
      100,
    );
    const b = openLane(
      db,
      team.id,
      'revive',
      'stanley',
      { title: 'client', goal_id: 'client', depends_on: [a.id], claim: true },
      100,
    );
    bump(db, team.id, nick.id, 'spine', 200); // A's goal moved after B claimed
    const warnings = staleLaneWarnings(db, team.id, 'revive');
    const dep = warnings.find((w) => w.kind === 'stale_dependency');
    expect(dep).toMatchObject({
      kind: 'stale_dependency',
      subject: b.id,
      with: a.id,
      owner: 'stanley',
    });
  });

  it('onlyGoal scopes the scan to the just-deferred Goal (the directed push)', () => {
    const { db, team, nick } = seed();
    openLane(db, team.id, 'revive', 'stanley', { title: 'a', goal_id: 'spine', claim: true }, 100);
    openLane(db, team.id, 'revive', 'miley', { title: 'b', goal_id: 'other', claim: true }, 100);
    bump(db, team.id, nick.id, 'spine', 200);
    bump(db, team.id, nick.id, 'other', 200);
    // Scoped to `spine` → only stanley's lane, not miley's `other` lane.
    const scoped = staleLaneWarnings(db, team.id, 'revive', 'spine');
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.owner).toBe('stanley');
  });

  it('nothing is stale before any direction has changed', () => {
    const { db, team } = seed();
    openLane(db, team.id, 'revive', 'stanley', { title: 'a', goal_id: 'spine', claim: true }, 100);
    // no bumps at all — fast path returns []
    expect(staleLaneWarnings(db, team.id, 'revive')).toEqual([]);
  });
});
