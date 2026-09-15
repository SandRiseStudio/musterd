import { describe, expect, it } from 'vitest';
import {
  WireShapeError,
  askSpeciesOf,
  askTierOf,
  readAuditResponse,
  readLaneBoard,
  readLaneResult,
  readMemberSummary,
  readReport,
  readSeedList,
  readWorkingHours,
} from './guards.js';
import { MemberSummarySchema } from './member.js';
import { WorkingHoursSchema } from './working-hours.js';

const row = {
  id: '01M',
  team: 'revive',
  name: 'miley',
  kind: 'agent',
  created_at: 1,
  presence: 'online',
};

/**
 * The drift falsifier (see the file doc on `guards.ts`): the guard and the schema are two readers
 * of one contract, so every corpus row below is fed to BOTH and their verdicts compared. A field
 * added to `MemberSummarySchema` without a matching branch in `readMemberSummary` fails here.
 */
const corpus: unknown[] = [
  row,
  { ...row, role: 'frontend', roles: ['frontend', 'design'], lifecycle: 'session' },
  { ...row, lifecycle_until: 99, hue: 212, slack_user_id: 'U1' },
  { ...row, hue: null, slack_user_id: null, state: null, last_status_at: null },
  { ...row, availability: { status: 'away', until: 5 } },
  { ...row, availability: { status: 'available' } },
  { ...row, availability: null },
  { ...row, activity: 'idle' }, // legacy spelling, normalized to `active`
  { ...row, activity: 'working', posture: 'idle' },
  { ...row, posture: 'away', offline_reason: 'session_ended' },
  { ...row, offline_reason: null },
  { ...row, reclaimable: true, wakeable: false, wakeability: 'enrolled_host_stale' },
  { ...row, resumable_at: 12, quiescence: { state: 'quiet', quiet_for_ms: 10, source: 'audit' } },
  { ...row, quiescence: { state: 'unknown', quiet_for_ms: null, source: 'harness' } },
  {
    ...row,
    presences: [
      { surface: 'cli', status: 'online', last_seen_at: 3 },
      {
        surface: 'claude-code',
        status: 'away',
        last_seen_at: 4,
        provenance: 'wake',
        workspace: '/w',
        driver: 'nick',
        model: 'claude-opus-5',
        build: 'abc',
        epoch: 7,
        wake_lease: 'lease',
        node: 'n1',
        node_label: 'laptop',
      },
    ],
  },
  {
    ...row,
    working_hours: {
      timezone: 'Europe/London',
      days: ['mon', 'tue'],
      start: '09:00',
      end: '17:00',
    },
  },
  { ...row, working_hours: null },
  {
    ...row,
    capabilities: {
      is_admin: false,
      can_flag_urgent: true,
      can_observe: true,
      can_message: 'team',
      visibility_level: 'team',
      tool_allowlist: [],
      declared_resource_scopes: ['repo'],
    },
  },
  { ...row, account_status: 'active' },
  // Rejections — each is a row this build cannot read, and `unreadable` must count it.
  { ...row, kind: 'daemon' }, // a kind from the daemon's future (ADR 232's real case)
  { ...row, presence: 'lurking' },
  { ...row, posture: 'brooding' },
  { ...row, offline_reason: 'bored' },
  { ...row, activity: 'thinking' },
  { ...row, wakeability: 'enrolled_singing' },
  { ...row, hue: 360 },
  { ...row, hue: 1.5 },
  { ...row, lifecycle: 'eternal' },
  { ...row, roles: ['a', 2] },
  { ...row, created_at: 'yesterday' },
  { ...row, availability: { status: 'napping' } },
  { ...row, presences: [{ surface: 'holodeck', status: 'online', last_seen_at: 1 }] },
  { ...row, quiescence: { state: 'busy', quiet_for_ms: 'a while', source: 'audit' } },
  {
    ...row,
    working_hours: { timezone: 'Mars/Olympus', days: ['mon'], start: '09:00', end: '17:00' },
  },
  {
    ...row,
    working_hours: { timezone: 'UTC', days: ['mon', 'mon'], start: '09:00', end: '17:00' },
  },
  { ...row, working_hours: { timezone: 'UTC', days: [], start: '09:00', end: '17:00' } },
  { ...row, working_hours: { timezone: 'UTC', days: ['mon'], start: '17:00', end: '09:00' } },
  { ...row, working_hours: { timezone: 'UTC', days: ['mon'], start: '9:00', end: '17:00' } },
  { ...row, capabilities: { is_admin: false } },
  { ...row, account_status: 'retired' },
  'not a row',
  null,
  [],
];

