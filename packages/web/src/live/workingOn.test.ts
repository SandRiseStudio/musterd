import { describe, expect, it } from 'vitest';
import type { Lane, LaneBoard, MemberSummary } from '@musterd/protocol';
import { invalidatesLanes, presentCount, workingOn } from './workingOn';

function lane(over: Partial<Lane>): Lane {
  return {
    id: 'L1',
    team: 'revive',
    project: 'default',
    title: 'a lane',
    detail: null,
    owner_seat: 'miley',
    role: null,
    surface_globs: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    state: 'claimed',
    created_by: 'miley',
    created_at: 1,
    claimed_at: 1,
    resolved_at: null,
    updated_at: 1,
    ...over,
  } as Lane;
}
const board = (lanes: Lane[]): LaneBoard => ({ lanes, warnings: [] });

describe('workingOn', () => {
  it('returns nothing when the board has not loaded', () => {
    expect(workingOn(null, 3)).toEqual([]);
  });

  it('keeps only owned, in-flight lanes', () => {
    const result = workingOn(
      board([
        lane({ id: 'A', state: 'claimed' }),
        lane({ id: 'B', state: 'active' }),
        lane({ id: 'C', state: 'blocked' }),
        lane({ id: 'D', state: 'done' }),
        lane({ id: 'E', state: 'abandoned' }),
        lane({ id: 'F', state: 'claimed', owner_seat: null }),
      ]),
      10,
    );
    expect(result.map((r) => r.id)).toEqual(['A', 'B', 'C']);
  });

  it('orders most recently claimed first', () => {
    const result = workingOn(
      board([
        lane({ id: 'old', claimed_at: 100 }),
        lane({ id: 'new', claimed_at: 300 }),
        lane({ id: 'mid', claimed_at: 200 }),
      ]),
      10,
    );
    expect(result.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('falls back to updated_at when a lane has never been claimed', () => {
    const result = workingOn(
      board([
        lane({ id: 'claimed', claimed_at: 100, updated_at: 100 }),
        lane({ id: 'unclaimed-but-active', claimed_at: null, updated_at: 500 }),
      ]),
      10,
    );
    expect(result[0]!.id).toBe('unclaimed-but-active');
  });

  it('caps at the limit', () => {
    const lanes = [1, 2, 3, 4, 5].map((n) => lane({ id: `L${n}`, claimed_at: n }));
    expect(workingOn(board(lanes), 2).map((r) => r.id)).toEqual(['L5', 'L4']);
  });

  it('projects only what the overlay renders', () => {
    expect(workingOn(board([lane({ id: 'A', title: 'ship it', owner_seat: 'stanley' })]), 1)).toEqual(
      [{ id: 'A', title: 'ship it', owner: 'stanley', state: 'claimed' }],
    );
  });
});

describe('presentCount', () => {
  const member = (name: string, presence: MemberSummary['presence']): MemberSummary =>
    ({ name, kind: 'agent', presence }) as MemberSummary;

  it('counts everyone not offline', () => {
    expect(presentCount([member('a', 'online'), member('b', 'offline'), member('c', 'online')])).toBe(
      2,
    );
  });

  it('is zero for an empty roster', () => {
    expect(presentCount([])).toBe(0);
  });
});

describe('invalidatesLanes', () => {
  it('is true for lane events', () => {
    expect(invalidatesLanes({ act: 'message', meta: { lane_claim: { lane: 'L1' } } })).toBe(true);
    expect(invalidatesLanes({ act: 'message', meta: { lane_open: { lane: 'L1' } } })).toBe(true);
    expect(invalidatesLanes({ act: 'message', meta: { lane_resolve: { lane: 'L1' } } })).toBe(true);
  });

  // The perf claim, asserted rather than assumed: ordinary chatter must never trigger a fetch.
  it('is false for ordinary acts', () => {
    expect(invalidatesLanes({ act: 'status_update', meta: null })).toBe(false);
    expect(invalidatesLanes({ act: 'ask', meta: { species: 'consult' } })).toBe(false);
    expect(invalidatesLanes({ act: 'handoff', meta: null })).toBe(false);
  });
});
