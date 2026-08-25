import { describe, expect, it } from 'vitest';
import { LaneSchema, OpenLaneSchema, UpdateLaneSchema } from './lanes.js';

const base = {
  id: '01X',
  team: 't',
  project: 'p',
  title: 'x',
  detail: '',
  owner_seat: null,
  role: null,
  depends_on: [],
  branch: null,
  goal_id: null,
  risk: [],
  stakes: 'normal',
  state: 'claimed',
  created_by: 'izzo',
  created_at: 1,
  claimed_at: null,
  resolved_at: null,
  updated_at: 1,
};

describe('surface_globs → scope (ADR 296 tier 2)', () => {
  it('parses a legacy lane (surface_globs only) and adopts it as scope', () => {
    const lane = LaneSchema.parse({ ...base, surface_globs: ['packages/web/**'] });
    expect(lane.scope).toEqual(['packages/web/**']);
  });

  it('parses a current lane (scope only) and mirrors the legacy key for one-epoch skew', () => {
    const lane = LaneSchema.parse({ ...base, scope: ['packages/server/**'] });
    expect(lane.scope).toEqual(['packages/server/**']);
    // A client one epoch behind still requires `surface_globs`; the parsed shape carries it so a
    // daemon serializing this lane never strands that client.
    expect(lane.surface_globs).toEqual(['packages/server/**']);
  });

  it('scope wins when both keys arrive, and the mirror is normalized to it', () => {
    const lane = LaneSchema.parse({
      ...base,
      scope: ['docs/**'],
      surface_globs: ['packages/web/**'],
    });
    expect(lane.scope).toEqual(['docs/**']);
    expect(lane.surface_globs).toEqual(['docs/**']);
  });

  it('OpenLane accepts the canonical token', () => {
    const open = OpenLaneSchema.parse({ title: 't', scope: ['docs/**'] });
    expect(open.scope).toEqual(['docs/**']);
  });

  it('OpenLane adopts the legacy token from an old client', () => {
    const open = OpenLaneSchema.parse({ title: 't', surface_globs: ['docs/**'] });
    expect(open.scope).toEqual(['docs/**']);
  });

  it('UpdateLane adopts the legacy token from an old client', () => {
    const patch = UpdateLaneSchema.parse({ surface_globs: ['docs/**'] });
    expect(patch.scope).toEqual(['docs/**']);
  });

  it('UpdateLane leaves scope absent when neither key is sent (no accidental clearing)', () => {
    const patch = UpdateLaneSchema.parse({ state: 'active' });
    expect(patch.scope).toBeUndefined();
  });
});
