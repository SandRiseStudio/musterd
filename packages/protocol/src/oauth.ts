import { z } from 'zod';
import { TOKEN_PREFIXES } from './credentials.js';

/**
 * OAuth 2.1 surface for remote MCP (ADR 446) — the zod vocabulary for the daemon's minimal
 * authorization server, whose only users are phone MCP apps signing a human seat in.
 *
 * Two bearer kinds ride here (both minted `prefix + base64url(randomBytes)`, stored only as
 * sha256, plaintext returned exactly once — SPEC A.2, same rule as every secret since ADR 069):
 * `oauth_access` (`msat_`, 1h TTL) authenticates `/mcp/:team` tool calls exactly like an `mscr_`
 * in `authMember` (self-identifying, acting-seat must match-or-absent, no session lease — there
 * is no Presence to bind one to); `oauth_refresh` (`msrt_`, 30d TTL, single-use rotation, reuse
 * revokes the chain) renews the pair. Agent seats stay on the claim handshake — authorize proves
 * human seats only (ADR 446 §6).
 */

/** PKCE S256 is REQUIRED — `plain` and `none` are refused (ADR 446 §3). */
export const PKCE_METHOD = 'S256' as const;

/** TTLs, in seconds — the abuse posture the rehearsal tunes, not the code (ADR 446 §5). */
export const OAUTH_CODE_TTL_S = 90;
export const OAUTH_ACCESS_TTL_S = 3600;
export const OAUTH_REFRESH_TTL_S = 30 * 24 * 3600;

/** Per-IP rate-limit buckets per minute (ADR 446 §5) — tune in rehearsal, not in code. */
export const OAUTH_RATE_LIMITS = {
  register: 5,
  authorize: 10,
  token: 20,
} as const;

/** `POST /oauth/:team/register` (RFC 7591) — redirect URIs validated server-side, never just typed. */
export const OAuthClientRegistrationRequestSchema = z
  .object({
    redirect_uris: z.array(z.string().min(1)).min(1),
    client_name: z.string().min(1).max(200),
    token_endpoint_auth_method: z.enum(['none', 'client_secret_basic']).default('none'),
    client_uri: z.string().optional(),
    logo_uri: z.string().optional(),
    scope: z.string().optional(),
  })
  .strict();
export type OAuthClientRegistrationRequest = z.infer<typeof OAuthClientRegistrationRequestSchema>;

/** Registration response — the secret is present ONLY for confidential clients, shown once. */
export const OAuthClientRegistrationResponseSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().int(),
  client_secret_expires_at: z.number().int(),
  redirect_uris: z.array(z.string()),
  client_name: z.string(),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  token_endpoint_auth_method: z.string(),
});
export type OAuthClientRegistrationResponse = z.infer<typeof OAuthClientRegistrationResponseSchema>;

/** `GET /oauth/:team/authorize?...` — the query the app opens in the system browser. */
export const OAuthAuthorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  state: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal(PKCE_METHOD),
  scope: z.string().optional(),
});
export type OAuthAuthorizeQuery = z.infer<typeof OAuthAuthorizeQuerySchema>;

/**
 * `POST /oauth/:team/authorize` — the human proves the seat at the consent page. Increment 1
 * knows one prover: the seat's own `mscr_` (checked by `authByCredential`, acting-seat must
 * match). The join-link approval plugs the same seam later (fifty's lane) as a second prover,
 * not a second auth system — hence the `kind` discriminant.
 */
export const OAuthAuthorizeConfirmSchema = z
  .object({
    client_id: z.string().min(1),
    redirect_uri: z.string().min(1),
    state: z.string().min(1),
    code_challenge: z.string().min(1),
    code_challenge_method: z.literal(PKCE_METHOD),
    scope: z.string().optional(),
    proof: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('credential'),
          credential: z.string().startsWith(TOKEN_PREFIXES.credential),
          member: z.string().min(1).optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type OAuthAuthorizeConfirm = z.infer<typeof OAuthAuthorizeConfirmSchema>;

/** `POST /oauth/:team/token` — authorization_code (PKCE verifier) or refresh_token (rotation). */
export const OAuthTokenRequestSchema = z.union([
  z
    .object({
      grant_type: z.literal('authorization_code'),
      code: z.string().min(1),
      redirect_uri: z.string().min(1),
      client_id: z.string().min(1),
      code_verifier: z.string().min(1),
    })
    .strict(),
  z
    .object({
      grant_type: z.literal('refresh_token'),
      refresh_token: z.string().startsWith(TOKEN_PREFIXES.oauth_refresh),
      client_id: z.string().min(1),
      scope: z.string().optional(),
    })
    .strict(),
]);
export type OAuthTokenRequest = z.infer<typeof OAuthTokenRequestSchema>;

/** Token response — the ONE response body a plaintext secret ever crosses (ADR 446 §5). */
export const OAuthTokenResponseSchema = z.object({
  access_token: z.string().startsWith(TOKEN_PREFIXES.oauth_access),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
  refresh_token: z.string().startsWith(TOKEN_PREFIXES.oauth_refresh).optional(),
  scope: z.string().optional(),
});
export type OAuthTokenResponse = z.infer<typeof OAuthTokenResponseSchema>;

/** RFC 7009 revocation — either kind of token, sign-out and admin revoke-all ride here. */
export const OAuthRevocationRequestSchema = z
  .object({
    token: z.string().min(1),
    token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
  })
  .strict();
export type OAuthRevocationRequest = z.infer<typeof OAuthRevocationRequestSchema>;

/** RFC 8707-style protected-resource metadata at `/.well-known/oauth-protected-resource/mcp/:team`. */
export const OAuthProtectedResourceMetadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()),
  bearer_methods_supported: z.array(z.string()),
  scopes_supported: z.array(z.string()),
});
export type OAuthProtectedResourceMetadata = z.infer<typeof OAuthProtectedResourceMetadataSchema>;

/** Authorization-server metadata at `/.well-known/oauth-authorization-server[/:team]`. */
export const OAuthAuthorizationServerMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
  revocation_endpoint: z.string(),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
});
export type OAuthAuthorizationServerMetadata = z.infer<
  typeof OAuthAuthorizationServerMetadataSchema
>;
