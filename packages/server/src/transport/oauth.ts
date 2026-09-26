import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OAUTH_RATE_LIMITS,
  OAuthAuthorizeConfirmSchema,
  OAuthAuthorizeQuerySchema,
  OAuthClientRegistrationRequestSchema,
  OAuthTokenRequestSchema,
  type OAuthAuthorizationServerMetadata,
  type OAuthProtectedResourceMetadata,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { isLocalPeer } from '../config.js';
import type { Ctx } from '../context.js';
import { asMusterdError, MusterdError } from '../errors.js';
import { appendAudit } from '../store/audit.js';
import { checkInvite, consumeInvite } from '../store/invites.js';
import { addMember, authMember, getMemberByName, memberStandingRefusal } from '../store/members.js';
import {
  burnUnexchangedCodes,
  chainMember,
  getClient,
  issueCode,
  mintTokenPair,
  redeemCode,
  registerClient,
  revokeAllForMember,
  revokeToken,
  rotateRefresh,
} from '../store/oauth.js';
import type { MemberRow } from '../store/rows.js';
import { redeemAgentConnectNonce } from '../store/sponsoredAgents.js';
import { requireTeam } from '../store/teams.js';
import { originFrom } from './sponsoredAgentMint.js';

/**
 * The OAuth 2.1 authorization server (ADR 446 §3) — the daemon is the identity provider for its
 * own teams' humans, serving exactly one client class (phone MCP apps).
 *
 * Shape notes:
 * - Team-scoped paths (`/oauth/:team/...`) because a phone app configures one URL and no headers.
 * - `Cache-Control: no-store` + `Pragma: no-cache` on every token/code response (ADR 446 §5); the
 *   plaintext secret crosses exactly one response body (`token`) and one 302 `Location` (the code).
 * - Audit verbs are `oauth.*` — who (member), which client, when; never the secret (ADR 446 §5).
 * - OAuth + bearer routes refuse non-TLS unless loopback (ADR 446 §1): a bearer minted over
 *   plaintext is a bearer leaked. TLS terminates at the tunnel (sibling lane); the daemon reads
 *   `x-forwarded-proto` for what the tunnel saw.
 * - Increment 1 serves PUBLIC clients only — both phone apps are public, and a confidential
 *   secret needs a typed prefix ADR 446 does not define (increment 3).
 */

/** Per-IP buckets per minute (ADR 446 §5) — tune in rehearsal, not in code. */
const buckets = new Map<string, number[]>();

/** Test seam: empty the rate-limit buckets between isolated test servers (all share loopback IP). */
export function __resetOAuthBucketsForTest(): void {
  buckets.clear();
}

/**
 * The team behind a URL slug, without ever echoing the slug (redaction lane 01M3AMYGN5): the
 * slug is attacker-controlled path input and may itself be credential-shaped (`/mcp/mscr_…`),
 * so `requireTeam`'s `no team "X"` message would write the secret into the response body.
 */
export function requireTeamRedacted(db: Database, slug: string) {
  try {
    return requireTeam(db, slug);
  } catch (err) {
    if (err instanceof MusterdError && err.code === 'not_found')
      throw new MusterdError('not_found', 'no such team');
    throw err;
  }
}

/**
 * The rate-limit key (declines 1–2): `req.socket.remoteAddress` alone collapses behind the
 * loopback Cloudflare Tunnel (every attendee arrives as the local `cloudflared` peer, so one
 * attendee could throttle everyone) — but the naive fix, leftmost `X-Forwarded-For`, is
 * caller-controlled (Cloudflare preserves an incoming XFF and appends, so the leftmost value
 * stays spoofable and rotating it bypasses per-client limits).
 *
 * With `trustProxy` on — the tunnel-facing posture — the key is `CF-Connecting-IP`, which the
 * Cloudflare edge writes (clients cannot forge it; explicit assumption: no Worker in front
 * rewriting it). XFF is never trusted. Without trustProxy the socket address stands.
 */
