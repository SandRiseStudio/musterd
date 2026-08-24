import { describe, expect, it } from 'vitest';
import {
  AnswerSeedClarificationSchema,
  ClaimSeedSchema,
  ConcludeSeedSchema,
  SeedSchema,
  SeedStateSchema,
} from './seeds.js';

describe('shared Seeds (ADR 291)', () => {
  it('accepts only the declared lifecycle states', () => {
    expect(SeedStateSchema.parse('open')).toBe('open');
    expect(SeedStateSchema.safeParse('lane')).toMatchObject({ success: false });
  });

  it('requires immutable source fields on a Seed', () => {
    expect(
      SeedSchema.safeParse({ id: '01J', team: 'revive', state: 'open', relay_id: 'relay-1' }),
    ).toMatchObject({ success: false });
  });

  it('requires substantive final and clarification bodies', () => {
    expect(ConcludeSeedSchema.safeParse({ conclusion: ' ' }).success).toBe(false);
    expect(AnswerSeedClarificationSchema.safeParse({ body: ' ' }).success).toBe(false);
    expect(ClaimSeedSchema.parse({})).toEqual({});
  });
});
