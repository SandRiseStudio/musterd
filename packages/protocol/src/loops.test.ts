import { describe, expect, it } from 'vitest';
import { PolicySchema } from './credentials.js';
import { LoopsPolicySchema } from './loops.js';

describe('LoopsPolicySchema (ADR 191 / 199) — every loop off until opted in', () => {
  it('parse({}) yields review and dispatch off', () => {
    expect(LoopsPolicySchema.parse({})).toEqual({ review: false, dispatch: false, sweep: false });
  });

  it('team PolicySchema carries loops without breaking older stored policies', () => {
    const p = PolicySchema.parse({ allow_pre_issued_grants: true });
    expect(p.loops).toEqual({ review: false, dispatch: false, sweep: false });
  });

  it('rejects non-boolean review / dispatch', () => {
    expect(LoopsPolicySchema.safeParse({ review: 'yes' }).success).toBe(false);
    expect(LoopsPolicySchema.safeParse({ dispatch: 'yes' }).success).toBe(false);
  });

  it('accepts dispatch alone', () => {
    expect(LoopsPolicySchema.parse({ dispatch: true })).toEqual({
      review: false,
      dispatch: true,
      sweep: false,
    });
  });

  // ADR 229: the newest loop is dark on the same terms as its siblings — a team that has never heard
  // of the sweep must parse bit-identically to pre-229.
  it('accepts sweep alone, and leaves the older loops untouched', () => {
    expect(LoopsPolicySchema.parse({ sweep: true })).toEqual({
      review: false,
      dispatch: false,
      sweep: true,
    });
  });
});
