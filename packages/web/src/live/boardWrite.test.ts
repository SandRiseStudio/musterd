import { describe, expect, it } from 'vitest';
import type { Goal, Lane, LaneBoard, LaneResult, LaneWarning } from '@musterd/protocol';
import {
  applyLaneEcho,
  capColumn,
  filterLanes,
  groupByGoal,
  handoffPatch,
  laneActions,
  laneStates,
  movedLanes,
  UNOWNED,
} from './boardWrite';

const lane = (over: Partial<Lane> = {}): Lane => ({
  id: 'L1',
  team: 'revive',
  project: 'default',
  title: 'write the launch post',
  detail: null,
  owner_seat: null,
  role: null,
  surface_globs: [],
  depends_on: [],
  branch: null,
  goal_id: null,
  risk: [],
  merged: null,
  state: 'open',
  created_by: 'nick',
  created_at: 1,
  claimed_at: null,
  resolved_at: null,
  updated_at: 1,
  ...over,
});

describe('laneActions — the verb-legality table', () => {
  it('offers nothing to an observer (me = null), whatever the lane', () => {
    expect(laneActions(lane(), null)).toEqual([]);
    expect(laneActions(lane({ owner_seat: 'nick', state: 'active' }), null)).toEqual([]);
  });

  it('an unowned open lane offers exactly claim (owner_seat alone — the daemon flips open→claimed)', () => {
    const actions = laneActions(lane(), 'nick');
    expect(actions.map((a) => a.kind)).toEqual(['claim']);
    expect(actions[0]!.patch).toEqual({ owner_seat: 'nick' });
  });

  it("someone else's lane offers nothing — you never move a teammate's card", () => {
    expect(laneActions(lane({ owner_seat: 'stanley', state: 'claimed' }), 'nick')).toEqual([]);
    expect(laneActions(lane({ owner_seat: 'stanley', state: 'active' }), 'nick')).toEqual([]);
  });

  it('my claimed lane: start, hand off, ready, abandon (done became the two-stage entry, ADR 169)', () => {
    const actions = laneActions(lane({ owner_seat: 'nick', state: 'claimed' }), 'nick');
    expect(actions.map((a) => a.kind)).toEqual(['start', 'handoff', 'ready', 'abandon']);
    expect(actions.find((a) => a.kind === 'start')!.patch).toEqual({ state: 'active' });
  });

  it('my active lane: block, hand off, ready, abandon', () => {
    const actions = laneActions(lane({ owner_seat: 'nick', state: 'active' }), 'nick');
    expect(actions.map((a) => a.kind)).toEqual(['block', 'handoff', 'ready', 'abandon']);
    expect(actions.find((a) => a.kind === 'block')!.patch).toEqual({ state: 'blocked' });
    expect(actions.find((a) => a.kind === 'ready')!.patch).toEqual({ state: 'ready_for_review' });
  });

  it('my blocked lane: unblock, hand off, ready, abandon', () => {
    const actions = laneActions(lane({ owner_seat: 'nick', state: 'blocked' }), 'nick');
    expect(actions.map((a) => a.kind)).toEqual(['unblock', 'handoff', 'ready', 'abandon']);
    expect(actions.find((a) => a.kind === 'unblock')!.patch).toEqual({ state: 'active' });
    expect(actions.find((a) => a.kind === 'abandon')!.patch).toEqual({ state: 'abandoned' });
  });

  it("ready_for_review flips the verbs to the COUNTERPART: confirm + send back (ADR 169's one exception)", () => {
    const inReview = lane({ owner_seat: 'ada', state: 'ready_for_review' });
    const reviewer = laneActions(inReview, 'nick');
    expect(reviewer.map((a) => a.kind)).toEqual(['confirm', 'sendback']);
    expect(reviewer.find((a) => a.kind === 'confirm')!.patch).toEqual({ state: 'done' });
    expect(reviewer.find((a) => a.kind === 'sendback')!.patch).toEqual({ state: 'active' });
  });

  it('ready_for_review offers the owner only the degradation self-close + abandon (never a wedge)', () => {
    const mine = laneActions(lane({ owner_seat: 'nick', state: 'ready_for_review' }), 'nick');
    expect(mine.map((a) => a.kind)).toEqual(['done', 'abandon']);
    expect(mine.find((a) => a.kind === 'done')!.patch).toEqual({ state: 'done' });
  });

  it('ready_for_review offers an observer nothing', () => {
    expect(laneActions(lane({ owner_seat: 'ada', state: 'ready_for_review' }), null)).toEqual([]);
  });

  it('terminal lanes offer nothing, even to their owner', () => {
    expect(laneActions(lane({ owner_seat: 'nick', state: 'done' }), 'nick')).toEqual([]);
    expect(laneActions(lane({ owner_seat: 'nick', state: 'abandoned' }), 'nick')).toEqual([]);
  });

  it('handoffPatch transfers ownership to the picked seat', () => {
    expect(handoffPatch('izzo')).toEqual({ owner_seat: 'izzo' });
  });
});

