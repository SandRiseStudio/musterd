import { describe, expect, it } from 'vitest';
import {
  AnswerSeedClarificationSchema,
  ClaimSeedSchema,
  ConcludeSeedSchema,
  RelaySeedSchema,
  RelaySeedListSchema,
  SeedSchema,
  SeedStateSchema,
  SubmitSeedBriefSchema,
} from './seeds.js';

describe('shared Seeds (ADR 291)', () => {
  it('accepts only the declared lifecycle states', () => {
    expect(SeedStateSchema.parse('open')).toBe('open');
    expect(SeedStateSchema.safeParse('lane')).toMatchObject({ success: false });
  });

  it('accepts only attributed Slack relay records', () => {
    expect(
      RelaySeedSchema.parse({
        id: 'relay-1',
        body: 'idea',
        ts: 1,
        source: 'slack',
        meta: { user: 'U123' },
      }).meta.user,
    ).toBe('U123');
    expect(
      RelaySeedSchema.safeParse({
        id: 'relay-2',
        body: 'idea',
        ts: 1,
        source: 'sms',
        meta: { from: '+15551234567' },
      }).success,
    ).toBe(false);
    expect(
      RelaySeedListSchema.safeParse({
        seeds: [{ id: 'relay-2', body: 'idea', ts: 1, source: 'sms', meta: {} }],
      }).success,
    ).toBe(false);
  });

  it('requires every section of an exhaustive exploration brief', () => {
    const incomplete = {
      result: 'promote',
      brief: { problem: 'A problem', recommendation: 'Do it' },
    };
    expect(SubmitSeedBriefSchema.safeParse(incomplete).success).toBe(false);
    expect(
      SubmitSeedBriefSchema.parse({
        result: 'promote',
        brief: {
          problem: 'A problem',
          context: 'Why it matters now',
          external_evidence: ['A relevant source'],
          approaches: [{ approach: 'Build it', tradeoffs: 'More capability, more surface area' }],
          constraints: ['No new dependency'],
          risks: ['Low adoption'],
          unknowns: ['Exact demand'],
          recommendation: 'Run the smallest useful experiment',
          proposed_lane: { title: 'Test the idea', detail: 'Ship one bounded experiment' },
        },
      }).result,
    ).toBe('promote');
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