function clientIp(ctx: Ctx, req: IncomingMessage): string {
  if (ctx.config.trustProxy) {
    const ccip = req.headers['cf-connecting-ip'];
    const ip = (Array.isArray(ccip) ? ccip[0] : ccip)?.trim();
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Hard bound on bucket cardinality — distinct IPs are unbounded (botnet), memory is not. */
const OAUTH_BUCKET_MAX_KEYS = 10_000;

function checkRateLimit(
  ctx: Ctx,
  req: IncomingMessage,
  route: keyof typeof OAUTH_RATE_LIMITS,
): void {
  const now = Date.now();
  const key = `${clientIp(ctx, req)}:${route}`;
  const windowStart = now - 60_000;
  const hits = (buckets.get(key) ?? []).filter((t) => t > windowStart);
  if (hits.length >= OAUTH_RATE_LIMITS[route]) {
    throw new MusterdError('rate_limited', `too many ${route} requests — retry in a minute`);
  }
  hits.push(now);
  buckets.set(key, hits);
  // Expiry sweep first; if still over the cap, evict oldest-inserted (Map order) — a full map
  // must shed load, never grow, and never punish the keys it keeps.
  if (buckets.size > OAUTH_BUCKET_MAX_KEYS) {
    for (const [k, v] of buckets) {
      if (v.every((t) => t <= windowStart)) buckets.delete(k);
      if (buckets.size <= OAUTH_BUCKET_MAX_KEYS) break;
    }
    for (const k of buckets.keys()) {
      if (buckets.size <= OAUTH_BUCKET_MAX_KEYS) break;
      buckets.delete(k);
    }
  }
}

/** Test seam: current bucket cardinality (churn bound). */
export function __oauthBucketSizeForTest(): number {
  return buckets.size;
}

/** TLS opinion (ADR 446 §1): loopback is plaintext-safe; anything else must arrive via https. */
export function isTlsPeer(ctx: Ctx, req: IncomingMessage): boolean {
  if (isLocalPeer(req.socket.remoteAddress, ctx.config.trustProxy)) return true;
  const proto = req.headers['x-forwarded-proto'];
  const first = Array.isArray(proto) ? proto[0] : proto;
  return first?.split(',')[0]?.trim().toLowerCase() === 'https';
}

function requireTlsPeer(ctx: Ctx, req: IncomingMessage, what: string): void {
  if (isTlsPeer(ctx, req)) return;
  throw new MusterdError(
    'forbidden',
    `${what} is refused over plaintext — reach the daemon through the TLS tunnel (or loopback for local testing)`,
  );
}

function baseUrl(req: IncomingMessage): string {
  const proto = req.headers['x-forwarded-proto'];
  return originFrom(req.headers.host, Array.isArray(proto) ? proto[0] : proto);
}

function sendOAuthJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    pragma: 'no-cache',
  });
  res.end(payload);
}

function sendOAuthError(res: ServerResponse, err: unknown): void {
  const me = asMusterdError(err);
  sendOAuthJson(res, me.httpStatus, me.toBody());
}

/** OAuth-style token error (what the apps parse) — NOT the musterd envelope. */
function sendTokenError(
  res: ServerResponse,
  status: number,
  error: string,
  description: string,
): void {
  sendOAuthJson(res, status, { error, error_description: description });
}

/** OAuth bodies are consent forms and small JSON — 64 KiB is orders of magnitude of headroom. */
const OAUTH_BODY_MAX_BYTES = 64 * 1024;

async function readBody(req: IncomingMessage, maxBytes = OAUTH_BODY_MAX_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    // Decline 2: public endpoints must not buffer unbounded input — refuse past the cap rather
    // than exhaust daemon memory. The socket stays usable (the response ends the exchange).
    if (total > maxBytes) throw new MusterdError('payload_too_large', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readTokenRequestBody(req: IncomingMessage): Promise<unknown> {
  const raw = (await readBody(req)).toString('utf8');
  if (!raw) return {};
  const ctype = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (ctype === 'application/json') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new MusterdError('bad_request', 'invalid JSON body');
    }
  }
  // OAuth clients POST form-encoded (RFC 6749 §4.1.3); accept it as the default.
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  return false;
}

