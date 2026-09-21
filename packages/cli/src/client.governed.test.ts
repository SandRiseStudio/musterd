import type {
  GovernedLaunchAuthorizationIssue,
  GovernedLaunchAuthorizationMint,
  GovernedPolicy,
} from '@musterd/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client.js';

const policy: GovernedPolicy = {
  version: 1,
  enforcement: 'off',
  team: { models: ['anthropic/claude-sonnet-4-5'] },
  members: {},
};

const issue: GovernedLaunchAuthorizationIssue = {
  member: 'Ada',
  node_id: '01JNODE',
  correlation: 'corr-1',
  context: { kind: 'lane', lane_id: '01JLANE' },
  ttl_ms: 300_000,
};

const mint: GovernedLaunchAuthorizationMint = {
  authorization: {
    id: '01JLAUNCH',
    team: 'revive',
    member: 'Ada',
    node_id: '01JNODE',
    correlation: 'corr-1',
    context: { kind: 'lane', lane_id: '01JLANE' },
    issued_by: 'Nick',
    created_at: 1_000,
    expires_at: 301_000,
    consumed_at: null,
    revoked_at: null,
    presence_id: null,
  },
  token: 'msla_test-token',
};

function stubResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpClient governed launcher methods', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads and writes the governed policy through the typed routes', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(stubResponse({ policy, updated_at: 1_000 }))
      .mockResolvedValueOnce(stubResponse({ policy, updated_at: 2_000 }));
    vi.stubGlobal('fetch', fetchFn);
    const client = new HttpClient({ server: 'http://x' });

    await expect(client.getGovernedPolicy('revive')).resolves.toEqual({
      policy,
      updated_at: 1_000,
    });
    await expect(client.setGovernedPolicy('revive', policy)).resolves.toEqual({
      policy,
      updated_at: 2_000,
    });

    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://x/teams/revive/governed/policy');
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(fetchFn.mock.calls[1]?.[0]).toBe('http://x/teams/revive/governed/policy');
    expect(JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual(policy);
  });

  it('issues and revokes a governed launch without exposing the mint in errors', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(stubResponse(mint, 201))
      .mockResolvedValueOnce(stubResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchFn);
    const client = new HttpClient({ server: 'http://x' });

    await expect(client.issueGovernedLaunch('revive', issue)).resolves.toEqual(mint);
    await expect(client.revokeGovernedLaunch('revive', '01JLAUNCH')).resolves.toEqual({ ok: true });

    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://x/teams/revive/governed/launches');
    expect(JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual(issue);
    expect(fetchFn.mock.calls[1]?.[0]).toBe('http://x/teams/revive/governed/launches/01JLAUNCH');
    expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('refuses malformed governed responses at the protocol boundary', async () => {
    const fetchFn = vi.fn().mockResolvedValue(stubResponse({ token: 'msla_only' }, 201));
    vi.stubGlobal('fetch', fetchFn);

    await expect(
      new HttpClient({ server: 'http://x' }).issueGovernedLaunch('revive', issue),
    ).rejects.toThrow(/governed launch response did not match the protocol schema/);
  });
});
