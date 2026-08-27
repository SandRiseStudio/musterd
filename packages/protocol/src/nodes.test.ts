import { describe, expect, it } from 'vitest';
import { TOKEN_PREFIXES } from './credentials.js';
import {
  NodeEnrollRequestSchema,
  NodeInviteMintSchema,
  NodeJoinRequestSchema,
  NodeJoinResponseSchema,
  NodeListSchema,
} from './nodes.js';

describe('the node enrollment vocabulary (ADR 328)', () => {
  it('registers the two new token kinds without disturbing the four that exist', () => {
    expect(TOKEN_PREFIXES.node).toBe('msnode_');
    expect(TOKEN_PREFIXES.node_invite).toBe('msinv_');
    // The prefix registry's whole point is that a secret's role is legible on sight, which fails
    // the moment two kinds share a namespace.
    const prefixes = Object.values(TOKEN_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('requires a presented node id on join — the joiner allocates, the hub vouches (ADR 331 §1)', () => {
    expect(() => NodeJoinRequestSchema.parse({ code: 'msinv_x', label: 'laptop' })).toThrow();
    expect(() =>
      NodeJoinRequestSchema.parse({ code: 'msinv_x', node_id: '', label: 'l' }),
    ).toThrow();
    expect(
      NodeJoinRequestSchema.parse({ code: 'msinv_x', node_id: '01M', label: 'laptop' }).node_id,
    ).toBe('01M');
  });

  it('carries the minted credential on the join response, once', () => {
    const parsed = NodeJoinResponseSchema.parse({
      node_credential: 'msnode_abc',
      node_id: '01M',
      team: 'revive',
    });
    expect(parsed.node_credential).toBe('msnode_abc');
  });

  it('dates the invite so a caller can see the TTL it is bound by', () => {
    expect(NodeInviteMintSchema.parse({ invite: 'msinv_x', expires_at: 1 }).expires_at).toBe(1);
    expect(() => NodeInviteMintSchema.parse({ invite: 'msinv_x' })).toThrow();
  });

  it('never admits a credential or a hash into a listing', () => {
    const parsed = NodeListSchema.parse({
      nodes: [
        {
          id: '01M',
          label: 'laptop',
          enrolled_at: 1,
          revoked_at: null,
          last_seen_at: null,
          credential_prefix: 'msnode_',
          credential_hash: 'deadbeef', // an over-sharing server must not widen the contract
        },
      ],
    });
    expect(parsed.nodes[0]).not.toHaveProperty('credential_hash');
  });

  it('rejects a hub url that is not a url — enrollment posts a secret at it', () => {
    expect(() =>
      NodeEnrollRequestSchema.parse({ hub_url: 'hub.example', code: 'msinv_x', team: 'revive' }),
    ).toThrow();
    expect(
      NodeEnrollRequestSchema.parse({
        hub_url: 'https://hub.example:7777',
        code: 'msinv_x',
        team: 'revive',
      }).hub_url,
    ).toBe('https://hub.example:7777');
  });
});
