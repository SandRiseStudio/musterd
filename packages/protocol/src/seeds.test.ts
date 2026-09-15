import { describe, expect, it } from 'vitest';
import {
  AnswerSeedClarificationSchema,
  CaptureRepoSeedSchema,
  ClaimSeedSchema,
  ConcludeSeedSchema,
  RelaySeedSchema,
  RelaySeedListSchema,
  SeedMcpUpdateSchema,
  SeedSchema,
  SeedSourceSchema,
  SeedStateSchema,
  SubmitSeedBriefSchema,
  seedInActiveTray,
} from './seeds.js';

describe('shared Seeds (ADR 291)', () => {
  it('keeps active work and only recently completed Seeds in the default tray', () => {
    const now = Date.UTC(2026, 7, 24);
    const seed = (state: 'open' | 'completed' | 'promoted', completedAt: number | null) =>
      ({ state, completed_at: completedAt }) as Parameters<typeof seedInActiveTray>[0];

    expect(seedInActiveTray(seed('open', null), now)).toBe(true);
    expect(seedInActiveTray(seed('completed', now - 3 * 24 * 60 * 60 * 1_000), now)).toBe(true);
    expect(seedInActiveTray(seed('completed', now - 3 * 24 * 60 * 60 * 1_000 - 1), now)).toBe(
      false,
    );
    expect(seedInActiveTray(seed('promoted', now), now)).toBe(false);
  });

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

  it('widens the stored source to repo while the relay boundary stays Slack-only (ADR 373 inc 2)', () => {
    expect(SeedSourceSchema.parse('repo')).toBe('repo');
    expect(SeedSourceSchema.safeParse('sms').success).toBe(false);
    expect(
      RelaySeedSchema.safeParse({
        id: 'r',
        body: 'idea',
        ts: 1,
        source: 'repo',
        meta: { user: 'U1' },
      }).success,
    ).toBe(false);
    expect(
      CaptureRepoSeedSchema.parse({
        ref: 'docs/decisions/354-wake-lease-file-channel.md#left-for-a-sibling-lane',
        body: 'Left for a sibling lane; this ADR fixes the attestation, not the judgement.',
        lane_id: '01M1MMHJP3PQY1QWNJCHV3XEMA',
      }).lane_id,
    ).toBe('01M1MMHJP3PQY1QWNJCHV3XEMA');
    expect(CaptureRepoSeedSchema.safeParse({ ref: ' ', body: 'x' }).success).toBe(false);
    expect(CaptureRepoSeedSchema.safeParse({ ref: 'a.md#b', body: '  \n' }).success).toBe(false);
  });

  it('validates a substantive relay body without changing the raw capture', () => {
    const body = '  idea with source whitespace\n';
    expect(
      RelaySeedSchema.parse({
        id: 'relay-verbatim',
        body,
        ts: 1,
        source: 'slack',
        meta: { user: 'U123' },
      }).body,
    ).toBe(body);
    expect(
      RelaySeedSchema.safeParse({
        id: 'relay-empty',
        body: ' \n ',
        ts: 1,
        source: 'slack',
        meta: { user: 'U123' },
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

  it('parses the compact MCP lifecycle envelope by action', () => {
    expect(
      SeedMcpUpdateSchema.parse({ action: 'ask', id: '01SEED', input: { body: 'Which Surface?' } }),
    ).toEqual({ action: 'ask', id: '01SEED', input: { body: 'Which Surface?' } });
    expect(
      SeedMcpUpdateSchema.safeParse({ action: 'ask', id: '01SEED', input: { body: ' ' } }).success,
    ).toBe(false);
    expect(
      SeedMcpUpdateSchema.safeParse({ action: 'claim', id: '01SEED', input: { body: 'extra' } })
        .success,
    ).toBe(false);
  });
});