describe('applyLaneEcho — the optimistic fold (the echo is the only copy the sender sees)', () => {
  const board = (lanes: Lane[], warnings: LaneWarning[] = []): LaneBoard => ({ lanes, warnings });
  const warning = (subject: string, withId = 'L9'): LaneWarning => ({
    kind: 'surface_overlap',
    subject,
    with: withId,
    owner: 'stanley',
    detail: 'overlap',
  });

  it('replaces an existing lane by id in place (stable order — no card jumping)', () => {
    const a = lane({ id: 'A', state: 'claimed', owner_seat: 'nick' });
    const b = lane({ id: 'B' });
    const echo: LaneResult = { lane: { ...a, state: 'active' }, warnings: [] };
    const out = applyLaneEcho(board([a, b]), echo);
    expect(out.lanes.map((l) => l.id)).toEqual(['A', 'B']);
    expect(out.lanes[0]!.state).toBe('active');
  });

  it('appends a newly created lane', () => {
    const out = applyLaneEcho(board([lane({ id: 'A' })]), {
      lane: lane({ id: 'NEW', state: 'claimed', owner_seat: 'nick' }),
      warnings: [],
    });
    expect(out.lanes.map((l) => l.id)).toEqual(['A', 'NEW']);
  });

  it("replaces the echoed lane's warnings and keeps everyone else's", () => {
    const out = applyLaneEcho(board([lane({ id: 'A' }), lane({ id: 'B' })], [warning('A'), warning('B')]), {
      lane: lane({ id: 'A', owner_seat: 'nick', state: 'claimed' }),
      warnings: [warning('A', 'L7')],
    });
    expect(out.warnings).toEqual([warning('B'), warning('A', 'L7')]);
  });

  it('clears stale warnings for the echoed lane when the fresh echo carries none', () => {
    const out = applyLaneEcho(board([lane({ id: 'A' })], [warning('A')]), {
      lane: lane({ id: 'A', state: 'done', owner_seat: 'nick' }),
      warnings: [],
    });
    expect(out.warnings).toEqual([]);
  });
});

