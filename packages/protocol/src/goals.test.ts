import { describe, expect, it } from 'vitest';
import { DeclareGoalSchema, GoalDeclareMetaSchema, GoalSchema } from './goals.js';
import { LaneWarningSchema } from './lanes.js';

describe('story on Goal (goals-front-door design)', () => {
  it('accepts an optional trimmed story on declare, caps at 140', () => {
    const meta = GoalDeclareMetaSchema.parse({
      goal: { id: 'g1', title: 'Native harness', story: '  the daemon becomes its own harness  ' },
    });
    expect(meta.goal.story).toBe('the daemon becomes its own harness');
    expect(() =>
      DeclareGoalSchema.parse({ id: 'g1', title: 't', story: 'x'.repeat(141) }),
    ).toThrow();
  });
  it('GoalSchema carries story through the read projection', () => {
    const g = GoalSchema.parse({
      id: 'g1',
      title: 't',
      wave: null,
      depends_on: [],
      declared_by: 'nick',
      declared_at: 1,
      status: 'planned',
      epoch: 0,
      story: 'plain words',
    });
    expect(g.story).toBe('plain words');
  });
});

describe('no_goal warning kind', () => {
  it('parses', () => {
    const w = LaneWarningSchema.parse({
      kind: 'no_goal',
      subject: 'L1',
      with: 'g1',
      owner: null,
      detail: 'on no goal — link it: lane_update {goal_id}',
    });
    expect(w.kind).toBe('no_goal');
  });
});