describe('readMemberSummary matches MemberSummarySchema', () => {
  for (const [i, input] of corpus.entries()) {
    it(`agrees on corpus row ${i}`, () => {
      const schema = MemberSummarySchema.safeParse(input);
      const guard = readMemberSummary(input);
      expect(guard === null).toBe(!schema.success);
      if (schema.success) expect(guard).toEqual(schema.data);
    });
  }

  it('normalizes the legacy activity and posture spellings the schema transforms', () => {
    const parsed = readMemberSummary({ ...row, activity: 'idle', posture: 'idle' });
    expect(parsed?.activity).toBe('active');
    expect(parsed?.posture).toBe('active');
  });

  it('leaves an absent optional absent rather than writing undefined', () => {
    expect(Object.keys(readMemberSummary(row) ?? {})).not.toContain('hue');
  });
});

describe('readWorkingHours matches WorkingHoursSchema', () => {
  const hours = { timezone: 'Europe/London', days: ['mon', 'fri'], start: '09:00', end: '17:30' };

  it('accepts what the schema accepts', () => {
    expect(readWorkingHours(hours)).toEqual(WorkingHoursSchema.parse(hours));
  });

  it('reads absent as null, and refuses a value that is present but not a schedule', () => {
    expect(readWorkingHours(undefined)).toBeNull();
    expect(readWorkingHours(null)).toBeNull();
    expect(() => readWorkingHours({ ...hours, timezone: 'Mars/Olympus' })).toThrow(WireShapeError);
    expect(() => readWorkingHours({ ...hours, end: '08:00' })).toThrow(WireShapeError);
  });
});

describe('ask meta', () => {
  it('reads the species and tier it knows, and nothing else', () => {
    expect(askSpeciesOf('approve')).toBe('approve');
    expect(askTierOf('blocking')).toBe('blocking');
    expect(askSpeciesOf('cajole')).toBeUndefined();
    expect(askTierOf(undefined)).toBeUndefined();
  });
});

const seed = {
  id: 's1',
  team: 'revive',
  relay_id: 'C1/1',
  source: 'slack',
  body: 'an idea',
  captured_at: 1,
  slack_user_id: 'U1',
  submitted_by: 'nick',
  state: 'open',
  explorer: null,
  thread: [],
  final_brief: null,
  conclusion: null,
  linked_lane_id: null,
  promotion: null,
  completed_at: null,
  created_at: 1,
  updated_at: 2,
};

describe('response readers', () => {
  it('fills the lane defaults an older daemon omits', () => {
    const board = readLaneBoard({ lanes: [{ id: 'l1', state: 'open' }], warnings: [] });
    expect(board.lanes[0]).toMatchObject({
      risk: [],
      stakes: 'normal',
      stakes_provenance: 'declared',
      merged: null,
    });
  });

  it('keeps the values a newer daemon does send', () => {
    const board = readLaneBoard({
      lanes: [{ id: 'l1', state: 'done', risk: ['cost'], stakes: 'high', merged: { pr: 1 } }],
      warnings: [],
    });
    expect(board.lanes[0]).toMatchObject({ risk: ['cost'], stakes: 'high', merged: { pr: 1 } });
  });

  it('passes a field this build predates straight through rather than dropping the page', () => {
    const board = readLaneBoard({
      lanes: [{ id: 'l1', state: 'open', mood: 'sunny' }],
      warnings: [],
    });
    expect((board.lanes[0] as unknown as { mood: string }).mood).toBe('sunny');
  });

  it('refuses a response that is not the shape its endpoint promises', () => {
    expect(() => readLaneBoard({ lanes: 'nope', warnings: [] })).toThrow(WireShapeError);
    expect(() => readLaneResult({ warnings: [] })).toThrow(WireShapeError);
    expect(() => readAuditResponse({})).toThrow(WireShapeError);
    expect(() => readSeedList({ seeds: null })).toThrow(WireShapeError);
    expect(() => readReport({ team: 'revive', goals: [] })).toThrow(WireShapeError);
  });

  it('refuses a Seed row that is not a Seed — the tray never trusted the body wholesale', () => {
    expect(() => readSeedList({ seeds: [{ id: 'only-an-id' }] })).toThrow(WireShapeError);
  });

  it('accepts a Seed whose `source` this build predates (ADR 373 inc 2 widens the set)', () => {
    expect(readSeedList({ seeds: [{ ...seed, source: 'repo' }] })).toHaveLength(1);
  });

  it('reads the shapes it does promise', () => {
    expect(readAuditResponse({ audit: [] }).audit).toEqual([]);
    expect(readSeedList({ seeds: [] })).toEqual([]);
    expect(readSeedList({ seeds: [seed] })).toEqual([seed]);
    expect(readLaneResult({ lane: { id: 'l1' }, warnings: [] }).warnings).toEqual([]);
    expect(readReport({ team: 'revive', goals: [], blocked: [] }).team).toBe('revive');
  });
});
