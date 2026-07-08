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

/** A `defer` (or goal-scoped `steer`) act naming a Goal — the direction-changing signals inc3 folds. */
function signal(
  db: ReturnType<typeof seed>['db'],
  teamId: string,
  fromId: string,
  act: 'defer' | 'steer',
  meta: { goal_id?: string; wave?: number | 'later' },
  ts = ++mid,
) {
  insertMessage(
    db,
    teamId,
    fromId,
    null,
    makeEnvelope({
      id: `s${ts}-${act}`,
      team: 'revive',
      from: 'nick',
      to: { kind: 'team' },
      act,
      body: `[${act}]`,
      meta,
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

describe('listGoals — plan epoch + defer re-sequencing (ADR 109, inc3)', () => {
  it('a Goal with no direction-changing acts is on epoch 0 with its declared wave', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth', wave: 3 }, 10);
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.epoch).toBe(0);
    expect(goal.wave).toBe(3);
  });

  it('a defer re-sequences the effective wave (the plan mutation, defer gets teeth) and bumps epoch', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth', wave: 1 }, 10);
    signal(db, team.id, nick.id, 'defer', { goal_id: 'auth', wave: 9 }, 20);
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.wave).toBe(9); // the defer's wave overrode the declared 1
    expect(goal.epoch).toBe(1);
  });

  it('a defer with no wave (or "later") sends the Goal to the back and still counts', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth', wave: 1 }, 10);
    signal(db, team.id, nick.id, 'defer', { goal_id: 'auth' }, 20);
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.wave).toBe('later');
    expect(goal.epoch).toBe(1);
  });

  it('the newest wave assertion wins — a later re-declaration overrides an earlier defer', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth', wave: 1 }, 10);
    signal(db, team.id, nick.id, 'defer', { goal_id: 'auth', wave: 9 }, 20);
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth', wave: 2 }, 30);
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.wave).toBe(2); // re-declaration (ts 30) is newer than the defer (ts 20)
    expect(goal.epoch).toBe(1); // ...but the accrued epoch survives the re-declaration
  });

  it('counts both defer and goal-scoped steer toward the epoch; a goal-less steer does not', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth', wave: 1 }, 10);
    signal(db, team.id, nick.id, 'steer', { goal_id: 'auth' }, 20);
    signal(db, team.id, nick.id, 'defer', { goal_id: 'auth', wave: 5 }, 30);
    signal(db, team.id, nick.id, 'steer', {}, 40); // no goal named → not a plan epoch bump
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.epoch).toBe(2);
    expect(goal.wave).toBe(5);
  });

  it('re-sequencing changes what nextGoal picks (defer actually moves the plan)', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'a', title: 'A', wave: 1 }, 10);
    declare(db, team.id, nick.id, { id: 'b', title: 'B', wave: 2 }, 11);
    expect(nextGoal(listGoals(db, team.id, 'revive'))!.id).toBe('a');
    // defer A to the back → B is now first.
    signal(db, team.id, nick.id, 'defer', { goal_id: 'a' }, 20);
    expect(nextGoal(listGoals(db, team.id, 'revive'))!.id).toBe('b');
  });

  it('a signal that arrives before its Goal declaration is still folded (order-independent)', () => {
    const { db, team, nick } = seed();
    signal(db, team.id, nick.id, 'defer', { goal_id: 'auth', wave: 7 }, 10);
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth', wave: 1 }, 20);
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.epoch).toBe(1);
    expect(goal.wave).toBe(1); // declaration (ts 20) is newer than the defer (ts 10)
  });

  it('ignores defer/steer naming an undeclared Goal (no phantom Goals)', () => {
    const { db, team, nick } = seed();
    signal(db, team.id, nick.id, 'defer', { goal_id: 'ghost', wave: 1 }, 10);
    expect(listGoals(db, team.id, 'revive')).toHaveLength(0);
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
    epoch: 0,
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
