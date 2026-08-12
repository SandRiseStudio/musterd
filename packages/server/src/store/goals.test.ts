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
  goal: {
    id: string;
    title: string;
    story?: string;
    wave?: number | 'later';
    depends_on?: string[];
  },
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

describe('Goal.story (goals-front-door design)', () => {
  it('story rides the declaration and re-declaration amends it', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'g1', title: 'Auth', story: 'first words' });
    declare(db, team.id, nick.id, { id: 'g1', title: 'Auth', story: 'better words' });
    const goals = listGoals(db, team.id, 'revive');
    expect(goals[0]!.story).toBe('better words');
  });
  it('story is absent when never declared', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'g1', title: 'Auth' });
    expect(listGoals(db, team.id, 'revive')[0]!.story).toBeUndefined();
  });
});

describe('listGoals (declared-Goal seam, ADR 048/084)', () => {
  it('reads Goals from team messages carrying meta.goal, latest declaration per id wins', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth' }, 10);
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth (renamed)', wave: 'later' }, 20);
    const goals = listGoals(db, team.id, 'revive');
    expect(goals).toHaveLength(1);
    expect(goals[0]!.title).toBe('Auth (renamed)');
    expect(goals[0]!.wave).toBe('later');
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

describe('listGoals — plan epoch + defer re-sequencing (ADR 111, inc3)', () => {
  it('a Goal with no direction-changing acts is on epoch 0 and unshelved', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth' }, 10);
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.epoch).toBe(0);
    expect(goal.wave).toBeNull();
  });

  it('a defer shelves the Goal and bumps epoch', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth' }, 10);
    signal(db, team.id, nick.id, 'defer', { goal_id: 'auth' }, 20);
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.wave).toBe('later');
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

  it('the newest wave assertion wins — a re-declaration un-shelves what a defer shelved', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth' }, 10);
    signal(db, team.id, nick.id, 'defer', { goal_id: 'auth' }, 20);
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth' }, 30);
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.wave).toBeNull(); // re-declaration (ts 30) is newer than the defer (ts 20)
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
    expect(goal.wave).toBe('later');
  });

  it('shelving changes what nextGoal picks (defer actually moves the plan)', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'a', title: 'A' }, 10);
    declare(db, team.id, nick.id, { id: 'b', title: 'B' }, 11);
    expect(nextGoal(listGoals(db, team.id, 'revive'))!.id).toBe('b'); // newest declaration leads
    // shelve B → A is what is left.
    signal(db, team.id, nick.id, 'defer', { goal_id: 'b' }, 20);
    expect(nextGoal(listGoals(db, team.id, 'revive'))!.id).toBe('a');
  });

  it('a signal that arrives before its Goal declaration is still folded (order-independent)', () => {
    const { db, team, nick } = seed();
    signal(db, team.id, nick.id, 'defer', { goal_id: 'auth' }, 10);
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth' }, 20);
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.epoch).toBe(1);
    expect(goal.wave).toBeNull(); // declaration (ts 20) is newer than the defer (ts 10)
  });

  it('ignores defer/steer naming an undeclared Goal (no phantom Goals)', () => {
    const { db, team, nick } = seed();
    signal(db, team.id, nick.id, 'defer', { goal_id: 'ghost' }, 10);
    expect(listGoals(db, team.id, 'revive')).toHaveLength(0);
  });
});

/**
 * ADR 257 migration. The journal is append-only: declarations written before the numeric wave was
 * retired still carry `wave: 7`. If the read path ever stops accepting those rows they fail
 * `GoalDeclareMetaSchema.parse` and the Goal silently disappears from the board — which is a worse
 * outcome than the field we set out to remove.
 */
describe('listGoals — pre-257 journals with numeric waves (migration)', () => {
  it('a legacy numeric wave still parses: the Goal survives, and reads as unshelved', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'legacy', title: 'Legacy', wave: 7 }, 10);
    const goals = listGoals(db, team.id, 'revive');
    expect(goals).toHaveLength(1); // the whole point — it did not drop out of the projection
    expect(goals[0]!.wave).toBeNull(); // readable, but inert
  });

  it('a legacy numeric wave orders nothing — recency decides, not the old rank', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'old-wave-1', title: 'Old', wave: 1 }, 10);
    declare(db, team.id, nick.id, { id: 'new-unwaved', title: 'New' }, 20);
    // Pre-257 this returned old-wave-1 forever: wave 1 beat the unset wave of every newer Goal.
    expect(nextGoal(listGoals(db, team.id, 'revive'))!.id).toBe('new-unwaved');
  });

  it('a legacy defer carrying meta.wave replays as a plain shelving', () => {
    const { db, team, nick } = seed();
    declare(db, team.id, nick.id, { id: 'auth', title: 'Auth', wave: 1 }, 10);
    signal(db, team.id, nick.id, 'defer', { goal_id: 'auth', wave: 9 }, 20);
    const goal = listGoals(db, team.id, 'revive')[0]!;
    expect(goal.wave).toBe('later'); // "move it to 9" now reads as what defer always meant
    expect(goal.epoch).toBe(1); // the history it accrued is untouched
  });
});

describe('nextGoal (ADR 049/084, reordered by ADR 257)', () => {
  const g = (
    id: string,
    status: Goal['status'],
    declared_at: number,
    depends_on: string[] = [],
    wave: Goal['wave'] = null,
  ): Goal => ({
    id,
    title: id,
    wave,
    depends_on,
    declared_by: 'nick',
    declared_at,
    status,
    epoch: 0,
  });

  it('picks the most recently declared planned Goal', () => {
    expect(nextGoal([g('old', 'planned', 1), g('new', 'planned', 2)])!.id).toBe('new');
  });
  it('skips in-flight and shipped Goals', () => {
    expect(nextGoal([g('a', 'in-flight', 2), g('b', 'planned', 1)])!.id).toBe('b');
    expect(nextGoal([g('a', 'shipped', 2), g('b', 'planned', 1)])!.id).toBe('b');
  });
  it('skips a planned Goal still blocked by an unshipped dependency', () => {
    // b depends on a; a is not shipped → b is blocked, so nothing qualifies.
    expect(nextGoal([g('a', 'in-flight', 1), g('b', 'planned', 2, ['a'])])).toBeNull();
    // once a ships, b unblocks.
    expect(nextGoal([g('a', 'shipped', 1), g('b', 'planned', 2, ['a'])])!.id).toBe('b');
  });
  it('a dependency still outranks recency — the hard filter beats the preference', () => {
    // The newest Goal is blocked; the older unblocked one is what you can actually start.
    const goals = [g('dep', 'planned', 1), g('blocked', 'planned', 9, ['dep'])];
    expect(nextGoal(goals)!.id).toBe('dep');
  });
  it('a shelved Goal sorts last however recent, and null when nothing is planned', () => {
    expect(nextGoal([g('shelved', 'planned', 9, [], 'later'), g('live', 'planned', 1)])!.id).toBe(
      'live',
    );
    expect(nextGoal([g('a', 'shipped', 1)])).toBeNull();
    expect(nextGoal([])).toBeNull();
  });
});
