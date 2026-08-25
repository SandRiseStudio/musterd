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

describe('scope is the only wire token (ADR 296 tier 2 mirror dropped, epoch 16)', () => {
  it('parses a lane on the canonical token', () => {
    const lane = LaneSchema.parse({ ...base, scope: ['packages/server/**'] });
    expect(lane.scope).toEqual(['packages/server/**']);
  });

  it('does not populate the dropped mirror key on the parsed shape', () => {
    const lane = LaneSchema.parse({ ...base, scope: ['packages/server/**'] });
    expect('surface_globs' in lane).toBe(false);
  });

  it('ignores a stray legacy key rather than rejecting (unknown keys strip)', () => {
    const lane = LaneSchema.parse({
      ...base,
      scope: ['docs/**'],
      surface_globs: ['packages/web/**'],
    });
    expect(lane.scope).toEqual(['docs/**']);
    expect('surface_globs' in lane).toBe(false);
  });

  it('OpenLane accepts the canonical token', () => {
    const open = OpenLaneSchema.parse({ title: 't', scope: ['docs/**'] });
    expect(open.scope).toEqual(['docs/**']);
  });

  it('OpenLane no longer adopts the legacy token — a legacy-only body reads as scopeless', () => {
    const open = OpenLaneSchema.parse({ title: 't', surface_globs: ['docs/**'] });
    expect(open.scope).toBeUndefined();
  });

  it('UpdateLane leaves scope absent when the key is not sent (no accidental clearing)', () => {
    const patch = UpdateLaneSchema.parse({ state: 'active' });
    expect(patch.scope).toBeUndefined();
  });
});
