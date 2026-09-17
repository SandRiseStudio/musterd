import { describe, expect, it } from 'vitest';
import {
  GOVERNED_LAUNCH_TTL_MAX_MS,
  GovernedAuthorizationRequestSchema,
  GovernedDecisionSchema,
  GovernedLaunchAuthorizationIssueSchema,
  GovernedPolicySchema,
} from './governed.js';

const policy = {
  version: 1,
  team: {
    models: ['anthropic/claude-sonnet-4-6'],
  },
  members: {
    ada: { models: ['anthropic/claude-sonnet-4-6'] },
  },
};

describe('governed authorization protocol (ADR 410)', () => {
  it('defaults governed enforcement to off and preserves restrictive member policy', () => {
    expect(GovernedPolicySchema.parse(policy)).toEqual({
      ...policy,
      enforcement: 'off',
    });
  });

  it.each([
    ['floating model', { ...policy, team: { models: ['anthropic/latest'] } }],
    ['wildcard model', { ...policy, team: { models: ['anthropic/*'] } }],
    ['credential-like policy', { ...policy, members: { ada: { models: ['mscr_secret'] } } }],
  ])('rejects %s', (_name, value) => {
    expect(GovernedPolicySchema.safeParse(value).success).toBe(false);
  });

  it('parses a bounded human-issued launch handoff with each work context', () => {
    const issue = GovernedLaunchAuthorizationIssueSchema.parse({
      member: 'ada',
      node_id: '01JNODE',
      correlation: 'launch-correlation',
      context: { kind: 'lane', lane_id: '01JLANE' },
      ttl_ms: GOVERNED_LAUNCH_TTL_MAX_MS,
    });
    expect(issue.context).toEqual({ kind: 'lane', lane_id: '01JLANE' });
    expect(
      GovernedLaunchAuthorizationIssueSchema.parse({
        ...issue,
        context: { kind: 'act', act_id: '01JACT' },
      }).context,
    ).toEqual({ kind: 'act', act_id: '01JACT' });
    expect(
      GovernedLaunchAuthorizationIssueSchema.parse({
        ...issue,
        context: { kind: 'orientation', allowance_id: '01JALLOW' },
      }).context,
    ).toEqual({ kind: 'orientation', allowance_id: '01JALLOW' });
  });

  it('round-trips an Aperture decision request and structured refusal', () => {
    const request = GovernedAuthorizationRequestSchema.parse({
      launch_id: '01JLAUNCH',
      presence_id: '01JPRESENCE',
      correlation: 'launch-correlation',
      member: 'ada',
      node_id: '01JNODE',
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-4-6',
    });
    expect(request.model).toBe('anthropic/claude-sonnet-4-6');

    expect(
      GovernedDecisionSchema.parse({
        decision: 'deny',
        reason: 'denied_launch_replayed',
        launch_id: '01JLAUNCH',
        correlation: 'launch-correlation',
      }),
    ).toMatchObject({ decision: 'deny', reason: 'denied_launch_replayed' });
  });
});