/**
 * Redirect-URI validation (ADR 446 §3): `https:` always; loopback `http:` for desktop testing
 * only (never the demo path); custom schemes are the native-app marker the app declares;
 * no wildcard hosts, no private-host downgrade, ever.
 */
function assertRedirectUri(uri: string): URL | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new MusterdError('bad_request', 'redirect_uri is not a URL');
  }
  if (uri.includes('*')) throw new MusterdError('bad_request', 'redirect_uri may not wildcard');
  if (u.protocol === 'https:') {
    if (!isLoopbackHost(u.hostname) && isPrivateHost(u.hostname))
      throw new MusterdError('bad_request', 'redirect_uri must be public https or loopback');
    return u;
  }
  if (u.protocol === 'http:') {
    if (isLoopbackHost(u.hostname)) return u;
    throw new MusterdError(
      'bad_request',
      'redirect_uri must be https (loopback http is for desktop testing only)',
    );
  }
  // Custom scheme: the explicit `native:` marker a phone/desktop app declares. It carries no
  // host to validate, so the exact-match check at authorize/token time is the whole guard.
  if (!uri.includes(':/'))
    throw new MusterdError('bad_request', 'redirect_uri scheme is not supported');
  return null;
}

function metadataFor(
  ctx: Ctx,
  req: IncomingMessage,
  teamSlug: string,
): { resource: OAuthProtectedResourceMetadata; server: OAuthAuthorizationServerMetadata } {
  const base = baseUrl(req);
  const issuer = `${base}/oauth/${encodeURIComponent(teamSlug)}`;
  return {
    resource: {
      resource: `${base}/mcp/${encodeURIComponent(teamSlug)}`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    },
    server: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    },
  };
}

function consentPage(input: {
  team: string;
  clientName: string;
  scope?: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
}): string {
  const e = escapeHtml;
  // ADR 450 §2 + ADR 452 §5: three forms, one seam. All post the same OAuth fields; the invite form
  // posts `invite` + `member`, the seat form `member` + `credential`, the agent form `agent_connect`.
  const hidden = `<input type="hidden" name="client_id" value="${e(input.client_id)}">
<input type="hidden" name="redirect_uri" value="${e(input.redirect_uri)}">
<input type="hidden" name="state" value="${e(input.state)}">
<input type="hidden" name="code_challenge" value="${e(input.code_challenge)}">
<input type="hidden" name="code_challenge_method" value="S256">
${input.scope ? `<input type="hidden" name="scope" value="${e(input.scope)}">` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to ${e(input.team)} — musterd</title></head><body>
<h1>${e(input.clientName)} wants to join <b>${e(input.team)}</b></h1>
<p>Signing in adds this app as your seat on the team. It can read the inbox and send as you until you revoke it.</p>
<h2>I'm new — I have an invite</h2>
<form method="post" action="">
${hidden}
<label>Invite (the room code, or the value from the join link) <input type="text" name="invite" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC-1234-5678"></label><br>
<label>Pick a name <input type="text" name="member" autocomplete="off"></label><br>
<button type="submit">Join ${e(input.team)}</button>
</form>
<h2>I already have a seat</h2>
<form method="post" action="">
${hidden}
<label>Seat name <input type="text" name="member" autocomplete="username"></label><br>
<label>Credential (<code>mscr_…</code>) <input type="password" name="credential" autocomplete="current-password"></label><br>
<button type="submit">Sign in this app as me</button>
</form>
<h2>Connecting an agent?</h2>
<form method="post" action="">
${hidden}
<label>Paste its connect link (or the code from the link's page) <input type="text" name="agent_connect" autocomplete="off" autocapitalize="off" spellcheck="false"></label><br>
<button type="submit">Connect this agent to ${e(input.team)}</button>
</form></body></html>`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  const bytes = Buffer.byteLength(html);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(bytes),
    'cache-control': 'no-store',
    pragma: 'no-cache',
  });
  res.end(html);
}

