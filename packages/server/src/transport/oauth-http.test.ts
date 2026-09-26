import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { __setInviteKeyForTest } from '../store/invites.js';
import { addMember } from '../store/members.js';
import { getTeamBySlug } from '../store/teams.js';
import { resetMcpHandlersForTest } from './mcpHttp.js';
import { __oauthBucketSizeForTest, __resetOAuthBucketsForTest, isTlsPeer } from './oauth.js';

/**
 * The remote-MCP rail over HTTP (ADR 446) — the daemon as a minimal OAuth 2.1 server plus the
 * Streamable-HTTP `/mcp/:team` mount.
 *
 * What's asserted is the abuse posture (§5) and the Done line (§7): PKCE-required, codes
 * single-use, refresh rotation with reuse-revokes-chain, bearer team/member scoping, non-TLS
 * refusal, no secret in logs/audit, and the join→inbox→send loop over MCP frames.
 */
let server: RunningServer;
let base: string;
let nickCred: string;

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'https://app.example/cb';

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    json: text ? (JSON.parse(text) as any) : null,
    text,
  };
}

async function postForm(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: safeJson(text) };
}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: safeJson(text) };
}

function safeJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const audits = (action: string) => {
  const team = getTeamBySlug(server.db, 'dawn')!;
  return listAudit(server.db, team.id).filter((r) => r.action === action);
};

async function registerClient(redirectUris: string[] = [REDIRECT], name = 'Claude') {
  return postJson('/oauth/dawn/register', {
    redirect_uris: redirectUris,
    client_name: name,
  });
}

/** Full browser leg: authorize POST (302) → code → token POST → pair. */
async function signInPair(credential: string, member = 'nick', verifier = VERIFIER) {
  const reg = await registerClient();
  const client_id = reg.json.client_id as string;
  const authz = await postForm('/oauth/dawn/authorize', {
    client_id,
    redirect_uri: REDIRECT,
    state: 's1',
    code_challenge: verifier === VERIFIER ? CHALLENGE : 'wrong',
    code_challenge_method: 'S256',
    member,
    credential,
  });
  if (authz.status !== 302) return { authz, pair: null as any, client_id };
  const location = authz.headers.get('location')!;
  const code = new URL(location).searchParams.get('code')!;
  const token = await postForm('/oauth/dawn/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id,
    code_verifier: verifier,
  });
  return { authz, pair: token.json, client_id };
}

/** One MCP frame over Streamable HTTP; parses a JSON or SSE response into the result. */
async function mcpCall(bearer: string, method: string, params: unknown, id: number | string = 1) {
  const res = await fetch(base + '/mcp/dawn', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    return { status: res.status, json: JSON.parse(data) as any, headers: res.headers };
  }
  return {
    status: res.status,
    json: (text ? JSON.parse(text) : null) as any,
    headers: res.headers,
  };
}

beforeEach(async () => {
  __resetOAuthBucketsForTest();
  resetMcpHandlersForTest();
  __setInviteKeyForTest(randomBytes(32));
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await postJson('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  nickCred = team.json.human_credential;
});

afterEach(async () => {
  await server.close();
});

describe('OAuth discovery (ADR 446 §3)', () => {
  it('serves protected-resource metadata naming the per-team issuer', async () => {
    const res = await get('/.well-known/oauth-protected-resource/mcp/dawn');
    expect(res.status).toBe(200);
    expect(res.json.resource).toBe(`${base}/mcp/dawn`);
    expect(res.json.authorization_servers).toHaveLength(1);
    expect(res.json.bearer_methods_supported).toContain('header');
  });

  it('serves authorization-server metadata at both the team and path-inserted variants', async () => {
    for (const p of [
      '/.well-known/oauth-authorization-server/dawn',
      '/oauth/dawn/.well-known/oauth-authorization-server',
    ]) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(res.json.code_challenge_methods_supported).toEqual(['S256']);
      expect(res.json.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(res.json.issuer).toBe(`${base}/oauth/dawn`);
    }
  });

  it('the global authorization-server document 404s rather than naming a wrong team', async () => {
    const res = await get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(404);
  });
});

describe('RFC 8707 resource indicator (ADR 457)', () => {
  // MCP clients send resource=<MCP endpoint> on authorize and token. Until 2026-09-26 the token
  // schema was strict, so a real client's exchange 400'd right after the human finished sign-in.
  it('token exchange accepts resource when it names this team\u2019s MCP endpoint', async () => {
    const reg = await registerClient();
    const client_id = reg.json.client_id as string;
    const authz = await postForm('/oauth/dawn/authorize', {
      client_id,
      redirect_uri: REDIRECT,
      state: 's1',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      member: 'nick',
      credential: nickCred,
    });
    expect(authz.status).toBe(302);
    const code = new URL(authz.headers.get('location')!).searchParams.get('code')!;
    const token = await postForm('/oauth/dawn/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: VERIFIER,
      resource: `${base}/mcp/dawn`,
    });
    expect(token.status).toBe(200);
    expect(token.json.access_token).toMatch(/^msat_/);
    const refreshed = await postForm('/oauth/dawn/token', {
      grant_type: 'refresh_token',
      refresh_token: token.json.refresh_token,
      client_id,
      resource: `${base}/mcp/dawn/`,
    });
    expect(refreshed.status).toBe(200);
  });

  it('a resource that is not this team\u2019s endpoint is invalid_target on token and 400 on authorize', async () => {
    const reg = await registerClient();
    const client_id = reg.json.client_id as string;
    const authz = await get(
      `/oauth/dawn/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&code_challenge=${CHALLENGE}&code_challenge_method=S256&resource=${encodeURIComponent(`${base}/mcp/other`)}`,
    );
    expect(authz.status).toBe(400);
    const token = await postForm('/oauth/dawn/token', {
      grant_type: 'authorization_code',
      code: 'whatever',
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: VERIFIER,
      resource: 'https://elsewhere.example/mcp/dawn',
    });
    expect(token.status).toBe(400);
    expect(token.json.error).toBe('invalid_target');
  });
});

