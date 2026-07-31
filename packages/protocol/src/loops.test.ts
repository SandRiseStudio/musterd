import { describe, expect, it } from 'vitest';
import { PolicySchema } from './credentials.js';
import { LoopsPolicySchema } from './loops.js';

describe('LoopsPolicySchema (ADR 191) — every loop off until opted in', () => {
  it('parse({}) yields review off', () => {
    expect(LoopsPolicySchema.parse({})).toEqual({ review: false });
  });

  it('team PolicySchema carries loops without breaking older stored policies', () => {
    const p = PolicySchema.parse({ allow_pre_issued_grants: true });
    expect(p.loops).toEqual({ review: false });
  });

  it('rejects non-boolean review', () => {
    expect(LoopsPolicySchema.safeParse({ review: 'yes' }).success).toBe(false);
  });
});