function consentFormBody(raw: string): {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  member: string;
  credential: string;
  invite: string;
  agent_connect: string;
} {
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) {
    if (!(k in out)) out[k] = v;
  }
  return {
    client_id: out['client_id'] ?? '',
    redirect_uri: out['redirect_uri'] ?? '',
    state: out['state'] ?? '',
    code_challenge: out['code_challenge'] ?? '',
    code_challenge_method: out['code_challenge_method'] ?? '',
    ...(out['scope'] ? { scope: out['scope'] } : {}),
    member: out['member'] ?? '',
    credential: out['credential'] ?? '',
    invite: out['invite'] ?? '',
    agent_connect: out['agent_connect'] ?? '',
  };
}

/**
 * ADR 452 §1: the connect nonce out of whatever the person pasted — the whole link
 * (`…/join/:team#n=<nonce>`), `n=<nonce>`, or the bare nonce. Null when no 43-char base64url nonce
 * (`randomBytes(32)`) can be read; the caller refuses that with the same body as a bad nonce.
 */
export function connectNonceFrom(pasted: string): string | null {
  let v = pasted.trim();
  const hash = v.indexOf('#');
  if (hash >= 0) v = v.slice(hash + 1);
  if (v.includes('=')) v = new URLSearchParams(v).get('n') ?? '';
  return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
}

/**
 * Top-level OAuth routes (`/oauth/:team/...` + `/.well-known/...`). Returns true when the path
 * belonged here (handled or refused with an OAuth-shaped error); false to fall through to the
 * team routes. Throws only for transport-level failures the outer handler serializes.
 */