describe('client registration (ADR 446 §3/§5)', () => {
  it('registers a public client and audits without secrets', async () => {
    const res = await registerClient();
    expect(res.status).toBe(201);
    expect(res.json.client_id).toMatch(/^cid_/);
    expect(res.json.client_secret).toBeUndefined();
    expect(res.json.token_endpoint_auth_method).toBe('none');
    const rows = audits('oauth.client_registered');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toMatch(/mscr_|msat_|msrt_/);
  });

  it('refuses wildcard, plaintext, and private-host redirect URIs — and confidential clients', async () => {
    for (const uri of [
      'https://*.example/cb',
      'http://app.example/cb',
      'https://192.168.1.7/cb',
      'https://10.0.0.5/cb',
      'not-a-url',
    ]) {
      const res = await registerClient([uri]);
      expect(res.status).toBe(400);
    }
    // Loopback http is for desktop testing only — allowed at registration.
    // (Buckets reset: the five refusals above already spent this IP's minute.)
    __resetOAuthBucketsForTest();
    expect((await registerClient(['http://127.0.0.1:5174/cb'])).status).toBe(201);
    // Confidential clients are not issued in increment 1.
    const res = await postJson('/oauth/dawn/register', {
      redirect_uris: [REDIRECT],
      client_name: 'Conf',
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(res.status).toBe(400);
  });

  it('rate-limits registration (5/min/IP)', async () => {
    for (let i = 0; i < 5; i++) expect((await registerClient()).status).toBe(201);
    const res = await registerClient();
    expect(res.status).toBe(429);
    expect(res.json.error.code).toBe('rate_limited');
  });

  it('registers a Claude-shaped RFC 7591 body — grant_types/response_types accepted, not negotiated', async () => {
    // The real phone connectors send RFC 7591 §2 grant_types/response_types in DCR; landed
    // code 400d them ("Unrecognized key(s)"), locking every real app out at the first step.
    const res = await postJson('/oauth/dawn/register', {
      redirect_uris: [REDIRECT],
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(res.status).toBe(201);
    expect(res.json.client_id).toMatch(/^cid_/);
    // The server issues exactly one flow regardless of what was asked for.
    expect(res.json.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(res.json.response_types).toEqual(['code']);
  });
});

describe('authorization + token (ADR 446 §3/§5)', () => {
  it('consent page names the app and team; PKCE downgrade refused', async () => {
    const reg = await registerClient();
    const q = (extra: string) =>
      `/oauth/dawn/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&code_challenge=${CHALLENGE}${extra}`;
    const ok = await get(q('&code_challenge_method=S256'));
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Claude');
    expect(ok.text).toContain('dawn');
    expect(ok.text).not.toContain(nickCred);
    for (const m of ['plain', 'none']) {
      expect((await get(q(`&code_challenge_method=${m}`))).status).toBe(400);
    }
  });

  it('unregistered redirect_uris fail closed WITHOUT a bounce', async () => {
    const reg = await registerClient();
    const res = await get(
      `/oauth/dawn/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&state=s&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('wrong credential proves nothing — no code, no audit', async () => {
    const reg = await registerClient();
    const res = await postForm('/oauth/dawn/authorize', {
      client_id: reg.json.client_id,
      redirect_uri: REDIRECT,
      state: 's',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      member: 'nick',
      credential: 'mscr_wrong',
    });
    expect(res.status).toBe(401);
    expect(audits('oauth.code_issued')).toHaveLength(0);
  });

  it('code → pair → bearer works; replay fails closed with invalid_grant', async () => {
    const reg = await registerClient();
    const client_id = reg.json.client_id as string;
    const authz = await postForm('/oauth/dawn/authorize', {
      client_id,
      redirect_uri: REDIRECT,
      state: 's1',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      member: 'nick',
      credential: nickCred,
    });
    expect(authz.status).toBe(302);
    const location = authz.headers.get('location')!;
    expect(location.startsWith(`${REDIRECT}?code=`)).toBe(true);
    expect(location).toContain('state=s1');
    expect(authz.headers.get('cache-control')).toContain('no-store');
    const code = new URL(location).searchParams.get('code')!;

    const tokenBody = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: VERIFIER,
    };
    const token = await postForm('/oauth/dawn/token', tokenBody);
    expect(token.status).toBe(200);
    const pair = token.json;
    expect(pair.access_token).toMatch(/^msat_/);
    expect(pair.refresh_token).toMatch(/^msrt_/);
    expect(pair.token_type).toBe('Bearer');
    expect(audits('oauth.token_issued')).toHaveLength(1);

    // The spent code, presented again, is refused — single-use is transactional.
    const replay = await postForm('/oauth/dawn/token', tokenBody);
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe('invalid_grant');
  });

  it('refresh rotates; reuse revokes the chain and audits the theft signal', async () => {
    const { pair, client_id } = await signInPair(nickCred);
    const rot = await postForm('/oauth/dawn/token', {
      grant_type: 'refresh_token',
      refresh_token: pair.refresh_token,
      client_id,
    });
    expect(rot.status).toBe(200);
    expect(rot.json.access_token).not.toBe(pair.access_token);
    expect(audits('oauth.token_rotated')).toHaveLength(1);

    const reuse = await postForm('/oauth/dawn/token', {
      grant_type: 'refresh_token',
      refresh_token: pair.refresh_token,
      client_id,
    });
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe('invalid_grant');
    const theft = audits('oauth.token_reused_revoked');
    expect(theft).toHaveLength(1);
    expect(theft[0]?.actor).toBe('nick');
    expect(theft[0]?.result).toBe('deny');

    // The whole chain is dead — including the rotated pair.
    const probe = await postForm('/oauth/dawn/token', {
      grant_type: 'refresh_token',
      refresh_token: rot.json.refresh_token,
      client_id,
    });
    expect(probe.status).toBe(400);
  });

  it('revocation burns the token; unknown tokens still answer 200', async () => {
    const { pair } = await signInPair(nickCred);
    const revoke = await postForm('/oauth/dawn/revoke', { token: pair.access_token });
    expect(revoke.status).toBe(200);
    const inbox = await mcpCall(pair.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    // A revoked bearer cannot even open the exchange.
    expect(inbox.status).toBe(401);
    expect(audits('oauth.revoked')).toHaveLength(1);

    const unknown = await postForm('/oauth/dawn/revoke', { token: 'msat_nothing' });
    expect(unknown.status).toBe(200);
  });
});

describe('transport posture (ADR 446 §1/§5)', () => {
  it('OAuth + bearer refuse plaintext off-loopback; loopback passes', () => {
    const local = { socket: { remoteAddress: '127.0.0.1' }, headers: {} } as any;
    const ctx = { config: { trustProxy: false } } as any;
    expect(isTlsPeer(ctx, local)).toBe(true);
    const remotePlain = { socket: { remoteAddress: '203.0.113.7' }, headers: {} } as any;
    expect(isTlsPeer(ctx, remotePlain)).toBe(false);
    const viaTunnel = {
      socket: { remoteAddress: '203.0.113.7' },
      headers: { 'x-forwarded-proto': 'https' },
    } as any;
    expect(isTlsPeer(ctx, viaTunnel)).toBe(true);
  });

  it('cross-team bearers are refused on /mcp', async () => {
    await postJson('/teams', { slug: 'dusk', creator: { name: 'zed', kind: 'human' } });
    const { pair } = await signInPair(nickCred);
    const res = await fetch(base + '/mcp/dusk', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${pair.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('no secret ever reaches the audit detail — codes, tokens, credentials', async () => {
    await signInPair(nickCred);
    const team = getTeamBySlug(server.db, 'dawn')!;
    const rows = listAudit(server.db, team.id).filter((r) => r.action.startsWith('oauth.'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toMatch(/mscr_|msat_|msrt_|code=[A-Za-z0-9_-]{10}/);
    }
  });
});

describe('decline fixes (re-review)', () => {
  it('oversize bodies are refused 413 before buffering', async () => {
    const big = 'x'.repeat(70 * 1024);
    const reg = await postJson('/oauth/dawn/register', {
      redirect_uris: [REDIRECT],
      client_name: 'Big',
      padding: big,
    });
    expect(reg.status).toBe(413);
    expect(reg.json.error.code).toBe('payload_too_large');
    const token = await postForm('/oauth/dawn/token', {
      grant_type: 'refresh_token',
      refresh_token: `msrt_${big}`,
      client_id: 'cid_x',
    });
    expect(token.status).toBe(413);
  });

  it('short verifiers never reach the store — invalid_request', async () => {
    const reg = await registerClient();
    const client_id = reg.json.client_id as string;
    const authz = await postForm('/oauth/dawn/authorize', {
      client_id,
      redirect_uri: REDIRECT,
      state: 's',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      member: 'nick',
      credential: nickCred,
    });
    expect(authz.status).toBe(302);
    const code = new URL(authz.headers.get('location')!).searchParams.get('code')!;
    const token = await postForm('/oauth/dawn/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: 'too-short',
    });
    expect(token.status).toBe(400);
    expect(token.json.error).toBe('invalid_request');
  });

  it('malformed challenges are refused at the consent legs', async () => {
    const reg = await registerClient();
    const client_id = reg.json.client_id as string;
    const q =
      `/oauth/dawn/authorize?response_type=code&client_id=${client_id}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&code_challenge=short&code_challenge_method=S256`;
    expect((await get(q)).status).toBe(400);
    const post = await postForm('/oauth/dawn/authorize', {
      client_id,
      redirect_uri: REDIRECT,
      state: 's',
      code_challenge: 'short',
      code_challenge_method: 'S256',
      member: 'nick',
      credential: nickCred,
    });
    expect(post.status).toBe(400);
  });

  it('without trustProxy, X-Forwarded-For is untrusted — one shared bucket', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await postJson(
        '/oauth/dawn/register',
        { redirect_uris: [REDIRECT], client_name: `A${i}` },
        { 'x-forwarded-for': '198.51.100.7' },
      );
      expect(res.status).toBe(201);
    }
    // A different XFF does not open a new bucket when trustProxy is off.
    const res = await postJson(
      '/oauth/dawn/register',
      { redirect_uris: [REDIRECT], client_name: 'B' },
      { 'x-forwarded-for': '203.0.113.9' },
    );
    expect(res.status).toBe(429);
  });

  it('with trustProxy, buckets key off CF-Connecting-IP — XFF is untrusted', async () => {
    const proxyServer = createServer({ db: openDb(':memory:'), port: 0, trustProxy: true });
    const { port } = await proxyServer.listen();
    const proxyBase = `http://127.0.0.1:${port}`;
    try {
      const team = await fetch(proxyBase + '/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'dawn', creator: { name: 'nick', kind: 'human' } }),
      });
      expect(team.status).toBe(201);
      const reg = async (name: string, headers: Record<string, string>) => {
        const res = await fetch(proxyBase + '/oauth/dawn/register', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // The tunnel terminates TLS: loopback socket + https proto = the allowed shape.
            'x-forwarded-proto': 'https',
            ...headers,
          },
          body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: name }),
        });
        return res.status;
      };
      const ccip = (ip: string) => ({ 'cf-connecting-ip': ip });
      for (let i = 0; i < 5; i++) {
        expect(await reg(`A${i}`, ccip('198.51.100.7'))).toBe(201);
        expect(await reg(`B${i}`, ccip('203.0.113.9'))).toBe(201);
      }
      // Each edge-reported IP spent only its own bucket.
      expect(await reg('A5', ccip('198.51.100.7'))).toBe(429);
      expect(await reg('B5', ccip('203.0.113.9'))).toBe(429);
      expect(await reg('C0', ccip('192.0.2.1'))).toBe(201);

      // Spoofed XFF rotates under a fixed CF-IP: no new buckets open (XFF ignored).
      __resetOAuthBucketsForTest();
      for (let i = 0; i < 5; i++) {
        expect(
          await reg(`S${i}`, { ...ccip('198.51.100.7'), 'x-forwarded-for': `10.9.9.${i}` }),
        ).toBe(201);
      }
      expect(await reg('S5', { ...ccip('198.51.100.7'), 'x-forwarded-for': '10.9.9.99' })).toBe(
        429,
      );

      // Churn: 100 distinct visitor IPs each succeed once; cardinality tracks keys, nothing more.
      __resetOAuthBucketsForTest();
      for (let i = 0; i < 100; i++) {
        expect(await reg(`C${i}`, ccip(`192.0.2.${i % 250}`))).toBe(201);
      }
      expect(__oauthBucketSizeForTest()).toBeLessThanOrEqual(100);
    } finally {
      await proxyServer.close();
    }
  });

  it('credential-shaped team slugs are never echoed — /mcp edition', async () => {
    const secret = `mscr_${'f'.repeat(40)}`;
    const res = await fetch(`${base}/mcp/${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(secret);
    const oauth = await get(`/.well-known/oauth-protected-resource/mcp/${secret}`);
    expect(oauth.status).toBe(404);
    expect(oauth.text).not.toContain(secret);
  });
});

describe('/mcp/:team — the Done line (ADR 446 §7)', () => {
  it('join → inbox → send works over MCP frames', async () => {
    const { pair } = await signInPair(nickCred);

    const init = await mcpCall(pair.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'phone', version: '0' },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe('musterd');

    const list = await mcpCall(pair.access_token, 'tools/list', {}, 2);
    const names = list.json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['team_agent_create', 'team_inbox_check', 'team_join', 'team_send']);

    const join = await mcpCall(
      pair.access_token,
      'tools/call',
      {
        name: 'team_join',
        arguments: {},
      },
      3,
    );
    expect(JSON.stringify(join.json.result)).toContain('Already joined dawn as nick');

    const send = await mcpCall(
      pair.access_token,
      'tools/call',
      {
        name: 'team_send',
        arguments: { act: 'message', body: 'hello from the phone' },
      },
      4,
    );
    expect(JSON.stringify(send.json.result)).toContain('sent');

    const inbox = await mcpCall(
      pair.access_token,
      'tools/call',
      {
        name: 'team_inbox_check',
        arguments: { unread_only: true },
      },
      5,
    );
    // Our own send is excluded from our inbox (from_member != me) — the cursor proves the read.
    expect(inbox.json.result.content[0].text).toContain('cursor');
  });

  it('team_agent_create over MCP frames mints a sponsored agent and returns a connect link (ADR 449 §3)', async () => {
    const { pair } = await signInPair(nickCred);
    await mcpCall(pair.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'phone', version: '0' },
    });
    const made = await mcpCall(
      pair.access_token,
      'tools/call',
      { name: 'team_agent_create', arguments: { name: 'nick-scout', role: 'research' } },
      2,
    );
    const text: string = made.json.result.content[0].text;
    expect(made.json.result.isError).toBeUndefined();
    expect(text).toContain('Created agent "nick-scout"');
    expect(text).toMatch(/\/join\/dawn#n=[A-Za-z0-9_-]{43}/);
    expect(text).not.toMatch(/ms(cr|ac|at|kd)_/);
    const row = server.db
      .prepare("SELECT kind, sponsored_by FROM members WHERE name = 'nick-scout'")
      .get() as { kind: string; sponsored_by: string };
    const dawn = getTeamBySlug(server.db, 'dawn')!;
    const nick = server.db
      .prepare("SELECT id FROM members WHERE team_id = ? AND name = 'nick'")
      .get(dawn.id) as { id: string };
    expect(row).toEqual({ kind: 'agent', sponsored_by: nick.id });
    expect(audits('member.sponsored_agent_created')).toHaveLength(1);

    const dup = await mcpCall(
      pair.access_token,
      'tools/call',
      { name: 'team_agent_create', arguments: { name: 'nick-scout' } },
      3,
    );
    expect(dup.json.result.isError).toBe(true);
    expect(dup.json.result.content[0].text).toContain('already exists');
  });

  it('missing bearer is 401; unknown team is 404', async () => {
    const res = await fetch(base + '/mcp/dawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
    const ghost = await fetch(base + '/mcp/nope', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer msat_nothing',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(ghost.status).toBe(404);
  });

  it('MCP 401 challenges name the protected-resource metadata (RFC 9728 §5.1)', async () => {
    // fifty's accept note on 01M3AKN6GF: a bare Bearer leaves a spec-following client
    // guessing the discovery path — resource_metadata points at this team's document.
    const metadata = `${base}/.well-known/oauth-protected-resource/mcp/dawn`;
    const missing = await fetch(base + '/mcp/dawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${metadata}"`);
    const bogus = await fetch(base + '/mcp/dawn', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer msat_nothing',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(bogus.status).toBe(401);
    expect(bogus.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token" resource_metadata="${metadata}"`,
    );
  });
});

describe('invite prover at authorize (ADR 450)', () => {
  const admin = () => ({ authorization: `Bearer ${nickCred}` });

  async function mint(body: Record<string, unknown> = {}) {
    const res = await postJson('/teams/dawn/invites', body, admin());
    expect(res.status).toBe(201);
    return res.json as { invite: any; link_secret: string; room_code: string };
  }

  /** Authorize with an invite proof; returns the 302 (or the refusal). */
  async function authorizeInvite(invite: string, member: string, client_id?: string) {
    const cid = client_id ?? ((await registerClient()).json.client_id as string);
    const authz = await postForm('/oauth/dawn/authorize', {
      client_id: cid,
      redirect_uri: REDIRECT,
      state: 's1',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      invite,
      member,
    });
    return { authz, client_id: cid };
  }

  async function tokenFor(authz: Awaited<ReturnType<typeof postForm>>, client_id: string) {
    const code = new URL(authz.headers.get('location')!).searchParams.get('code')!;
    return postForm('/oauth/dawn/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: VERIFIER,
    });
  }

  it('the consent page offers both forms; mint/list/revoke are admin-only and never list the secret', async () => {
    const reg = await registerClient();
    const page = await get(
      `/oauth/dawn/authorize?client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&code_challenge=${CHALLENGE}&code_challenge_method=S256&response_type=code`,
    );
    expect(page.status).toBe(200);
    expect(page.text).toContain('name="invite"');
    expect(page.text).toContain('name="credential"');

    expect((await postJson('/teams/dawn/invites', {})).status).toBe(401);
    const m = await mint({ max_uses: 3 });
    expect(m.link_secret).toMatch(/^[0-9A-Z]{3}\.[A-Za-z0-9_-]+$/);
    expect(m.room_code).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const list = await get('/teams/dawn/invites', admin());
    expect(list.status).toBe(200);
    expect(list.json.invites[0]).toMatchObject({ id: m.invite.id, state: 'live', max_uses: 3 });
    const secretTail = m.link_secret.split('.')[1]!;
    expect(list.text).not.toContain(secretTail);
    expect(list.text).not.toContain(m.room_code.slice(4));
    expect(JSON.stringify(audits('invite.minted'))).not.toContain(secretTail);

    const del = await fetch(base + `/teams/dawn/invites/${m.invite.id}`, {
      method: 'DELETE',
      headers: admin(),
    });
    expect(del.status).toBe(200);
    expect((await get('/teams/dawn/invites', admin())).json.invites[0].state).toBe('revoked');
    expect(audits('invite.revoked')).toHaveLength(1);
  });

  it('a stranger with the room code becomes a NEW human member and reaches MCP; the link value works too', async () => {
    const m = await mint({ member_until: Date.now() + 3_600_000 });
    const { authz, client_id } = await authorizeInvite(m.room_code, 'ada');
    expect(authz.status).toBe(302);
    const tok = await tokenFor(authz, client_id);
    expect(tok.status).toBe(200);
    const inbox = await mcpCall(tok.json.access_token, 'tools/call', {
      name: 'team_inbox_check',
      arguments: {},
    });
    expect(inbox.error).toBeUndefined();

    const team = getTeamBySlug(server.db, 'dawn')!;
    const ada = server.db
      .prepare(
        'SELECT kind, lifecycle, lifecycle_until, sponsored_by, left_at FROM members WHERE team_id = ? AND name = ?',
      )
      .get(team.id, 'ada') as any;
    expect(ada).toMatchObject({
      kind: 'human',
      lifecycle: 'until',
      sponsored_by: null,
      left_at: null,
    });
    expect(ada.lifecycle_until).toBeGreaterThan(Date.now());

    const admitted = audits('member.invite_admitted');
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ actor: 'ada', target: m.invite.id });
    expect(JSON.stringify(admitted[0])).not.toContain(m.room_code.slice(4));
    expect(JSON.stringify(admitted[0])).not.toMatch(/mscr_|msat_|msrt_/);

    // The link spelling admits a second person against the same invite.
    const second = await authorizeInvite(m.link_secret, 'bo');
    expect(second.authz.status).toBe(302);
    expect((await get('/teams/dawn/invites', admin())).json.invites[0].uses).toBe(2);
  });

  it('wrong code, unknown selector, revoked, exhausted and burned all return the same refusal', async () => {
    const m = await mint({ fail_budget: 2, max_uses: 1 });
    const sel = m.invite.selector;
    const wrong = await authorizeInvite(`${sel}-ZZZZ-ZZZZ`, 'eve');
    expect(wrong.authz.status).toBe(401);
    const body1 = wrong.authz.text;
    const unknown = await authorizeInvite(`${sel === '777' ? '778' : '777'}-ZZZZ-ZZZZ`, 'eve');
    expect(unknown.authz.status).toBe(401);
    expect(unknown.authz.text).toBe(body1);
    // Second miss burns (budget 2); the right code is now refused too.
    await authorizeInvite(`${sel}-ZZZZ-ZZZY`, 'eve');
    const burned = await authorizeInvite(m.room_code, 'eve');
    expect(burned.authz.status).toBe(401);
    expect(burned.authz.text).toBe(body1);
    const inv = (await get('/teams/dawn/invites', admin())).json.invites.find(
      (i: any) => i.id === m.invite.id,
    );
    expect(inv).toMatchObject({ state: 'burned', failures: 2, uses: 0 });
    // eve never got a row.
    const team = getTeamBySlug(server.db, 'dawn')!;
    expect(
      server.db
        .prepare('SELECT id FROM members WHERE team_id = ? AND name = ?')
        .get(team.id, 'eve'),
    ).toBeUndefined();
    const refused = audits('member.invite_refused');
    expect(refused.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(refused)).not.toContain('ZZZZ');
  });

  it('burning one invite leaves another invite’s link and code usable (multi-invite)', async () => {
    const a = await mint({ fail_budget: 1 });
    const b = await mint();
    expect((await authorizeInvite(`${a.invite.selector}-ZZZZ-ZZZZ`, 'x1')).authz.status).toBe(401);
    expect((await authorizeInvite(a.room_code, 'x1')).authz.status).toBe(401);
    expect((await authorizeInvite(b.room_code, 'x2')).authz.status).toBe(302);
    expect((await authorizeInvite(b.link_secret, 'x3')).authz.status).toBe(302);
  });

  it('a taken name and a tombstoned name are refused with conflict and cost the invite nothing', async () => {
    const m = await mint();
    // nick is live; make a tombstone by adding + removing 'gone'.
    const team = getTeamBySlug(server.db, 'dawn')!;
    const gone = addMember(server.db, team, { name: 'gone', kind: 'human' });
    server.db.prepare('UPDATE members SET left_at = ? WHERE id = ?').run(Date.now(), gone.row.id);
    for (const name of ['nick', 'gone']) {
      const r = await authorizeInvite(m.room_code, name);
      expect(r.authz.status).toBe(409);
    }
    const inv = (await get('/teams/dawn/invites', admin())).json.invites.find(
      (i: any) => i.id === m.invite.id,
    );
    expect(inv).toMatchObject({ failures: 0, uses: 0, state: 'live' });
    // The tombstone was not revived.
    expect(
      (server.db.prepare('SELECT left_at FROM members WHERE id = ?').get(gone.row.id) as any)
        .left_at,
    ).not.toBeNull();
  });

  it('an invite-admitted member whose member_until has passed is refused at the token endpoint (ADR 449 §1)', async () => {
    const m = await mint({ member_until: Date.now() + 1_500 });
    const { authz, client_id } = await authorizeInvite(m.room_code, 'brief');
    expect(authz.status).toBe(302);
    const tok = await tokenFor(authz, client_id);
    expect(tok.status).toBe(200);
    const team = getTeamBySlug(server.db, 'dawn')!;
    server.db
      .prepare('UPDATE members SET lifecycle_until = ? WHERE team_id = ? AND name = ?')
      .run(Date.now() - 1, team.id, 'brief');
    const res = await fetch(base + '/mcp/dawn', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok.json.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'team_inbox_check', arguments: {} },
      }),
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe('agent seats over OAuth via the sponsor nonce (ADR 452)', () => {
  /** A human on `dawn` (optionally expiring) and their credential. */
  async function human(name: string, until?: number): Promise<string> {
    const r = await postJson('/teams/dawn/members', {
      name,
      kind: 'human',
      ...(until ? { lifecycle: 'until', lifecycle_until: until } : {}),
    });
    return r.json.human_credential as string;
  }

  async function createAgent(sponsorCred: string, name: string): Promise<string> {
    const r = await postJson(
      '/teams/dawn/members/agents',
      { name },
      { authorization: `Bearer ${sponsorCred}` },
    );
    expect(r.status).toBe(201);
    return r.json.connect_url as string;
  }

  async function reissue(sponsorCred: string, name: string): Promise<string> {
    const r = await postJson(
      `/teams/dawn/members/agents/${name}/connect`,
      {},
      { authorization: `Bearer ${sponsorCred}` },
    );
    return r.json.connect_url as string;
  }

  /** The browser leg with an `agent_connect` proof → the code (or the refusal). */
  async function authorizeAgent(pasted: string) {
    const reg = await registerClient([REDIRECT], 'Claude Code');
    const client_id = reg.json.client_id as string;
    const authz = await postForm('/oauth/dawn/authorize', {
      client_id,
      redirect_uri: REDIRECT,
      state: 's1',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      agent_connect: pasted,
    });
    const code =
      authz.status === 302
        ? new URL(authz.headers.get('location')!).searchParams.get('code')
        : null;
    return { authz, code, client_id };
  }

  async function exchange(code: string, client_id: string) {
    return postForm('/oauth/dawn/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: VERIFIER,
    });
  }

  async function connect(pasted: string) {
    const a = await authorizeAgent(pasted);
    expect(a.authz.status).toBe(302);
    const token = await exchange(a.code!, a.client_id);
    expect(token.status).toBe(200);
    return { pair: token.json, client_id: a.client_id };
  }

  async function joinedAs(bearer: string): Promise<string> {
    const r = await mcpCall(bearer, 'tools/call', { name: 'team_join', arguments: {} }, 9);
    return JSON.stringify(r.json?.result ?? r.json);
  }

  it('the pasted link signs the agent in: the chain is bound to the agent seat', async () => {
    const link = await createAgent(nickCred, 'nick-scout');
    const { pair } = await connect(link);
    expect(await joinedAs(pair.access_token)).toContain('Already joined dawn as nick-scout');
    const send = await mcpCall(
      pair.access_token,
      'tools/call',
      { name: 'team_send', arguments: { act: 'message', body: 'hello from the agent' } },
      2,
    );
    expect(JSON.stringify(send.json.result)).toContain('sent');
    const row = audits('member.agent_connected')[0]!;
    expect(row.actor).toBe('nick');
    expect(row.target).toBe('nick-scout');
    expect(JSON.stringify(audits('member.agent_connected'))).not.toContain(
      new URL(link).hash.slice(3),
    );
  });

  it('accepts the bare nonce and `n=<nonce>` as well as the whole link', async () => {
    const nonce = new URLSearchParams(new URL(await createAgent(nickCred, 'a1')).hash.slice(1)).get(
      'n',
    )!;
    expect((await authorizeAgent(nonce)).authz.status).toBe(302);
    const n2 = new URLSearchParams(new URL(await createAgent(nickCred, 'a2')).hash.slice(1)).get(
      'n',
    )!;
    expect((await authorizeAgent(`n=${n2}`)).authz.status).toBe(302);
  });

  it('a second redeem of the same nonce is refused, with one uniform body', async () => {
    const link = await createAgent(nickCred, 'nick-scout');
    await connect(link);
    const again = await authorizeAgent(link);
    expect(again.authz.status).toBe(401);
    expect(again.authz.text).toContain("that connect link isn't valid");
    expect(audits('member.agent_connect_refused')).toHaveLength(1);
    const junk = await authorizeAgent('Z'.repeat(43));
    expect(junk.authz.text).toBe(again.authz.text);
  });

  it('a reconnect with a re-issued nonce revokes the first chain', async () => {
    const first = await connect(await createAgent(nickCred, 'nick-scout'));
    expect(await joinedAs(first.pair.access_token)).toContain('nick-scout');
    await connect(await reissue(nickCred, 'nick-scout'));
    const stale = await mcpCall(first.pair.access_token, 'tools/list', {}, 3);
    expect(stale.status).toBe(401);
    expect(
      audits('oauth.revoked').some((r) => JSON.stringify(r.detail).includes('superseded')),
    ).toBe(true);
  });

  it('a code from the first connect, exchanged after the second connect, is refused', async () => {
    const early = await authorizeAgent(await createAgent(nickCred, 'nick-scout'));
    expect(early.authz.status).toBe(302);
    await connect(await reissue(nickCred, 'nick-scout'));
    const late = await exchange(early.code!, early.client_id);
    expect(late.status).toBe(400);
    expect(late.json.error).toBe('invalid_grant');
  });

  it("removing the sponsor refuses the agent's next tool call AND its next refresh", async () => {
    const dana = await human('dana');
    const { pair, client_id } = await connect(await createAgent(dana, 'dana-scout'));
    expect(await joinedAs(pair.access_token)).toContain('dana-scout');
    const removed = await postJson(
      '/teams/dawn/members/dana/remove',
      {},
      { authorization: `Bearer ${nickCred}` },
    );
    expect(removed.status).toBe(200);
    // §3: the cascade revokes the agent's chains outright — not only refused at use.
    const live = server.db
      .prepare(
        "SELECT COUNT(*) AS n FROM oauth_tokens t JOIN members m ON m.id = t.member_id WHERE m.name = 'dana-scout' AND t.revoked_at IS NULL",
      )
      .get() as { n: number };
    expect(live.n).toBe(0);
    expect((await mcpCall(pair.access_token, 'tools/list', {}, 4)).status).not.toBe(200);
    const refresh = await postForm('/oauth/dawn/token', {
      grant_type: 'refresh_token',
      refresh_token: pair.refresh_token,
      client_id,
    });
    expect(refresh.status).toBe(400);
    expect(refresh.json.error).toBe('invalid_grant');
  });

  it("an expiring sponsor's agent is told a lifetime no later than the sponsor's end", async () => {
    const until = Date.now() + 10 * 60_000;
    const dana = await human('dana', until);
    const { pair } = await connect(await createAgent(dana, 'dana-scout'));
    expect(pair.expires_in).toBeLessThanOrEqual(600);
  });

  it('a credential riding a pasted link (query or fragment) is refused at the schema, and the nonce survives', async () => {
    const link = await createAgent(nickCred, 'nick-scout');
    const url = new URL(link);
    const withQuery = `${url.origin}${url.pathname}?t=mscr_synthetic${url.hash}`;
    const withTail = `${link}&k=msac_synthetic`;
    for (const pasted of [withQuery, withTail]) {
      const res = await authorizeAgent(pasted);
      expect(res.authz.status).toBe(400);
    }
    expect(audits('member.agent_connect_refused')).toHaveLength(0);
    // Refused before redemption: the real link still works.
    expect((await authorizeAgent(link)).authz.status).toBe(302);
  });

  it('a credential pasted into the agent field is refused at the schema — never an auth attempt', async () => {
    const res = await authorizeAgent(nickCred + 'x'.repeat(20));
    expect(res.authz.status).toBe(400);
    expect(audits('member.agent_connect_refused')).toHaveLength(0);
  });
});