describe('groupByGoal — the swimlane regroup (pure, no extra fetch)', () => {
  const goal = (id: string, title: string, status: Goal['status'] = 'in-flight'): Goal => ({
    id,
    title,
    wave: null,
    depends_on: [],
    declared_by: 'nick',
    declared_at: 1,
    status,
    epoch: 0,
  });

  it('one row per declared Goal in order, lanes attached by goal_id, "no goal" last', () => {
    const goals = [goal('g1', 'Ship the board'), goal('g2', 'Broadcast', 'planned')];
    const lanes = [
      lane({ id: 'A', goal_id: 'g2' }),
      lane({ id: 'B', goal_id: 'g1' }),
      lane({ id: 'C', goal_id: null }),
      lane({ id: 'D', goal_id: 'g1' }),
    ];
    const rows = groupByGoal(lanes, goals);
    expect(rows.map((r) => r.id)).toEqual(['g1', 'g2', null]);
    expect(rows[0]!.lanes.map((l) => l.id)).toEqual(['B', 'D']);
    expect(rows[0]!.status).toBe('in-flight');
    expect(rows[1]!.lanes.map((l) => l.id)).toEqual(['A']);
    expect(rows[2]!.title).toBe('no goal');
    expect(rows[2]!.lanes.map((l) => l.id)).toEqual(['C']);
  });

  it('a lane naming an undeclared goal gets its own row after the declared ones, before "no goal"', () => {
    const rows = groupByGoal([lane({ id: 'A', goal_id: 'ghost' }), lane({ id: 'B' })], [
      goal('g1', 'Real'),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['g1', 'ghost', null]);
    expect(rows[1]!.title).toBe('ghost');
    expect(rows[1]!.status).toBeNull();
  });

  it('declared Goals with no lanes keep their row (the plan is visible); an empty "no goal" is dropped', () => {
    const rows = groupByGoal([lane({ id: 'A', goal_id: 'g1' })], [goal('g1', 'Real'), goal('g2', 'Empty')]);
    expect(rows.map((r) => r.id)).toEqual(['g1', 'g2']);
    expect(rows[1]!.lanes).toEqual([]);
  });
});

describe('filterLanes — the member filter chips (empty selection = everyone)', () => {
  const lanes = [
    lane({ id: 'A', owner_seat: 'nick' }),
    lane({ id: 'B', owner_seat: 'izzo' }),
    lane({ id: 'C', owner_seat: null }),
    lane({ id: 'D', owner_seat: 'nick' }),
  ];

  it('an empty selection filters nothing', () => {
    expect(filterLanes(lanes, new Set())).toEqual(lanes);
  });

  it('selects one owner', () => {
    expect(filterLanes(lanes, new Set(['nick'])).map((l) => l.id)).toEqual(['A', 'D']);
  });

  it('multi-select unions owners', () => {
    expect(filterLanes(lanes, new Set(['izzo', 'nick'])).map((l) => l.id)).toEqual(['A', 'B', 'D']);
  });

  it('the UNOWNED sentinel selects ownerless lanes, and unions with named owners', () => {
    expect(filterLanes(lanes, new Set([UNOWNED])).map((l) => l.id)).toEqual(['C']);
    expect(filterLanes(lanes, new Set([UNOWNED, 'izzo'])).map((l) => l.id)).toEqual(['B', 'C']);
  });
});

describe('capColumn — the column DOM guardrail', () => {
  const items = Array.from({ length: 40 }, (_, i) => i);

  it('shows everything when under the cap', () => {
    expect(capColumn([1, 2, 3], 30, false)).toEqual({ shown: [1, 2, 3], hidden: 0 });
  });

  it('caps and counts the rest when over', () => {
    const { shown, hidden } = capColumn(items, 30, false);
    expect(shown).toHaveLength(30);
    expect(hidden).toBe(10);
  });

  it('expanded shows everything', () => {
    expect(capColumn(items, 30, true)).toEqual({ shown: items, hidden: 0 });
  });
});

/**
 * The board's motion, which used to be a ref read mid-render and therefore untestable. Each case is
 * a rule someone decided, not an implementation detail: ADR 169 says the flourish is earned by a
 * counterpart's confirmation, and nothing else on the board celebrates itself.
 */
describe('movedLanes', () => {
  it('lands a card that changed column, and leaves a settled one alone', () => {
    const before = laneStates([lane({ id: 'a', state: 'open' }), lane({ id: 'b', state: 'active' })]);
    const now = [lane({ id: 'a', state: 'claimed' }), lane({ id: 'b', state: 'active' })];
    const { landed } = movedLanes(before, now);
    expect([...landed]).toEqual(['a']);
  });

  it('lands a card that is new to the board', () => {
    const { landed } = movedLanes(laneStates([]), [lane({ id: 'fresh', state: 'open' })]);
    expect([...landed]).toEqual(['fresh']);
  });

  it('flourishes a VERIFIED close and not an unverified one (ADR 169)', () => {
    const before = laneStates([lane({ id: 'v', state: 'active' }), lane({ id: 'u', state: 'active' })]);
    const { landed, flourished } = movedLanes(before, [
      lane({ id: 'v', state: 'done', verified: true }),
      lane({ id: 'u', state: 'done', verified: false }),
    ]);
    expect([...flourished]).toEqual(['v']);
    // Both still MOVED — the unverified close animates in, it just gets no celebration.
    expect([...landed].sort()).toEqual(['u', 'v']);
  });

  it('does not flourish a lane that was already done before the diff', () => {
    // `was === undefined` is a lane the previous snapshot never saw; arriving already-done is not a
    // close anyone watched happen, so it lands without the beat.
    const { flourished } = movedLanes(laneStates([]), [
      lane({ id: 'x', state: 'done', verified: true }),
    ]);
    expect([...flourished]).toEqual([]);
  });

  it('gives no beat for merely reaching review', () => {
    const before = laneStates([lane({ id: 'r', state: 'active' })]);
    const { landed, flourished } = movedLanes(before, [
      lane({ id: 'r', state: 'ready_for_review', verified: true }),
    ]);
    expect([...landed]).toEqual(['r']);
    expect([...flourished]).toEqual([]);
  });
});
