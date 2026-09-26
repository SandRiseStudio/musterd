import { describe, expect, it } from 'vitest';
import {
  OAuthAuthorizeConfirmSchema,
  OAuthAuthorizeQuerySchema,
  OAuthClientRegistrationRequestSchema,
  OAuthTokenRequestSchema,
} from './oauth.js';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const query = {
  response_type: 'code',
  client_id: 'cid_1',
  redirect_uri: 'https://app.example/cb',
  state: 's',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
} as const;

describe('oauth schemas (ADR 446)', () => {
  it('authorize query requires PKCE S256 — plain and none are refused', () => {
    expect(OAuthAuthorizeQuerySchema.safeParse(query).success).toBe(true);
    expect(
      OAuthAuthorizeQuerySchema.safeParse({ ...query, code_challenge_method: 'plain' }).success,
    ).toBe(false);
    expect(
      OAuthAuthorizeQuerySchema.safeParse({ ...query, code_challenge_method: 'none' }).success,
    ).toBe(false);
  });

  it('authorize confirm requires an mscr_ proof — nothing else rides the seam', () => {
    const base = {
      client_id: 'cid_1',
      redirect_uri: 'https://app.example/cb',
      state: 's',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    } as const;
    expect(
      OAuthAuthorizeConfirmSchema.safeParse({
        ...base,
        proof: { kind: 'credential', credential: 'mscr_x', member: 'nick' },
      }).success,
    ).toBe(true);
    expect(
      OAuthAuthorizeConfirmSchema.safeParse({
        ...base,
        proof: { kind: 'credential', credential: 'mskey_x' },
      }).success,
    ).toBe(false);
  });

  it('agent_connect carries a nonce only — a credential in that arm is refused (ADR 452 §1)', () => {
    const base = {
      client_id: 'cid_1',
      redirect_uri: 'https://app.example/cb',
      state: 's',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    } as const;
    const nonce = 'A'.repeat(43);
    const ok = (value: string) =>
      OAuthAuthorizeConfirmSchema.safeParse({
        ...base,
        proof: { kind: 'agent_connect', nonce: value },
      }).success;
    expect(ok(nonce)).toBe(true);
    expect(ok(`n=${nonce}`)).toBe(true);
    expect(ok(`https://host/join/dawn#n=${nonce}`)).toBe(true);
    // Every musterd secret prefix is refused, even padded past the length floor.
    for (const cred of ['mscr_', 'msac_', 'mskey_', 'msat_', 'msrt_', 'mskd_'])
      expect(ok(cred + 'x'.repeat(60))).toBe(false);
    expect(ok('short')).toBe(false);
    expect(
      OAuthAuthorizeConfirmSchema.safeParse({
        ...base,
        proof: { kind: 'agent_connect', nonce, credential: 'mscr_x' },
      }).success,
    ).toBe(false);
  });

  it('PKCE entropy (RFC 7636): short verifiers and malformed challenges refused', () => {
    expect(OAuthAuthorizeQuerySchema.safeParse({ ...query, code_challenge: 'short' }).success).toBe(
      false,
    );
    expect(
      OAuthAuthorizeQuerySchema.safeParse({ ...query, code_challenge: 'x'.repeat(44) }).success,
    ).toBe(false);
    const token = {
      grant_type: 'refresh_token',
      refresh_token: 'msrt_x',
      client_id: 'cid_1',
    };
    expect(OAuthTokenRequestSchema.safeParse(token).success).toBe(true);
    const codeGrant = (verifier: string) => ({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://app.example/cb',
      client_id: 'cid_1',
      code_verifier: verifier,
    });
    expect(OAuthTokenRequestSchema.safeParse(codeGrant('x'.repeat(43))).success).toBe(true);
    expect(OAuthTokenRequestSchema.safeParse(codeGrant('short')).success).toBe(false);
    expect(OAuthTokenRequestSchema.safeParse(codeGrant('x'.repeat(129))).success).toBe(false);
    expect(OAuthTokenRequestSchema.safeParse(codeGrant('not unreserved!')).success).toBe(false);
  });

  it('token grant is authorization_code or refresh_token — nothing else', () => {
    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'authorization_code',
        code: 'c',
        redirect_uri: 'https://app.example/cb',
        client_id: 'cid_1',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      }).success,
    ).toBe(true);
    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'refresh_token',
        refresh_token: 'msrt_x',
        client_id: 'cid_1',
      }).success,
    ).toBe(true);
    expect(OAuthTokenRequestSchema.safeParse({ grant_type: 'client_credentials' }).success).toBe(
      false,
    );
  });

  it('registration requires redirect_uris and a named client', () => {
    expect(
      OAuthClientRegistrationRequestSchema.safeParse({
        redirect_uris: ['https://app.example/cb'],
        client_name: 'Claude',
      }).success,
    ).toBe(true);
    expect(
      OAuthClientRegistrationRequestSchema.safeParse({ redirect_uris: [], client_name: 'x' })
        .success,
    ).toBe(false);
  });

  it('registration accepts the Claude-shaped RFC 7591 body — grant_types/response_types ride along', () => {
    // What the real Claude connector posts (and ChatGPT likewise): the RFC 7591 §2 optional
    // members alongside the required fields. Landed code 400d this ("Unrecognized key(s)"),
    // so no real phone app could register — fifty's #1694 verdict, 2026-09-25.
    const claudeBody = {
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } as const;
    expect(OAuthClientRegistrationRequestSchema.safeParse(claudeBody).success).toBe(true);
    // Tolerance is enumerated, not open: truly unknown keys still fail closed.
    expect(
      OAuthClientRegistrationRequestSchema.safeParse({ ...claudeBody, bogus_key: 1 }).success,
    ).toBe(false);
  });
});
