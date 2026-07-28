import { describe, expect, it } from 'vitest';
import type { Lane, LaneBoard, MemberSummary } from '@musterd/protocol';
import { memberColor } from './format';
import { invalidatesLanes, presentCount, roomEntries } from './workingOn';

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

function member(over: Partial<MemberSummary>): MemberSummary {
  return {
    name: 'miley',
    kind: 'agent',
    presence: 'online',
    activity: 'working',
    posture: 'working',
    state: null,
    last_status_at: null,
    ...over,
  } as MemberSummary;
}

describe('roomEntries', () => {
  it('is the roster, not the board — a member with no lane is still in the room', () => {
    const result = roomEntries([member({ name: 'a' }), member({ name: 'b' })], board([]));
    expect(result.map((r) => r.name)).toEqual(['a', 'b']);
    expect(result.every((r) => r.title === null && r.source === null)).toBe(true);
  });

  it('leaves offline members out — offline is the only absence (ADR 010)', () => {
    const result = roomEntries(
      [member({ name: 'here' }), member({ name: 'gone', presence: 'offline' })],
      board([]),
    );
    expect(result.map((r) => r.name)).toEqual(['here']);
  });

  it('prefers a claimed lane over a self-reported line, and says which it used', () => {
    const result = roomEntries(
      [member({ name: 'a', state: 'poking at it' })],
      board([lane({ owner_seat: 'a', title: 'ship it', state: 'active' })]),
    );
    expect(result[0]).toMatchObject({ title: 'ship it', source: 'lane', laneState: 'active' });
  });

  it('falls back to the status line, marked as reported rather than owned', () => {
    const result = roomEntries([member({ name: 'a', state: 'poking at it' })], board([]));
    expect(result[0]).toMatchObject({ title: 'poking at it', source: 'status', laneState: null });
  });

  // A board that has not arrived is not a board with nothing on it: the reel must still show the
  // room, or it blanks on every reconnect.
  it('still fills the reel when the lane board has not loaded', () => {
    const result = roomEntries([member({ name: 'a', state: 'poking at it' })], null);
    expect(result[0]).toMatchObject({ title: 'poking at it', source: 'status' });
  });

  it('orders lane owners, then reporters, then the quiet', () => {
    const result = roomEntries(
      [
        member({ name: 'quiet' }),
        member({ name: 'reporter', state: 'looking at logs', last_status_at: 5 }),
        member({ name: 'owner' }),
      ],
      board([lane({ owner_seat: 'owner' })]),
    );
    expect(result.map((r) => r.name)).toEqual(['owner', 'reporter', 'quiet']);
  });

  it('orders lane owners by lane recency, and the quiet alphabetically', () => {
    const result = roomEntries(
      [
        member({ name: 'zed' }),
        member({ name: 'old' }),
        member({ name: 'abe' }),
        member({ name: 'new' }),
      ],
      board([
        lane({ id: 'A', owner_seat: 'old', claimed_at: 100 }),
        lane({ id: 'B', owner_seat: 'new', claimed_at: 300 }),
      ]),
    );
    expect(result.map((r) => r.name)).toEqual(['new', 'old', 'abe', 'zed']);
  });

  it('shows the freshest of several lanes and counts the rest', () => {
    const result = roomEntries(
      [member({ name: 'a' })],
      board([
        lane({ id: 'A', owner_seat: 'a', title: 'stale', claimed_at: 1 }),
        lane({ id: 'B', owner_seat: 'a', title: 'fresh', claimed_at: 9 }),
        lane({ id: 'C', owner_seat: 'a', title: 'also', claimed_at: 5 }),
      ]),
    );
    expect(result[0]).toMatchObject({ title: 'fresh', moreLanes: 2 });
  });

  it('ignores lanes that are history rather than work', () => {
    const result = roomEntries(
      [member({ name: 'a' })],
      board([
        lane({ id: 'A', owner_seat: 'a', state: 'done' }),
        lane({ id: 'B', owner_seat: 'a', state: 'abandoned' }),
        lane({ id: 'C', owner_seat: null, state: 'active' }),
      ]),
    );
    expect(result[0]).toMatchObject({ title: null, source: null, moreLanes: 0 });
  });

  it('carries the identity hue the floor paints each member with', () => {
    const byName = new Map(
      roomEntries(
        [member({ name: 'stanley', kind: 'agent' }), member({ name: 'nick', kind: 'human' })],
        board([]),
      ).map((e) => [e.name, e]),
    );
    const agent = byName.get('stanley');
    const human = byName.get('nick');
    expect(agent!.color).toBe(memberColor('stanley', 'agent'));
    expect(human!.color).toBe(memberColor('nick', 'human'));
    // Agent hues live in 150°-280°, human hues wrap 320°-70° — the two families must not collide.
    expect(agent!.color).not.toBe(human!.color);
  });

  it('treats a blank status line as no line at all', () => {
    expect(roomEntries([member({ name: 'a', state: '   ' })], board([]))[0]!.source).toBeNull();
  });
});

describe('presentCount', () => {
  const member = (name: string, presence: MemberSummary['presence']): MemberSummary =>
    ({ name, kind: 'agent', presence }) as MemberSummary;

  it('counts everyone not offline', () => {
    expect(
      presentCount([member('a', 'online'), member('b', 'offline'), member('c', 'online')]),
    ).toBe(2);
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
