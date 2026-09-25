import { describe, expect, it } from 'vitest';
import {
  OAuthAuthorizeConfirmSchema,
  OAuthAuthorizeQuerySchema,
  OAuthClientRegistrationRequestSchema,
  OAuthTokenRequestSchema,
} from './oauth.js';

const query = {
  response_type: 'code',
  client_id: 'cid_1',
  redirect_uri: 'https://app.example/cb',
  state: 's',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
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
      code_challenge: 'c',
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

  it('token grant is authorization_code or refresh_token — nothing else', () => {
    expect(
      OAuthTokenRequestSchema.safeParse({
        grant_type: 'authorization_code',
        code: 'c',
        redirect_uri: 'https://app.example/cb',
        client_id: 'cid_1',
        code_verifier: 'v',
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
});
