import { makeEnvelope, type Goal } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { listGoals, nextGoal } from './goals.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  return { db, team, nick };
}

let mid = 0;
function declare(
  db: ReturnType<typeof seed>['db'],
  teamId: string,
  fromId: string,
  goal: { id: string; title: string; wave?: number | 'later'; depends_on?: string[] },
  ts = ++mid,
) {
  insertMessage(
    db,
    teamId,
    fromId,
    null,
    makeEnvelope({
      id: `g${ts}-${goal.id}`,
      team: 'revive',
      from: 'nick',
      to: { kind: 'team' },
      act: 'message',
      body: `[goal] ${goal.title}`,
      meta: { goal },
      ts,
    }),
  );
}

describe('listGoals (declared-Goal seam, ADR 048/084)', () => {
  it('reads Goals from team messages carrying meta.goal, latest declaration per id wins', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth', wave: 1 }, 10);
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth (renamed)', wave: 2 }, 20);
    const goals = listGoals(db, team.id, 'revive');
    expect(goals).toHaveLength(1);
    expect(goals[0]!.title).toBe('Auth (renamed)');
    expect(goals[0]!.wave).toBe(2);
    expect(goals[0]!.status).toBe('planned'); // no lanes joined yet
  });

  it('ignores ordinary team messages whose meta is not a Goal declaration', () => {
    const { db, team, nick } = seed();
    insertMessage(
      db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'm1',
        team: 'revive',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: 'hi',
        meta: { something: 'else' },
        ts: 5,
      }),
    );
    expect(listGoals(db, team.id, 'revive')).toHaveLength(0);
  });

  it('derives status from the lanes joined by goal_id (the pinned rule)', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'spine', title: 'Spine' });
    // one done + one active lane on the goal → in-flight (not all terminal).
    const done = openLane(db, team.id, 'revive', 'stanley', {
      title: 'a',
      goal_id: 'spine',
      claim: true,
    });
    updateLane(db, team.id, done.id, 'revive', { state: 'done' });
    const active = openLane(db, team.id, 'revive', 'stanley', {
      title: 'b',
      goal_id: 'spine',
      claim: true,
    });
    updateLane(db, team.id, active.id, 'revive', { state: 'active' });
    expect(listGoals(db, team.id, 'revive')[0]!.status).toBe('in-flight');
    // resolving the active lane → all terminal, ≥1 done → shipped.
    updateLane(db, team.id, active.id, 'revive', { state: 'done' });
    expect(listGoals(db, team.id, 'revive')[0]!.status).toBe('shipped');
  });
});

describe('nextGoal (ADR 049/084)', () => {
  const g = (
    id: string,
    status: Goal['status'],
    wave: Goal['wave'],
    depends_on: string[] = [],
  ): Goal => ({
    id,
    title: id,
    wave,
    depends_on,
    declared_by: 'nick',
    declared_at: 0,
    status,
  });

  it('picks the first planned Goal by wave', () => {
    expect(nextGoal([g('b', 'planned', 2), g('a', 'planned', 1)])!.id).toBe('a');
  });
  it('skips in-flight and shipped Goals', () => {
    expect(nextGoal([g('a', 'in-flight', 1), g('b', 'planned', 2)])!.id).toBe('b');
    expect(nextGoal([g('a', 'shipped', 1), g('b', 'planned', 2)])!.id).toBe('b');
  });
  it('skips a planned Goal still blocked by an unshipped dependency', () => {
    // b depends on a; a is not shipped → b is blocked, so nothing qualifies.
    expect(nextGoal([g('a', 'in-flight', 1), g('b', 'planned', 2, ['a'])])).toBeNull();
    // once a ships, b unblocks.
    expect(nextGoal([g('a', 'shipped', 1), g('b', 'planned', 2, ['a'])])!.id).toBe('b');
  });
  it('sorts later/undeclared waves last and returns null when nothing is planned', () => {
    expect(nextGoal([g('a', 'planned', 'later'), g('b', 'planned', 3)])!.id).toBe('b');
    expect(nextGoal([g('a', 'shipped', 1)])).toBeNull();
    expect(nextGoal([])).toBeNull();
  });
});
