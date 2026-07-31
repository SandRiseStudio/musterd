import { describe, expect, it } from 'vitest';
import { PolicySchema } from './credentials.js';
import { LoopsPolicySchema } from './loops.js';

describe('LoopsPolicySchema (ADR 191 / 199) — every loop off until opted in', () => {
  it('parse({}) yields review and dispatch off', () => {
    expect(LoopsPolicySchema.parse({})).toEqual({ review: false, dispatch: false });
  });

  it('team PolicySchema carries loops without breaking older stored policies', () => {
    const p = PolicySchema.parse({ allow_pre_issued_grants: true });
    expect(p.loops).toEqual({ review: false, dispatch: false });
  });

  it('rejects non-boolean review / dispatch', () => {
    expect(LoopsPolicySchema.safeParse({ review: 'yes' }).success).toBe(false);
    expect(LoopsPolicySchema.safeParse({ dispatch: 'yes' }).success).toBe(false);
  });

  it('accepts dispatch alone', () => {
    expect(LoopsPolicySchema.parse({ dispatch: true })).toEqual({
      review: false,
      dispatch: true,
    });
  });
});