export async function handleOAuthRoutes(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  url: URL,
): Promise<boolean> {
  // ── discovery ──
  // Decline 4: every OAuth route — including discovery and registration — refuses non-TLS
  // except loopback, exactly as the ADR claims. Metadata is public info, but a uniform rule
  // has no carve-outs to misread, and loopback + tunneled https both pass regardless.
  const prm = path.match(/^\/.well-known\/oauth-protected-resource\/mcp\/([^/]+)$/);
  if (method === 'GET' && prm) {
    requireTlsPeer(ctx, req, 'OAuth discovery');
    const slug = decodeURIComponent(prm[1]!);
    requireTeamRedacted(ctx.db, slug);
    sendOAuthJson(res, 200, metadataFor(ctx, req, slug).resource);
    return true;
  }
  const asmTeam = path.match(/^\/.well-known\/oauth-authorization-server\/([^/]+)$/);
  if (method === 'GET' && asmTeam) {
    requireTlsPeer(ctx, req, 'OAuth discovery');
    const slug = decodeURIComponent(asmTeam[1]!);
    requireTeamRedacted(ctx.db, slug);
    sendOAuthJson(res, 200, metadataFor(ctx, req, slug).server);
    return true;
  }
  if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
    // Multi-tenant honesty: one document cannot name every team's endpoints, and the
    // protected-resource metadata (which spec-following clients read first) already names the
    // exact per-team issuer. Point at it rather than serve a wrong one.
    sendOAuthError(
      res,
      new MusterdError(
        'not_found',
        'this server is multi-tenant — read /.well-known/oauth-protected-resource/mcp/:team for this team\u2019s issuer',
      ),
    );
    return true;
  }
  // The issuer is https://host/oauth/:team, so an MCP client (auth spec 2025-06-18 §2.3.3) looks
  // for its metadata at, in order: RFC 8414 path INSERTION
  // (/.well-known/oauth-authorization-server/oauth/:team), OIDC path insertion
  // (/.well-known/openid-configuration/oauth/:team), OIDC path appending
  // (/oauth/:team/.well-known/openid-configuration). Serve all three plus the RFC 8414 appended
  // form that older clients try. Until 2026-09-26 only the appended form existed and the Claude
  // iOS app failed with "could not start sign in" before ever reaching the sign-in page
  // (Rehearsal A, lane 01M3FDG1MD).
  const asmInserted = path.match(
    /^(?:\/.well-known\/(?:oauth-authorization-server|openid-configuration)\/oauth\/([^/]+)|\/oauth\/([^/]+)\/.well-known\/(?:oauth-authorization-server|openid-configuration))$/,
  );
  if (method === 'GET' && asmInserted) {
    requireTlsPeer(ctx, req, 'OAuth discovery');
    const slug = decodeURIComponent((asmInserted[1] ?? asmInserted[2])!);
    requireTeamRedacted(ctx.db, slug);
    sendOAuthJson(res, 200, metadataFor(ctx, req, slug).server);
    return true;
  }

  // ── team-scoped OAuth ──
  const m = path.match(/^\/oauth\/([^/]+)(\/.*)?$/);
  if (!m) return false;
  const slug = decodeURIComponent(m[1]!);
  const rest = m[2] ?? '';
  const team = requireTeamRedacted(ctx.db, slug);

  const parseOrOAuth = <S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw new MusterdError(
        'bad_request',
        parsed.error.issues
          .slice(0, 4)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      );
    return parsed.data;
  };

  // ── POST /oauth/:team/register (RFC 7591) ──
  if (method === 'POST' && rest === '/register') {
    requireTlsPeer(ctx, req, 'client registration');
    checkRateLimit(ctx, req, 'register');
    const body = parseOrOAuth(
      OAuthClientRegistrationRequestSchema,
      await readTokenRequestBody(req),
    );
    if (body.token_endpoint_auth_method !== 'none')
      throw new MusterdError(
        'bad_request',
        'confidential clients are not issued in increment 1 — register a public client (both phone apps are public)',
      );
    for (const uri of body.redirect_uris) assertRedirectUri(uri);
    const { client_id } = registerClient(ctx.db, {
      teamId: team.id,
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
    });
    appendAudit(ctx.db, team.id, {
      actor: null,
      action: 'oauth.client_registered',
      target: client_id,
      result: 'allow',
      detail: { client_name: body.client_name },
    });
    sendOAuthJson(res, 201, {
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      redirect_uris: body.redirect_uris,
      client_name: body.client_name,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    return true;
  }

  // ── GET /oauth/:team/authorize — the consent page ──
  if (method === 'GET' && rest === '/authorize') {
    requireTlsPeer(ctx, req, 'authorization');
    checkRateLimit(ctx, req, 'authorize');
    const query = parseOrOAuth(
      OAuthAuthorizeQuerySchema,
      Object.fromEntries(url.searchParams.entries()),
    );
    const client = getClientOrOAuth(ctx.db, team.id, query.client_id, res);
    if (!client) return true;
    if (!registeredRedirect(client, query.redirect_uri)) {
      sendOAuthError(
        res,
        new MusterdError('bad_request', 'redirect_uri is not registered for this client'),
      );
      return true;
    }
    sendHtml(
      res,
      200,
      consentPage({
        team: slug,
        clientName: client.client_name,
        ...(query.scope ? { scope: query.scope } : {}),
        client_id: query.client_id,
        redirect_uri: query.redirect_uri,
        state: query.state,
        code_challenge: query.code_challenge,
      }),
    );
    return true;
  }

  // ── POST /oauth/:team/authorize — the human proves the seat, the code rides the 302 ──
  if (method === 'POST' && rest === '/authorize') {
    requireTlsPeer(ctx, req, 'authorization');
    checkRateLimit(ctx, req, 'authorize');
    const raw = (await readBody(req)).toString('utf8');
    const flat = consentFormBody(raw);
    const body = parseOrOAuth(OAuthAuthorizeConfirmSchema, {
      client_id: flat.client_id,
      redirect_uri: flat.redirect_uri,
      state: flat.state,
      code_challenge: flat.code_challenge,
      code_challenge_method: flat.code_challenge_method,
      ...(flat.scope ? { scope: flat.scope } : {}),
      // The form posts flat fields; the proof rides the seam the ADR names. `agent_connect`
      // selects ADR 452's agent prover, `invite` ADR 450's; otherwise it is ADR 446's credential.
      proof: flat.agent_connect
        ? { kind: 'agent_connect', nonce: flat.agent_connect }
        : flat.invite
          ? { kind: 'invite', secret: flat.invite, name: flat.member }
          : {
              kind: 'credential',
              credential: flat.credential,
              ...(flat.member ? { member: flat.member } : {}),
            },
    });
    const client = getClientOrOAuth(ctx.db, team.id, body.client_id, res);
    if (!client) return true;
    if (!registeredRedirect(client, body.redirect_uri)) {
      sendOAuthError(
        res,
        new MusterdError('bad_request', 'redirect_uri is not registered for this client'),
      );
      return true;
    }
    let member: ReturnType<typeof getMemberByName>;
    let admittedVia: 'link' | 'code' | null = null;
    // ADR 452 §2.3: an agent connect issues its code INSIDE the supersede transaction, so no
    // earlier connect's code or chain can outlive this one (big-body 01M3DM1CQ2).
    let agentCode: string | null = null;
    if (body.proof.kind === 'agent_connect') {
      const nonce = connectNonceFrom(body.proof.nonce);
      const clientId = body.client_id;
      const redirectUri = body.redirect_uri;
      const codeChallenge = body.code_challenge;
      const scope = body.scope;
      const outcome = ctx.db.transaction(
        (): { err: MusterdError } | { agent: MemberRow; code: string } => {
          const agent = nonce ? redeemAgentConnectNonce(ctx.db, team.id, nonce) : null;
          if (!agent) {
            appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'member.agent_connect_refused',
              target: null,
              result: 'deny',
              detail: { client_id: clientId, reason: nonce ? 'invalid' : 'malformed' },
            });
            return {
              err: new MusterdError(
                'unauthorized',
                "that connect link isn't valid — ask your sponsor for a new one",
              ),
            };
          }
          // One OAuth occupant per agent: every prior chain AND every unexchanged code goes.
          const chains = revokeAllForMember(ctx.db, team.id, agent.id);
          const codes = burnUnexchangedCodes(ctx.db, team.id, agent.id);
          if (chains + codes > 0)
            appendAudit(ctx.db, team.id, {
              actor: agent.name,
              action: 'oauth.revoked',
              target: clientId,
              result: 'allow',
              detail: { reason: 'superseded', chains, codes },
            });
          const { code } = issueCode(ctx.db, {
            teamId: team.id,
            memberId: agent.id,
            clientId,
            redirectUri,
            codeChallenge,
            ...(scope ? { scope } : {}),
          });
          const sponsor = agent.sponsored_by
            ? ctx.db
                .prepare<[string], { name: string }>('SELECT name FROM members WHERE id = ?')
                .get(agent.sponsored_by)?.name
            : undefined;
          appendAudit(ctx.db, team.id, {
            actor: sponsor ?? null,
            action: 'member.agent_connected',
            target: agent.name,
            result: 'allow',
            detail: { client_id: clientId, client_name: client.client_name },
          });
          return { agent, code };
        },
      )();
      if ('err' in outcome) {
        sendOAuthError(res, outcome.err);
        return true;
      }
      member = outcome.agent;
      agentCode = outcome.code;
    } else if (body.proof.kind === 'invite') {
      // ADR 450 §2: a stranger proves an admin gave them an invite, then becomes a NEW human
      // member — one transaction: check-and-charge, name refusal, addMember, consume, audit.
      const proof = body.proof;
      const clientId = body.client_id;
      const teamRow = requireTeam(ctx.db, slug);
      const outcome = ctx.db.transaction(() => {
        const check = checkInvite(ctx.db, team.id, proof.secret);
        if (!check.ok) {
          appendAudit(ctx.db, team.id, {
            actor: null,
            action: 'member.invite_refused',
            target: check.selector,
            result: 'deny',
            detail: { client_id: clientId, via: check.via, charged: check.charged },
          });
          return { err: new MusterdError('unauthorized', "that invite isn't valid for this team") };
        }
        // Any row by that name — live OR tombstoned — refuses: `addMember` would revive a removed
        // seat (ADR 065), and a stranger must never inherit someone else's history. Not charged.
        if (getMemberByName(ctx.db, team.id, proof.name)) {
          return { err: new MusterdError('conflict', 'that name is taken — pick another') };
        }
        const added = addMember(ctx.db, teamRow, {
          name: proof.name,
          kind: 'human',
          ...(check.invite.member_until !== null
            ? { lifecycle: 'until' as const, lifecycleUntil: check.invite.member_until }
            : {}),
        });
        // `added.token` (the member's mscr_) is dropped here on purpose: never shown, never logged.
        consumeInvite(ctx.db, check.invite.id);
        appendAudit(ctx.db, team.id, {
          actor: added.row.name,
          action: 'member.invite_admitted',
          target: check.invite.id,
          result: 'allow',
          detail: { client_id: clientId, via: check.via },
        });
        return { row: added.row, via: check.via };
      })();
      if ('err' in outcome) {
        sendOAuthError(res, outcome.err);
        return true;
      }
      member = outcome.row;
      admittedVia = outcome.via;
    } else {
      // The seat proves itself with its own mscr_ — authMember is the same check the claim
      // handshake runs (self-identifying, acting-seat must match, departed seats refused).
      let memberName: string;
      try {
        const auth = authMember(
          ctx.db,
          slug,
          body.proof.credential,
          body.proof.member || undefined,
        );
        memberName = auth.member.name;
      } catch (err) {
        sendOAuthError(res, err);
        return true;
      }
      member = getMemberByName(ctx.db, team.id, memberName);
    }
    if (!member) {
      sendOAuthError(res, new MusterdError('unauthorized', 'seat is gone'));
      return true;
    }
    const memberName = member.name;
    const code =
      agentCode ??
      issueCode(ctx.db, {
        teamId: team.id,
        memberId: member.id,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        codeChallenge: body.code_challenge,
        ...(body.scope ? { scope: body.scope } : {}),
      }).code;
    appendAudit(ctx.db, team.id, {
      actor: memberName,
      action: 'oauth.code_issued',
      target: body.client_id,
      result: 'allow',
      detail: admittedVia ? { admitted_via: admittedVia } : {},
    });
    const location = `${body.redirect_uri}${body.redirect_uri.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}&state=${encodeURIComponent(body.state)}`;
    res.writeHead(302, {
      location,
      'cache-control': 'no-store',
      pragma: 'no-cache',
    });
    res.end();
    return true;
  }

  // ── POST /oauth/:team/token — code → pair, refresh → rotated pair ──
  if (method === 'POST' && rest === '/token') {
    requireTlsPeer(ctx, req, 'token issuance');
    checkRateLimit(ctx, req, 'token');
    const parsed = OAuthTokenRequestSchema.safeParse(await readTokenRequestBody(req));
    if (!parsed.success) {
      sendTokenError(
        res,
        400,
        'invalid_request',
        'grant_type must be authorization_code or refresh_token with its fields',
      );
      return true;
    }
    const tokenReq = parsed.data;
    // Unknown client is 401 invalid_client on both grants (RFC 6749 §5.2) — never an oracle.
    try {
      getClient(ctx.db, team.id, tokenReq.client_id);
    } catch {
      sendTokenError(res, 401, 'invalid_client', 'unknown client for this team');
      return true;
    }
    if (tokenReq.grant_type === 'authorization_code') {
      try {
        const { memberId, scope } = redeemCode(ctx.db, {
          teamId: team.id,
          clientId: tokenReq.client_id,
          code: tokenReq.code,
          redirectUri: tokenReq.redirect_uri,
          verifier: tokenReq.code_verifier,
        });
        // ADR 452 §4: a member who left, was disabled, or expired in the 90s since authorize gets
        // no chain (the code is already burned). Same rule as authMember, one statement of it.
        const owner = ctx.db
          .prepare<[string], MemberRow>('SELECT * FROM members WHERE id = ?')
          .get(memberId);
        const ended = owner
          ? memberStandingRefusal(owner)
          : new MusterdError('unauthorized', 'seat is gone');
        if (ended) throw ended;
        const pair = mintTokenPair(ctx.db, {
          teamId: team.id,
          memberId,
          clientId: tokenReq.client_id,
          scope,
        });
        const memberName = ctx.db
          .prepare<[string], { name: string }>('SELECT name FROM members WHERE id = ?')
          .get(memberId)?.name;
        appendAudit(ctx.db, team.id, {
          actor: memberName ?? null,
          action: 'oauth.token_issued',
          target: tokenReq.client_id,
          result: 'allow',
          detail: {},
        });
        sendOAuthJson(res, 200, {
          access_token: pair.access_token,
          token_type: 'Bearer',
          expires_in: pair.expires_in,
          refresh_token: pair.refresh_token,
          ...(scope ? { scope } : {}),
        });
        return true;
      } catch (err) {
        const me = asMusterdError(err);
        sendTokenError(res, 400, 'invalid_grant', me.message);
        return true;
      }
    }
    // refresh_token rotation — reuse of a burned refresh revokes the chain (the store throws).
    try {
      const pair = rotateRefresh(ctx.db, {
        teamId: team.id,
        clientId: tokenReq.client_id,
        refreshToken: tokenReq.refresh_token,
      });
      const owner = chainMember(ctx.db, team.id, tokenReq.client_id, tokenReq.refresh_token);
      appendAudit(ctx.db, team.id, {
        actor: owner,
        action: 'oauth.token_rotated',
        target: tokenReq.client_id,
        result: 'allow',
        detail: {},
      });
      sendOAuthJson(res, 200, {
        access_token: pair.access_token,
        token_type: 'Bearer',
        expires_in: pair.expires_in,
        refresh_token: pair.refresh_token,
      });
      return true;
    } catch (err) {
      const me = asMusterdError(err);
      const reused = /reused/.test(me.message);
      if (reused) {
        appendAudit(ctx.db, team.id, {
          actor: chainMember(ctx.db, team.id, tokenReq.client_id, tokenReq.refresh_token),
          action: 'oauth.token_reused_revoked',
          target: tokenReq.client_id,
          result: 'deny',
          detail: { reason: 'refresh_reused' },
        });
      }
      sendTokenError(res, 400, 'invalid_grant', me.message);
      return true;
    }
  }

  // ── /oauth/:team/revoke — RFC 7009 sign-out (GET renders the form, POST burns) ──
  if (rest === '/revoke') {
    requireTlsPeer(ctx, req, 'revocation');
    if (method === 'GET') {
      sendHtml(
        res,
        200,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>
<h1>Sign out a phone seat on ${escapeHtml(slug)}</h1>
<form method="post" action="">
<label>Token (<code>msat_…</code> or <code>msrt_…</code>) <input type="password" name="token"></label><br>
<button type="submit">Revoke</button></form></body></html>`,
      );
      return true;
    }
    if (method === 'POST') {
      checkRateLimit(ctx, req, 'token');
      const raw = await readTokenRequestBody(req);
      const token =
        typeof (raw as Record<string, unknown>)['token'] === 'string'
          ? ((raw as Record<string, unknown>)['token'] as string)
          : '';
      // RFC 7009 §2.2.1: an invalid token still answers 200 — revocation is not an oracle.
      const owner = token ? chainMember(ctx.db, team.id, null, token) : null;
      const revoked = token ? revokeToken(ctx.db, team.id, token) : false;
      appendAudit(ctx.db, team.id, {
        actor: owner,
        action: 'oauth.revoked',
        target: null,
        result: 'allow',
        detail: revoked ? {} : { reason: 'unknown_token' },
      });
      sendOAuthJson(res, 200, {});
      return true;
    }
  }

  return false;
}

/** Unknown client on the browser legs is a musterd-shaped 401, not a redirect (never bounce). */
function getClientOrOAuth(
  db: Database,
  teamId: string,
  clientId: string,
  res: ServerResponse,
): { client_id: string; client_name: string; redirect_uris: string } | null {
  try {
    const row = getClient(db, teamId, clientId);
    return {
      client_id: row.client_id,
      client_name: row.client_name,
      redirect_uris: row.redirect_uris,
    };
  } catch (err) {
    sendOAuthError(res, err);
    return null;
  }
}

/** Exact-match against registered URIs — no prefix/substring matching (ADR 446 §5). */
function registeredRedirect(client: { redirect_uris: string }, uri: string): boolean {
  let registered: string[];
  try {
    registered = JSON.parse(client.redirect_uris);
  } catch {
    return false;
  }
  return Array.isArray(registered) && registered.includes(uri);
}
