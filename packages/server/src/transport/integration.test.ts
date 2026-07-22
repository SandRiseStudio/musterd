import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { get as httpGet, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import {
  FEATURE_EPOCH,
  GENERALIST_CAPABILITIES,
  PROTOCOL_VERSION,
  type WSServerFrame,
} from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getMemberByName, setMemberGovernance } from '../store/members.js';
import { getTeamBySlug } from '../store/teams.js';

let server: RunningServer;
let base: string;
let wsUrl: string;

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

afterEach(async () => {
  await server.close();
});

/** Poll a predicate until it's true or we time out (for state the server reaches asynchronously). */
async function pollUntil(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('pollUntil timed out');
}

/**
 * v0.3 auth descriptor (ADR 077, SPEC A.7 §253). A bare string is a self-identifying secret — a human
 * `mscr_` credential. An `{ key, seat }` is an agent acting as a seat: `Bearer <agent_key>` +
 * `x-musterd-seat`, mirroring the production HttpClient (commit 4d11b35).
 */
type Auth = string | { key: string; seat: string };
function authHeaders(auth?: Auth): Record<string, string> {
  if (!auth) return {};
  if (typeof auth === 'string') return { authorization: `Bearer ${auth}` };
  return { authorization: `Bearer ${auth.key}`, 'x-musterd-seat': auth.seat };
}

async function post(path: string, body: unknown, auth?: Auth) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(auth),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function get(path: string, auth?: Auth, extraHeaders?: Record<string, string>) {
  const res = await fetch(base + path, {
    headers: {
      ...authHeaders(auth),
      ...(extraHeaders ?? {}),
    },
  });
  return { status: res.status, json: (await res.json()) as any };
}

/** Like `post` but for a JSON-bodied request of any method; parses JSON only when a body is returned. */
async function req(method: string, path: string, body: unknown, auth?: Auth) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

/**
 * Raw GET against the test server: unlike undici's `fetch` (which auto-decodes and hides the header)
 * it never decompresses, so tests can assert the exact `content-encoding` and diff the raw body.
 */
function rawHttpGet(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    httpGet(base + path, { headers }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c) => chunks.push(c as Buffer));
      r.on('end', () =>
        resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }),
      );
    }).on('error', reject);
  });
}

/** Mint a standing seat grant (admin-authed) so an agent WS-claim occupies immediately, not pending. */
async function standingGrant(adminAuth: Auth, seat: string): Promise<string> {
  const r = await post(
    '/teams/dawn/grants',
    { scope: 'seat', target: seat, lifetime: 'standing' },
    adminAuth,
  );
  return r.json.token as string;
}

/** A test WS client that records frames and lets you await a specific type. */
class TestWs {
  ws: WebSocket;
  frames: WSServerFrame[] = [];
  private waiters: { type: string; resolve: (f: WSServerFrame) => void }[] = [];
  constructor() {
    this.ws = new WebSocket(wsUrl);
    this.ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as WSServerFrame;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => {
        if (w.type === f.type) {
          w.resolve(f);
          return false;
        }
        return true;
      });
    });
  }
  open() {
    return new Promise<void>((r) => this.ws.on('open', () => r()));
  }
  send(frame: unknown) {
    this.ws.send(JSON.stringify(frame));
  }
  waitFor(type: string, ms = 1000): Promise<WSServerFrame> {
    const existing = this.frames.find((f) => f.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
      this.waiters.push({
        type,
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
      });
    });
  }
  /**
   * v0.3 claim handshake (ADR 077). `key` is the team agent key (mskey_) or a human credential (mscr_);
   * an agent seat needs a `grant` to occupy immediately (else the server opens a pending request). The
   * success frame is `occupied` (the governed successor to `welcome`).
   */
  claim(
    team: string,
    key: string,
    seat: string,
    surface = 'cli',
    grant?: string,
    model?: string,
    driver?: string,
  ) {
    this.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team,
      key,
      target: { seat },
      ...(grant ? { grant } : {}),
      ...(model ? { model } : {}),
      ...(driver ? { driver } : {}),
      surface,
    });
    return this.waitFor('occupied');
  }
  subscribe(scope: 'team' | 'team-all' = 'team') {
    this.send({ type: 'subscribe', scope });
    return this.waitFor('subscribed');
  }
  countFrames(type: string) {
    return this.frames.filter((f) => f.type === type).length;
  }
  close() {
    this.ws.close();
  }
}

describe('HTTP API', () => {
  it('health responds with the protocol version, db path, schema version, and live-session count', async () => {
    const r = await get('/health');
    expect(r.json).toMatchObject({ ok: true, v: PROTOCOL_VERSION });
    expect(typeof r.json.db).toBe('string');
    expect(typeof r.json.schema).toBe('number');
    // ADR 047: derived cross-team count of live sessions; zero on a fresh daemon.
    expect(r.json.connections).toBe(0);
    // ADR 130: no buildRef configured → the build field is omitted, never null/empty.
    expect(r.json).not.toHaveProperty('build');
    // ADR 148: the daemon always names its own feature epoch — the roster's skew reference.
    expect(r.json.epoch).toBe(FEATURE_EPOCH);
  });

  it('health names the boot commit when the embedder passes buildRef (ADR 130)', async () => {
    const sha = 'b'.repeat(40);
    const s = createServer({ db: openDb(':memory:'), port: 0, buildRef: sha });
    const { port } = await s.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(((await res.json()) as { build?: string }).build).toBe(sha);
    } finally {
      await s.close();
    }
  });

  it('creates a team + creator token; duplicate slug is 409', async () => {
    const r = await post('/teams', {
      slug: 'dawn',
      creator: { name: 'nick', kind: 'human', role: 'lead' },
    });
    expect(r.status).toBe(201);
    expect(r.json.token).toMatch(/^mskd_/);
    // v0.3 P3 composite mint (SPEC A.7): agent key + creator credential + policy, each shown once.
    expect(r.json.agent_key).toMatch(/^mskey_/);
    expect(r.json.human_credential).toMatch(/^mscr_/);
    // Policy mints with defaults for every block — inc 5 added the residency knobs (ADR 131).
    expect(r.json.policy).toMatchObject({ allow_pre_issued_grants: false });
    expect(r.json.policy.residency.hourly_cap).toBe(2);
    expect(r.json.seat.name).toBe('nick');
    const dup = await post('/teams', { slug: 'dawn', creator: { name: 'x', kind: 'human' } });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('conflict');
  });

  it('sends and reads an inbox over HTTP with unread accounting', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
    const boTok = bo.json.human_credential; // a human seat authenticates with its own mscr_ credential

    const env = {
      id: 'mh1',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from: 'nick',
      to: { kind: 'member', name: 'bo' },
      act: 'message',
      body: 'hi bo',
      ts: Date.now(),
    };
    const sent = await post('/teams/dawn/messages', { envelope: env }, nickTok);
    expect(sent.status).toBe(201);

    const inbox1 = await get('/teams/dawn/inbox?unread=1', boTok);
    expect(inbox1.json.messages).toHaveLength(1);
    await post('/teams/dawn/inbox/cursor', { last_read_message_id: 'mh1' }, boTok);
    const inbox2 = await get('/teams/dawn/inbox?unread=1', boTok);
    expect(inbox2.json.messages).toHaveLength(0);
  });

  it('a second human member is minted a credential that authenticates (ADR 069 cutover gap)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    // A non-creator human seat gets its own mscr_ credential, returned once (parallel to the creator).
    const bo = await post(
      '/teams/dawn/members',
      { name: 'bo', kind: 'human' },
      team.json.human_credential,
    );
    expect(bo.json.human_credential).toMatch(/^mscr_/);
    // …and it authenticates as bo (the credential is self-identifying).
    const inbox = await get('/teams/dawn/inbox', bo.json.human_credential);
    expect(inbox.status).toBe(200);
    // An agent member gets NO credential — it claims with the team agent key + a grant.
    const ada = await post(
      '/teams/dawn/members',
      { name: 'Ada', kind: 'agent' },
      team.json.human_credential,
    );
    expect(ada.json.human_credential).toBeUndefined();
  });

  it('rejects an invalid act with 422 validation', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, team.json.human_credential);
    const bad = await post(
      '/teams/dawn/messages',
      {
        envelope: {
          id: 'x',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'bo' },
          act: 'yell',
          body: '',
          ts: 1,
        },
      },
      team.json.human_credential,
    );
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe('validation');
  });

  it('ambient presence: a one-shot authenticated command flips the agent present (ADR 057)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    const adaTok = { key: team.json.agent_key, seat: 'Ada' };

    // Ada has never opened a socket → offline.
    const before = await get('/teams/dawn/members', nickTok);
    expect(before.json.members.find((m: any) => m.name === 'Ada')?.activity).toBe('offline');

    // A single one-shot read command is enough to read present — no watch socket.
    await get('/teams/dawn/inbox', adaTok);
    const after = await get('/teams/dawn/members', nickTok);
    const adaRow = after.json.members.find((m: any) => m.name === 'Ada');
    expect(adaRow?.activity).toBe('idle'); // present, but no status_update → not "working"
    expect(adaRow?.presence).toBe('online');
    // the ambient row is connectionless and carries the surface header
    expect(adaRow?.presences?.[0]?.surface).toBe('cli');
  });

  it('ambient presence: x-musterd-no-touch suppresses the touch (the notifier opt-out, ADR 057)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // A read carrying the no-touch header (a background poller, e.g. notify) must NOT flip Ada present.
    await get(
      '/teams/dawn/inbox',
      { key: team.json.agent_key, seat: 'Ada' },
      { 'x-musterd-no-touch': '1' },
    );
    const after = await get('/teams/dawn/members', nickTok);
    expect(after.json.members.find((m: any) => m.name === 'Ada')?.activity).toBe('offline');
  });

  it('ambient presence: a status_update reads working, and the surface header is honored (ADR 057)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    const res = await fetch(base + '/teams/dawn/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${team.json.agent_key}`,
        'x-musterd-seat': 'Ada',
        'x-musterd-surface': 'claude-code',
      },
      body: JSON.stringify({
        envelope: {
          id: 'su1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: 'refactoring the reaper',
          ts: Date.now(),
        },
      }),
    });
    expect(res.status).toBe(201);

    const roster = await get('/teams/dawn/members', nickTok);
    const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
    // posting a status both flips present (ambient) and sets the working label (two-clocks rule)
    expect(adaRow?.activity).toBe('working');
    expect(adaRow?.state).toBe('refactoring the reaper');
    expect(adaRow?.presences?.[0]?.surface).toBe('claude-code');
  });

  it('ambient presence: a live watcher sees the offline→online transition event (ADR 057)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    const adaTok = { key: team.json.agent_key, seat: 'Ada' };

    // nick watches the team roster live.
    const watcher = new TestWs();
    await watcher.open();
    await watcher.claim('dawn', nickTok, 'nick');
    watcher.send({ type: 'subscribe', scope: 'team' });

    // Ada runs a one-shot; the watcher should receive a presence online event for Ada.
    await get('/teams/dawn/inbox', adaTok);
    await pollUntil(() =>
      watcher.frames.some(
        (f) =>
          f.type === 'presence' && (f as any).member === 'Ada' && (f as any).status === 'online',
      ),
    );
    watcher.ws.close();
  });
});

describe('static web serving (ADR 062)', () => {
  it('serves index + assets, falls back to index for client routes, and keeps API paths as JSON 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>musterd live</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("hi")');

    const s = createServer({ db: openDb(':memory:'), port: 0, webRoot: dir });
    const { port } = await s.listen();
    const b = `http://127.0.0.1:${port}`;
    try {
      const root = await fetch(`${b}/`);
      expect(root.status).toBe(200);
      expect(root.headers.get('content-type')).toMatch(/text\/html/);
      expect(await root.text()).toMatch(/musterd live/);

      const asset = await fetch(`${b}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toMatch(/javascript/);

      // A client route (no file) falls back to the app shell so deep links / refresh work.
      const spa = await fetch(`${b}/live`);
      expect(spa.status).toBe(200);
      expect(await spa.text()).toMatch(/musterd live/);

      // A missing *asset* (has an extension) is a real 404, not the shell.
      expect((await fetch(`${b}/assets/missing.js`)).status).toBe(404);

      // API namespaces still answer as JSON — static serving never shadows them.
      const api = await fetch(`${b}/teams/none`);
      expect(api.status).toBe(404);
      expect((await api.json()).error.code).toBe('not_found');
    } finally {
      await s.close();
    }
  });

  // Raw http client: unlike undici's fetch it never auto-decompresses, so we can assert on the exact
  // content-encoding the daemon negotiated and diff the raw body ourselves.
  function rawGet(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
    return new Promise((res, rej) => {
      httpGet(url, { headers }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          res({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }),
        );
      }).on('error', rej);
    });
  }

  it('compresses text assets per Accept-Encoding, caches immutably, and revalidates the shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-web-'));
    const html = '<!doctype html><title>musterd live</title>';
    writeFileSync(join(dir, 'index.html'), html);
    mkdirSync(join(dir, 'assets'));
    const js = `console.log(${JSON.stringify('x'.repeat(4096))})`;
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), js);
    // A pre-compressed format must be served identity — gzipping it is wasted CPU.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(0)]);
    writeFileSync(join(dir, 'assets', 'logo-def456.png'), png);

    const s = createServer({ db: openDb(':memory:'), port: 0, webRoot: dir });
    const { port } = await s.listen();
    const b = `http://127.0.0.1:${port}`;
    try {
      // brotli preferred when offered; the decoded bytes round-trip to the original.
      const br = await rawGet(`${b}/assets/app-abc123.js`, { 'accept-encoding': 'gzip, br' });
      expect(br.headers['content-encoding']).toBe('br');
      expect(br.headers['vary']).toMatch(/accept-encoding/i);
      expect(br.body.length).toBeLessThan(Buffer.byteLength(js));
      expect(brotliDecompressSync(br.body).toString()).toBe(js);
      // Content-hashed asset → cache forever.
      expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');

      // gzip when brotli isn't on the table.
      const gz = await rawGet(`${b}/assets/app-abc123.js`, { 'accept-encoding': 'gzip' });
      expect(gz.headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(gz.body).toString()).toBe(js);

      // No Accept-Encoding → identity, with a real Content-Length.
      const id = await rawGet(`${b}/assets/app-abc123.js`);
      expect(id.headers['content-encoding']).toBeUndefined();
      expect(id.headers['content-length']).toBe(String(Buffer.byteLength(js)));
      expect(id.body.toString()).toBe(js);

      // Binary asset is never compressed even when the client offers it.
      const img = await rawGet(`${b}/assets/logo-def456.png`, { 'accept-encoding': 'gzip, br' });
      expect(img.headers['content-encoding']).toBeUndefined();
      expect(img.body.equals(png)).toBe(true);

      // The app shell revalidates: weak ETag + no-cache, and If-None-Match ⇒ 304.
      const shell = await rawGet(`${b}/`);
      expect(shell.headers['cache-control']).toBe('no-cache');
      const etag = shell.headers['etag'];
      expect(etag).toMatch(/^W\//);
      const revalidated = await rawGet(`${b}/`, { 'if-none-match': etag as string });
      expect(revalidated.status).toBe(304);
      expect(revalidated.body.length).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('stays API-only (404s the web root) when no webRoot is configured', async () => {
    const s = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await s.listen();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      expect(r.status).toBe(404);
    } finally {
      await s.close();
    }
  });
});

describe('API response compression', () => {
  it('compresses large JSON reads per Accept-Encoding and leaves small ones identity', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential as string;
    await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
    // Seed a backfill well past the 1400-byte threshold.
    for (let i = 0; i < 40; i++) {
      await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: `m${i}`,
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'nick',
            to: { kind: 'member', name: 'bo' },
            act: 'message',
            body: `status update ${i} — ${'detail '.repeat(12)}`,
            ts: 1000 + i,
          },
        },
        nickTok,
      );
    }
    const auth = { authorization: `Bearer ${nickTok}` };

    // brotli preferred; the decoded body round-trips to the full timeline.
    const br = await rawHttpGet('/teams/dawn/messages', { ...auth, 'accept-encoding': 'br' });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['vary']).toMatch(/accept-encoding/i);
    expect(JSON.parse(brotliDecompressSync(br.body).toString()).messages).toHaveLength(40);

    // gzip when brotli isn't offered.
    const gz = await rawHttpGet('/teams/dawn/messages', { ...auth, 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(gz.body).toString()).messages).toHaveLength(40);

    // No Accept-Encoding → identity, and the compressed form is materially smaller.
    const id = await rawHttpGet('/teams/dawn/messages', auth);
    expect(id.headers['content-encoding']).toBeUndefined();
    expect(br.body.length).toBeLessThan(id.body.length / 2);

    // A small response stays identity even when compression is on the table (below threshold).
    const health = await rawHttpGet('/health', { 'accept-encoding': 'br, gzip' });
    expect(health.headers['content-encoding']).toBeUndefined();
  });
});

describe('WebSocket', () => {
  it('/health connections reflects a live session (ADR 047)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
    expect((await get('/health')).json.connections).toBe(0);

    const a = new TestWs();
    await a.open();
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );
    expect((await get('/health')).json.connections).toBe(1);
    a.close();
  });

  it('delivers live to a present recipient and acks the sender', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, team.json.human_credential);

    const a = new TestWs();
    const l = new TestWs();
    await Promise.all([a.open(), l.open()]);
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );
    await l.claim(
      'dawn',
      team.json.agent_key,
      'Lin',
      'codex',
      await standingGrant(team.json.human_credential, 'Lin'),
    );

    a.send({
      type: 'send',
      envelope: {
        id: 'mw1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'member', name: 'Lin' },
        act: 'handoff',
        body: 'ready',
        ts: Date.now(),
      },
    });

    const ack = await a.waitFor('ack');
    expect((ack as any).id).toBe('mw1');
    const deliver = await l.waitFor('deliver');
    expect((deliver as any).envelope.body).toBe('ready');

    a.close();
    l.close();
  });

  it('firehose (subscribe team-all): a regular member sees team/broadcast, not others’ DMs (recipient-scoping)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
    await post('/teams/dawn/members', { name: 'Obs', kind: 'agent' }, tok);

    const a = new TestWs();
    const l = new TestWs();
    const o = new TestWs();
    await Promise.all([a.open(), l.open(), o.open()]);
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );
    await l.claim(
      'dawn',
      team.json.agent_key,
      'Lin',
      'codex',
      await standingGrant(team.json.human_credential, 'Lin'),
    );
    await o.claim(
      'dawn',
      team.json.agent_key,
      'Obs',
      'web',
      await standingGrant(team.json.human_credential, 'Obs'),
    );

    // Lin is the recipient AND a firehose subscriber (tests dedup); Obs is a regular (non-party,
    // non-observer, non-admin) member watching the firehose — recipient-scoping must apply to it.
    const linSub = await l.subscribe('team-all');
    const obsSub = await o.subscribe('team-all');
    expect((linSub as any).scope).toBe('team-all');
    expect((obsSub as any).scope).toBe('team-all');

    a.send({
      type: 'send',
      envelope: {
        id: 'fh1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'member', name: 'Lin' },
        act: 'request_help',
        body: 'firehose ping',
        ts: Date.now(),
      },
    });
    await a.waitFor('ack');

    // The recipient gets the DM exactly once, despite also being on the firehose (dedup via skip set).
    await l.waitFor('deliver');
    await new Promise((r) => setTimeout(r, 40));
    expect(l.countFrames('deliver')).toBe(1);
    // Recipient-scoping: the regular member must NOT see a DM it is not party to.
    expect(o.countFrames('deliver')).toBe(0);

    // But a team broadcast is public — the observer does receive it.
    a.send({
      type: 'send',
      envelope: {
        id: 'fh2',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'status_update',
        body: 'team ping',
        ts: Date.now(),
      },
    });
    await a.waitFor('ack');
    const obsBroadcast = await o.waitFor('deliver');
    expect((obsBroadcast as any).envelope.body).toBe('team ping');

    a.close();
    l.close();
    o.close();
  });

  it('GET /messages returns the whole team timeline incl. DMs between others, with since/limit (ADR 061)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);

    const mk = (id: string, from: string, to: any, body: string, ts: number) => ({
      id,
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from,
      to,
      act: 'message',
      body,
      ts,
    });
    // A directed Ada→Lin DM (nick is neither sender nor recipient) + a team broadcast from Lin.
    await post(
      '/teams/dawn/messages',
      { envelope: mk('t1', 'Ada', { kind: 'member', name: 'Lin' }, 'dm', 1000) },
      { key: team.json.agent_key, seat: 'Ada' },
    );
    await post(
      '/teams/dawn/messages',
      { envelope: mk('t2', 'Lin', { kind: 'team' }, 'all', 2000) },
      { key: team.json.agent_key, seat: 'Lin' },
    );

    // nick is the team admin, so — party to neither — still sees BOTH via the full team timeline.
    const all = await get('/teams/dawn/messages', tok);
    expect(all.json.messages.map((m: any) => m.id)).toEqual(['t1', 't2']);

    // `since` pages forward (exclusive), oldest-after-first.
    const since = await get('/teams/dawn/messages?since=1000', tok);
    expect(since.json.messages.map((m: any) => m.id)).toEqual(['t2']);
    // A bare `limit` caps to the NEWEST N (not the oldest) so a busy team's backfill shows what just
    // happened, not its first N messages ever — the ADR 107 backfill fix.
    const limited = await get('/teams/dawn/messages?limit=1', tok);
    expect(limited.json.messages).toHaveLength(1);
    expect(limited.json.messages[0].id).toBe('t2');
  });

  it('GET /messages recipient-scopes for a non-admin: only envelopes the caller is party to', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
    await post('/teams/dawn/members', { name: 'Bo', kind: 'agent' }, tok);
    const key = team.json.agent_key;

    const mk = (id: string, from: string, to: any, body: string, ts: number) => ({
      id,
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from,
      to,
      act: 'message',
      body,
      ts,
    });
    // m1 Ada→Lin (Bo not party) · m2 Bo→Ada (Bo party) · m3 Lin→team (public).
    await post(
      '/teams/dawn/messages',
      { envelope: mk('m1', 'Ada', { kind: 'member', name: 'Lin' }, 'ada->lin', 1000) },
      { key, seat: 'Ada' },
    );
    await post(
      '/teams/dawn/messages',
      { envelope: mk('m2', 'Bo', { kind: 'member', name: 'Ada' }, 'bo->ada', 2000) },
      { key, seat: 'Bo' },
    );
    await post(
      '/teams/dawn/messages',
      { envelope: mk('m3', 'Lin', { kind: 'team' }, 'all', 3000) },
      { key, seat: 'Lin' },
    );

    // Bo (non-admin) sees only its own DM (m2) + the public broadcast (m3) — never the Ada→Lin DM.
    const boView = await get('/teams/dawn/messages', { key, seat: 'Bo' });
    expect(boView.json.messages.map((m: any) => m.id)).toEqual(['m2', 'm3']);

    // The admin (nick) still sees everything, incl. the DM Bo cannot.
    const adminView = await get('/teams/dawn/messages', tok);
    expect(adminView.json.messages.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('observer seat: watches the firehose but is hidden from roster/count and cannot send (ADR 063)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
    const obs = await post(
      '/teams/dawn/members',
      { name: 'wall', kind: 'human', observer: true },
      tok,
    );
    expect(obs.status).toBe(201);

    const a = new TestWs();
    const o = new TestWs();
    await Promise.all([a.open(), o.open()]);
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );
    await o.claim(
      'dawn',
      team.json.agent_key,
      'wall',
      'web',
      await standingGrant(team.json.human_credential, 'wall'),
    );
    await o.subscribe('team-all');

    // The observer is NOT on the roster and does NOT count as a live session, even though connected:
    // Ada + the observer are both connected, but only Ada (a participant) is counted.
    const roster = await get('/teams/dawn', tok);
    expect(roster.json.members.map((m: any) => m.name)).not.toContain('wall');
    expect((await get('/health')).json.connections).toBe(1);

    // A **full-grade** observer (the default, and what the trusted local dashboard mints — ADR 136)
    // has full visibility, so it still receives a directed DM between two others via the firehose.
    // Regular members are recipient-scoped (see the recipient-scoping tests above), and so is a
    // public-grade observer — see the observer-grades block below.
    a.send({
      type: 'send',
      envelope: {
        id: 'obs1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'member', name: 'Lin' },
        act: 'message',
        body: 'seen by the wall',
        ts: Date.now(),
      },
    });
    const deliver = await o.waitFor('deliver');
    expect((deliver as any).envelope.body).toBe('seen by the wall');

    // And it cannot send — observers are read-only.
    const denied = await post(
      '/teams/dawn/messages',
      {
        envelope: {
          id: 'obs2',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'wall',
          to: { kind: 'team' },
          act: 'message',
          body: 'should be refused',
          ts: Date.now(),
        },
      },
      obs.json.human_credential, // wall is a human observer — auth with its credential, not the agent key
    );
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('forbidden');

    a.close();
    o.close();
  });

  it('a message to an offline member surfaces via inbox', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // nick present, Ada offline.
    const n = new TestWs();
    await n.open();
    await n.claim('dawn', nickTok, 'nick', 'cli');
    n.send({
      type: 'send',
      envelope: {
        id: 'mw2',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'member', name: 'Ada' },
        act: 'request_help',
        body: 'help',
        ts: Date.now(),
      },
    });
    await n.waitFor('ack');

    const inbox = await get('/teams/dawn/inbox?unread=1', {
      key: team.json.agent_key,
      seat: 'Ada',
    });
    expect(inbox.json.messages).toHaveLength(1);
    expect(inbox.json.messages[0].act).toBe('request_help');
    n.close();
  });

  it('roster activity reflects working from a status_update, idle when present, offline otherwise', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickTok); // never connects → offline

    // nick present but idle; Ada present and working.
    const n = new TestWs();
    const a = new TestWs();
    await Promise.all([n.open(), a.open()]);
    await n.claim('dawn', nickTok, 'nick', 'cli');
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );

    a.send({
      type: 'send',
      envelope: {
        id: 'su1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'status_update',
        body: '',
        meta: { state: 'refactoring auth' },
        ts: Date.now(),
      },
    });
    await a.waitFor('ack');

    const roster = await get('/teams/dawn/members', nickTok);
    const by = (name: string) => roster.json.members.find((m: any) => m.name === name);
    expect(by('Ada').activity).toBe('working');
    expect(by('Ada').state).toBe('refactoring auth');
    expect(by('Ada').posture).toBe('working');
    expect(by('nick').activity).toBe('idle');
    expect(by('nick').state).toBeNull();
    expect(by('nick').posture).toBe('idle');
    expect(by('Lin').activity).toBe('offline');
    expect(by('Lin').posture).toBe('offline');
    expect(by('Lin').offline_reason).toBe('unknown');

    n.close();
    a.close();
  });

  it('steering marks the driving human working + present without their own heartbeat (ADR 155 Inc 1)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok); // a human who never steers

    // nick does NOT open his own presence. Ada connects, driven by nick.
    const a = new TestWs();
    await a.open();
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
      undefined,
      'nick', // driver
    );

    const roster = await get('/teams/dawn/members', nickTok);
    const by = (name: string) => roster.json.members.find((m: any) => m.name === name);
    // Steering nick reads working + online, derived from Ada's live driver link — no presence row of his own.
    expect(by('nick').activity).toBe('working');
    expect(by('nick').presence).toBe('online');
    expect(by('nick').posture).toBe('working');
    expect(by('nick').offline_reason).toBeUndefined();
    // bo, a human who is not steering anyone, still reads offline.
    expect(by('bo').activity).toBe('offline');
    expect(by('bo').presence).toBe('offline');

    a.close();
  });

  it('an authenticated /live web tab marks the human online (ADR 155 Inc 3)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;

    // The advanced sign-in path: the browser claims nick's own seat with his mscr_ credential,
    // surface 'web' — self-authorizing (ADR 077), fanning out like any human presence (ADR 042).
    const tab = new TestWs();
    await tab.open();
    await tab.claim('dawn', nickTok, 'nick', 'web');

    const roster = await get('/teams/dawn/members', nickTok);
    const nickRow = roster.json.members.find((m: any) => m.name === 'nick');
    expect(nickRow.presence).toBe('online');
    expect(nickRow.presences[0].surface).toBe('web');
    // Tab open, nothing reported → idle, not working (the ladder's online-but-no-task read).
    expect(nickRow.activity).toBe('idle');
    expect(nickRow.posture).toBe('idle');

    tab.close();
  });

  it('a live human decays working → idle past the presence timeout; an agent does not (ADR 155 Inc 3)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const tab = new TestWs();
    const a = new TestWs();
    await Promise.all([tab.open(), a.open()]);
    await tab.claim('dawn', nickTok, 'nick', 'web');
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );

    const status = (id: string, from: string) => ({
      type: 'send',
      envelope: {
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from,
        to: { kind: 'team' },
        act: 'status_update',
        body: '',
        meta: { state: 'shipping inc 3' },
        ts: Date.now(),
      },
    });
    tab.send(status('su-nick', 'nick'));
    await tab.waitFor('ack');
    a.send(status('su-ada', 'Ada'));
    await a.waitFor('ack');

    // Fresh status: both read working.
    let roster = await get('/teams/dawn/members', nickTok);
    const by = (r: any, name: string) => r.json.members.find((m: any) => m.name === name);
    expect(by(roster, 'nick').activity).toBe('working');
    expect(by(roster, 'Ada').activity).toBe('working');

    // Age both statuses past the presence timeout while the presences stay live (the persistent-tab
    // shape: heartbeats keep the human online for hours after the last thing they reported).
    server.db
      .prepare("UPDATE messages SET ts = ? WHERE act = 'status_update'")
      .run(Date.now() - 60_000);

    roster = await get('/teams/dawn/members', nickTok);
    // The human decays to idle — still online, last_status_at kept, no stale working label.
    expect(by(roster, 'nick').presence).toBe('online');
    expect(by(roster, 'nick').activity).toBe('idle');
    expect(by(roster, 'nick').state).toBeNull();
    expect(by(roster, 'nick').last_status_at).not.toBeNull();
    expect(by(roster, 'nick').posture).toBe('idle');
    // The agent keeps the ADR 010 never-silently-revert read.
    expect(by(roster, 'Ada').activity).toBe('working');
    expect(by(roster, 'Ada').state).toBe('shipping inc 3');

    tab.close();
    a.close();
  });

  it('sets and exposes a member’s self-declared availability on the roster (ADR 044)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const by = async (name: string) =>
      (await get('/teams/dawn/members', nickTok)).json.members.find((m: any) => m.name === name);

    // default: no availability set (implicit-available).
    expect((await by('nick')).availability).toBeNull();

    // away_until: until rides only `away`.
    const until = Date.now() + 3_600_000;
    const set = await post('/teams/dawn/availability', { status: 'away', until }, nickTok);
    expect(set.status).toBe(200);
    expect(set.json.member.availability).toEqual({ status: 'away', until });
    expect((await by('nick')).availability).toEqual({ status: 'away', until });

    // dnd drops any until (the stored shape stays honest).
    await post('/teams/dawn/availability', { status: 'dnd', until }, nickTok);
    expect((await by('nick')).availability).toEqual({ status: 'dnd' });

    // available returns to the implicit default shape.
    await post('/teams/dawn/availability', { status: 'available' }, nickTok);
    expect((await by('nick')).availability).toEqual({ status: 'available' });

    // a bad status is a 400 bad_request.
    const bad = await post('/teams/dawn/availability', { status: 'vacation' }, nickTok);
    expect(bad.status).toBe(400);

    // unauthenticated is refused.
    const noauth = await post('/teams/dawn/availability', { status: 'away' });
    expect(noauth.status).toBe(401);
  });

  it('records provenance + workspace from the claim and surfaces them on the roster (ADR 014)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const a = new TestWs();
    await a.open();
    a.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: team.json.agent_key,
      target: { seat: 'Ada' },
      grant: await standingGrant(team.json.human_credential, 'Ada'),
      surface: 'claude-code',
      provenance: 'session',
      workspace: 'movetrail@feat/login',
    });
    await a.waitFor('occupied');

    const roster = await get('/teams/dawn/members', nickTok);
    const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
    expect(adaRow.presences[0].provenance).toBe('session');
    expect(adaRow.presences[0].workspace).toBe('movetrail@feat/login');

    a.close();
  });

  it('records the driver from the claim and surfaces it on the roster (ADR 021)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const a = new TestWs();
    await a.open();
    a.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: team.json.agent_key,
      target: { seat: 'Ada' },
      grant: await standingGrant(team.json.human_credential, 'Ada'),
      surface: 'claude-code',
      provenance: 'session',
      driver: 'nick',
    });
    await a.waitFor('occupied');

    const roster = await get('/teams/dawn/members', nickTok);
    const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
    expect(adaRow.presences[0].driver).toBe('nick');

    a.close();
  });

  it('a second live session for the same member takes over; the first is superseded (ADR 017)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);

    const a1 = new TestWs();
    await a1.open();
    await a1.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );

    // The newer session wins: it gets `welcome`, and the older one is told it was superseded.
    const a2 = new TestWs();
    await a2.open();
    const occupied = await a2.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'cli',
      await standingGrant(team.json.human_credential, 'Ada'),
    );
    expect(occupied.type).toBe('occupied');

    const superseded = await a1.waitFor('error');
    expect((superseded as any).code).toBe('superseded');

    // Exactly one live presence remains — the new one (single-active still holds).
    const roster = await get('/teams/dawn/members', team.json.human_credential);
    const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
    expect(adaRow.presences).toHaveLength(1);
    expect(adaRow.presences[0].surface).toBe('cli');

    a1.close();
    a2.close();
  });

  it('a same-workspace claim does NOT supersede the live session (ADR 068)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
    const grant = await standingGrant(team.json.human_credential, 'Ada');

    const live = new TestWs();
    await live.open();
    live.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: team.json.agent_key,
      target: { seat: 'Ada' },
      grant,
      surface: 'claude-code',
      workspace: 'repo@main',
    });
    expect((await live.waitFor('occupied')).type).toBe('occupied');

    // A health-check probe (or a reload) briefly spawns the MCP server from the SAME workspace.
    const probe = new TestWs();
    await probe.open();
    probe.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: team.json.agent_key,
      target: { seat: 'Ada' },
      grant,
      surface: 'claude-code',
      workspace: 'repo@main',
    });
    expect((await probe.waitFor('occupied')).type).toBe('occupied');

    // The live session must NOT be told it was superseded — the seat doesn't flap.
    await expect(live.waitFor('error', 300)).rejects.toThrow(/timeout/);

    probe.close(); // the probe disconnects, as a real health check does
    live.close();
  });

  it('a different-workspace claim still supersedes (newest-wins across real sessions, ADR 017/068)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
    const grant = await standingGrant(team.json.human_credential, 'Ada');

    const first = new TestWs();
    await first.open();
    first.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: team.json.agent_key,
      target: { seat: 'Ada' },
      grant,
      surface: 'claude-code',
      workspace: 'repo@main',
    });
    expect((await first.waitFor('occupied')).type).toBe('occupied');

    const second = new TestWs();
    await second.open();
    second.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: team.json.agent_key,
      target: { seat: 'Ada' },
      grant,
      surface: 'claude-code',
      workspace: 'repo@other', // a genuinely different session
    });
    expect((await second.waitFor('occupied')).type).toBe('occupied');

    const superseded = await first.waitFor('error');
    expect((superseded as any).code).toBe('superseded');
    // Cross-workspace supersession is NOT flagged same_workspace (ADR 092) — the displaced session is a
    // genuinely different one (another machine / branch) and stays dormant rather than self-exiting.
    expect((superseded as any).same_workspace).toBeFalsy();

    first.close();
    second.close();
  });

  describe('durability-gated same-workspace eviction (ADR 092)', () => {
    // A short grace so the reap fires within a test's patience; the outer beforeEach already stood up a
    // default-grace server, so close it and stand up a short-grace one for these cases.
    beforeEach(async () => {
      await server.close();
      process.env['MUSTERD_SUPERSEDE_GRACE_MS'] = '120';
      server = createServer({ db: openDb(':memory:'), port: 0 });
      const { port } = await server.listen();
      base = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}/ws`;
    });
    afterEach(() => {
      delete process.env['MUSTERD_SUPERSEDE_GRACE_MS'];
    });

    async function occupyAda(ws: TestWs, agentKey: string, grant: string, workspace: string) {
      ws.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: agentKey,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace,
      });
      expect((await ws.waitFor('occupied')).type).toBe('occupied');
    }

    it('a durable same-workspace successor reaps its predecessor with same_workspace:true', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const grant = await standingGrant(team.json.human_credential, 'Ada');

      const orphan = new TestWs();
      await orphan.open();
      await occupyAda(orphan, team.json.agent_key, grant, 'repo@main');

      // The reload successor: same workspace, and it STAYS connected past the grace.
      const successor = new TestWs();
      await successor.open();
      await occupyAda(successor, team.json.agent_key, grant, 'repo@main');

      // The orphan is reaped after the grace, and told same_workspace so its adapter exits.
      const superseded = await orphan.waitFor('error', 1000);
      expect((superseded as any).code).toBe('superseded');
      expect((superseded as any).same_workspace).toBe(true);

      // The duplicate was audited when the reap was armed (ADR 092 §C drift signal).
      const teamId = getTeamBySlug(server.db, 'dawn')!.id;
      expect(
        listAudit(server.db, teamId).some((r) => r.action === 'claim.duplicate_workspace'),
      ).toBe(true);

      successor.close();
      orphan.close();
    });

    it('a transient same-workspace probe that disconnects within the grace does NOT reap the incumbent', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const grant = await standingGrant(team.json.human_credential, 'Ada');

      const live = new TestWs();
      await live.open();
      await occupyAda(live, team.json.agent_key, grant, 'repo@main');

      const probe = new TestWs();
      await probe.open();
      await occupyAda(probe, team.json.agent_key, grant, 'repo@main');
      probe.close(); // disconnects immediately, before the grace elapses — as a health check does

      // The live session is never superseded: the successor is gone before the reap fires (ADR 068 held).
      await expect(live.waitFor('error', 400)).rejects.toThrow(/timeout/);

      live.close();
    });
  });

  it('a human seat fans out: two concurrent sessions both stay live, neither superseded (ADR 042)', async () => {
    // The team creator (nick) is a human seat.
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;

    const phone = new TestWs();
    const laptop = new TestWs();
    await Promise.all([phone.open(), laptop.open()]);
    const w1 = await phone.claim('dawn', nickTok, 'nick', 'cli');
    const w2 = await laptop.claim('dawn', nickTok, 'nick', 'claude-code');
    expect(w1.type).toBe('occupied');
    expect(w2.type).toBe('occupied');

    // Neither human session is displaced — give a superseded frame a chance to arrive, then assert none did.
    await new Promise((r) => setTimeout(r, 50));
    expect(phone.frames.some((f) => f.type === 'error')).toBe(false);
    expect(laptop.frames.some((f) => f.type === 'error')).toBe(false);

    // Both presences are live; the roster collapses them to ONE member row carrying both surfaces.
    const roster = await get('/teams/dawn/members', nickTok);
    const nickRow = roster.json.members.find((m: any) => m.name === 'nick');
    expect(nickRow.activity).not.toBe('offline');
    expect(nickRow.presences).toHaveLength(2);
    expect(nickRow.presences.map((p: any) => p.surface).sort()).toEqual(['claude-code', 'cli']);
    expect(roster.json.members.filter((m: any) => m.name === 'nick')).toHaveLength(1);

    phone.close();
    laptop.close();
  });

  it('delivers a directed message AND a @team broadcast to BOTH of a human’s sessions (ADR 042)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // nick holds two live sessions; Ada is the sender.
    const phone = new TestWs();
    const laptop = new TestWs();
    const a = new TestWs();
    await Promise.all([phone.open(), laptop.open(), a.open()]);
    await phone.claim('dawn', nickTok, 'nick', 'cli');
    await laptop.claim('dawn', nickTok, 'nick', 'claude-code');
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );

    // Directed message to nick → both of nick's sessions receive the deliver.
    a.send({
      type: 'send',
      envelope: {
        id: 'mp1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'member', name: 'nick' },
        act: 'message',
        body: 'direct',
        ts: Date.now(),
      },
    });
    const d1 = await phone.waitFor('deliver');
    const d2 = await laptop.waitFor('deliver');
    expect((d1 as any).envelope.id).toBe('mp1');
    expect((d2 as any).envelope.id).toBe('mp1');

    // @team broadcast → both of nick's sessions receive it too.
    a.send({
      type: 'send',
      envelope: {
        id: 'mp2',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'message',
        body: 'broadcast',
        ts: Date.now(),
      },
    });
    await pollUntil(
      () =>
        phone.frames.some((f) => f.type === 'deliver' && (f as any).envelope.id === 'mp2') &&
        laptop.frames.some((f) => f.type === 'deliver' && (f as any).envelope.id === 'mp2'),
    );

    phone.close();
    laptop.close();
    a.close();
  });

  it('reclaim drops a member’s live session and frees the seat (ADR 017 follow-up)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const a = new TestWs();
    await a.open();
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );

    const r = await post('/teams/dawn/members/Ada/reclaim', {}, nickTok);
    expect(r.status).toBe(200);
    expect(r.json.member).toBe('Ada');

    // The live session is told it was superseded ...
    const superseded = await a.waitFor('error');
    expect((superseded as any).code).toBe('superseded');
    // ... and the seat is freed (Ada reads offline on the roster).
    const roster = await get('/teams/dawn/members', nickTok);
    expect(roster.json.members.find((m: any) => m.name === 'Ada').activity).toBe('offline');

    // Reclaiming an unknown member is a 404.
    const miss = await post('/teams/dawn/members/Ghost/reclaim', {}, nickTok);
    expect(miss.status).toBe(404);

    a.close();
  });

  it('unbind releases the caller’s own seat: drops its session + presence, keeps it on the roster (ADR 058)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const a = new TestWs();
    await a.open();
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );

    // Ada unbinds herself with her *own* token (self-only — no target name).
    const r = await post('/teams/dawn/unbind', {}, { key: team.json.agent_key, seat: 'Ada' });
    expect(r.status).toBe(200);
    expect(r.json.member).toBe('Ada');

    // Her live session is dropped and she reads offline …
    await pollUntil(async () => {
      const roster = await get('/teams/dawn/members', nickTok);
      return roster.json.members.find((m: any) => m.name === 'Ada')?.activity === 'offline';
    });
    // … but the seat is still on the team (declared, not removed) and re-claimable by adoption.
    const roster = await get('/teams/dawn/members', nickTok);
    expect(roster.json.members.some((m: any) => m.name === 'Ada')).toBe(true);

    // Unbind requires a valid token (self-only); an anonymous call is unauthorized.
    const anon = await post('/teams/dawn/unbind', {}, undefined);
    expect(anon.status).toBe(401);

    a.close();
  });

  it('remove soft-deletes a member, drops its live session, and is idempotent (ADR 019)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const a = new TestWs();
    await a.open();
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );

    const r = await post('/teams/dawn/members/Ada/remove', {}, nickTok);
    expect(r.status).toBe(200);
    expect(r.json.member).toBe('Ada');
    expect(r.json.kind).toBe('agent');

    // The live session is told it was superseded (the seat is freed) ...
    const superseded = await a.waitFor('error');
    expect((superseded as any).code).toBe('superseded');
    // ... and Ada is gone from the roster entirely (left_at filters her out).
    const roster = await get('/teams/dawn/members', nickTok);
    expect(roster.json.members.find((m: any) => m.name === 'Ada')).toBeUndefined();

    // Idempotent: a second remove (now left_at-stamped) and an unknown member both 404.
    const again = await post('/teams/dawn/members/Ada/remove', {}, nickTok);
    expect(again.status).toBe(404);
    const miss = await post('/teams/dawn/members/Ghost/remove', {}, nickTok);
    expect(miss.status).toBe(404);

    a.close();
  });

  it('lets the same member reclaim its presence after disconnecting (within grace)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // nick stays present so we can observe Ada's offline event after she drops.
    const n = new TestWs();
    await n.open();
    await n.claim('dawn', nickTok, 'nick', 'cli');

    const a1 = new TestWs();
    await a1.open();
    await a1.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(team.json.human_credential, 'Ada'),
    );
    a1.close();

    // Wait until the server has processed the close (released the hold + emitted offline).
    await pollUntil(() =>
      n.frames.some(
        (f) =>
          f.type === 'presence' && (f as any).member === 'Ada' && (f as any).status === 'offline',
      ),
    );

    const a2 = new TestWs();
    await a2.open();
    const occupied = await a2.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'cli',
      await standingGrant(team.json.human_credential, 'Ada'),
    );
    expect(occupied.type).toBe('occupied');

    n.close();
    a2.close();
  });

  it('rejects a claim whose credential does not match the target seat', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, team.json.human_credential);
    const w = new TestWs();
    await w.open();
    // nick's credential self-identifies as nick — it cannot occupy someone else's seat (Lin).
    w.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: team.json.human_credential,
      target: { seat: 'Lin' },
      surface: 'cli',
    });
    const err = await w.waitFor('refused');
    expect((err as any).code).toBe('forbidden');
    w.close();
  });
});

describe('model attestation (ADR 101)', () => {
  it('claim attests, acts carry the server-side meta.model stamp, heartbeat re-attests + audits', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);

    const a = new TestWs();
    const l = new TestWs();
    await Promise.all([a.open(), l.open()]);
    await a.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'claude-code',
      await standingGrant(tok, 'Ada'),
      'claude-opus-4-8',
    );
    // Lin attests nothing — legal, never blocks.
    await l.claim('dawn', team.json.agent_key, 'Lin', 'codex', await standingGrant(tok, 'Lin'));

    // Ada's act carries the stamp from her occupancy — server-side, not client meta.
    a.send({
      type: 'send',
      envelope: {
        id: 'am1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'member', name: 'Lin' },
        act: 'handoff',
        body: 'take this',
        ts: Date.now(),
      },
    });
    const deliver = (await l.waitFor('deliver')) as any;
    expect(deliver.envelope.meta.model).toBe('claude-opus-4-8');

    // Lin is unattested AND tries to spoof a model in client meta — the server strips it, so the
    // act carries no stamp (the integrity claim the diversity flag rests on).
    l.send({
      type: 'send',
      envelope: {
        id: 'lm1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Lin',
        to: { kind: 'member', name: 'Ada' },
        act: 'accept',
        body: 'ok',
        meta: { in_reply_to: 'am1', model: 'claude-opus-4-8' },
        ts: Date.now(),
      },
    });
    const back = (await a.waitFor('deliver')) as any;
    expect(back.envelope.meta.model).toBeUndefined();

    // Re-attestation rides the heartbeat; only a real change audits (old → new).
    a.send({ type: 'heartbeat', model: 'claude-fable-5' });
    await new Promise((r) => setTimeout(r, 50));
    const teamRow = getTeamBySlug(server.db, 'dawn')!;
    const attests = listAudit(server.db, teamRow.id).filter(
      (r) => r.action === 'occupancy.model_attested',
    );
    expect(attests.length).toBe(2); // claim-time initial + the heartbeat switch
    const details = attests.map(
      (r) => JSON.parse(r.detail!) as { old: string | null; new: string; source: string },
    );
    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ old: null, new: 'claude-opus-4-8', source: 'claim' }),
        expect.objectContaining({
          old: 'claude-opus-4-8',
          new: 'claude-fable-5',
          source: 'heartbeat',
        }),
      ]),
    );

    a.close();
    l.close();
  });

  it('HTTP claim + later one-shot with x-musterd-model stamps after the claim presence is reaped (ADR 119 / #172)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
    const grant = await standingGrant(tok, 'Ada');

    // Stateless claim with a harness-attested model (the thin-CLI path).
    const claimed = await post('/teams/dawn/claim', {
      key: team.json.agent_key,
      target: { seat: 'Ada' },
      grant,
      surface: 'cli',
      model: 'qwen2.5:3b-instruct',
    });
    expect(claimed.status).toBe(200);
    expect(claimed.json.type).toBe('occupied');

    // First one-shot while the claim occupancy is still live — stamp from newest-attested.
    const first = await fetch(base + '/teams/dawn/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${team.json.agent_key}`,
        'x-musterd-seat': 'Ada',
        'x-musterd-model': 'qwen2.5:3b-instruct',
      },
      body: JSON.stringify({
        envelope: {
          id: 'ada-1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'Lin' },
          act: 'status_update',
          body: 'first',
          ts: Date.now(),
        },
      }),
    });
    expect(first.status).toBe(201);
    expect(((await first.json()) as any).ack.meta.model).toBe('qwen2.5:3b-instruct');

    // Reap the claim occupancy — the fire-and-exit gap in finding 003 / issue #172.
    const adaId = getMemberByName(server.db, getTeamBySlug(server.db, 'dawn')!.id, 'Ada')!.id;
    const removed = server.db.prepare('DELETE FROM presence WHERE member_id = ?').run(adaId);
    expect(removed.changes).toBeGreaterThan(0);

    // Without the header: ambient attaches a bare row → stamp drops (the #172 hole).
    const bare = await fetch(base + '/teams/dawn/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${team.json.agent_key}`,
        'x-musterd-seat': 'Ada',
      },
      body: JSON.stringify({
        envelope: {
          id: 'ada-bare',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'Lin' },
          act: 'status_update',
          body: 'bare ambient',
          ts: Date.now(),
        },
      }),
    });
    expect(bare.status).toBe(201);
    expect(((await bare.json()) as any).ack.meta?.model).toBeUndefined();

    // Clear again so the next touch is a fresh attach (not COALESCE onto the bare row).
    server.db.prepare('DELETE FROM presence WHERE member_id = ?').run(adaId);

    // With x-musterd-model the ambient touch re-attests, so the act keeps the stamp.
    const later = await fetch(base + '/teams/dawn/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${team.json.agent_key}`,
        'x-musterd-seat': 'Ada',
        'x-musterd-model': 'qwen2.5:3b-instruct',
      },
      body: JSON.stringify({
        envelope: {
          id: 'ada-2',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'Lin' },
          act: 'status_update',
          body: 'reattest',
          ts: Date.now(),
        },
      }),
    });
    expect(later.status).toBe(201);
    expect(((await later.json()) as any).ack.meta.model).toBe('qwen2.5:3b-instruct');

    const teamRow = getTeamBySlug(server.db, 'dawn')!;
    const ambient = listAudit(server.db, teamRow.id).filter((r) => {
      if (r.action !== 'occupancy.model_attested') return false;
      const d = JSON.parse(r.detail!) as { source: string };
      return d.source === 'ambient';
    });
    expect(ambient.length).toBeGreaterThanOrEqual(1);
  });

  it('human credential + x-musterd-model does not attest the human occupancy (ADR 121)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential as string;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // A human one-shot carrying the header (e.g. MUSTERD_MODEL leaked into Nick's shell) must
    // still flip present for liveness, but must NOT write model onto the occupancy or stamp acts.
    const sent = await fetch(base + '/teams/dawn/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${nickTok}`,
        'x-musterd-model': 'claude-opus-4-8',
      },
      body: JSON.stringify({
        envelope: {
          id: 'nick-1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'Ada' },
          act: 'status_update',
          body: 'human send',
          ts: Date.now(),
        },
      }),
    });
    expect(sent.status).toBe(201);
    const ack = (await sent.json()) as { ack: { meta?: { model?: string } } };
    expect(ack.ack.meta?.model).toBeUndefined();

    const roster = await get('/teams/dawn/members', nickTok);
    const nickRow = roster.json.members.find((m: { name: string }) => m.name === 'nick');
    expect(nickRow?.presence).toBe('online');
    expect(nickRow?.presences?.[0]?.model ?? null).toBeNull();

    const teamRow = getTeamBySlug(server.db, 'dawn')!;
    const ambient = listAudit(server.db, teamRow.id).filter((r) => {
      if (r.action !== 'occupancy.model_attested') return false;
      const d = JSON.parse(r.detail!) as { source: string };
      return d.source === 'ambient';
    });
    expect(ambient).toHaveLength(0);
  });
});

describe('build attestation (ADR 135)', () => {
  it('WS claim attests the client build onto the presence row; absent stays null', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);

    const sha = 'a'.repeat(40);
    const a = new TestWs();
    const l = new TestWs();
    await Promise.all([a.open(), l.open()]);
    a.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: team.json.agent_key,
      target: { seat: 'Ada' },
      grant: await standingGrant(tok, 'Ada'),
      surface: 'claude-code',
      build: sha,
    });
    await a.waitFor('occupied');
    // Lin attests nothing — legal (unstamped/older client), never blocks.
    await l.claim('dawn', team.json.agent_key, 'Lin', 'codex', await standingGrant(tok, 'Lin'));

    const roster = await get('/teams/dawn/members', tok);
    const ada = roster.json.members.find((m: any) => m.name === 'Ada');
    const lin = roster.json.members.find((m: any) => m.name === 'Lin');
    expect(ada.presences[0].build).toBe(sha);
    expect(lin.presences[0].build).toBeNull();

    a.close();
    l.close();
  });

  it('x-musterd-build re-attests on the ambient touch, sticky across build-less requests, ALL credentials', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = team.json.human_credential;
    const sha = 'b'.repeat(40) + '-dirty'; // a dirty build is attestable — display keeps the suffix

    // Unlike model (ADR 121 agent-key gate), build rides a HUMAN credential too: it attests the
    // binary the caller runs, which a human's stale CLI genuinely has. Reads never touch (ADR 057),
    // so drive the ambient touch through a touching call (POST /messages), like the ADR 119 test.
    const sendAsNick = (id: string, headers: Record<string, string>) =>
      fetch(base + '/teams/dawn/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, ...headers },
        body: JSON.stringify({
          envelope: {
            id,
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'nick',
            to: { kind: 'team' },
            act: 'status_update',
            body: 'hello',
            ts: Date.now(),
          },
        }),
      });

    expect((await sendAsNick('n1', { 'x-musterd-build': sha })).status).toBe(201);
    let roster = await get('/teams/dawn/members', tok);
    let nickRow = roster.json.members.find((m: any) => m.name === 'nick');
    expect(nickRow.presences[0].build).toBe(sha);

    // A later touching request WITHOUT the header keeps the attested value (sticky COALESCE).
    expect((await sendAsNick('n2', {})).status).toBe(201);
    roster = await get('/teams/dawn/members', tok);
    nickRow = roster.json.members.find((m: any) => m.name === 'nick');
    expect(nickRow.presences[0].build).toBe(sha);
  });

  it('HTTP claim carries the build onto the stateless occupancy', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    const sha = 'c'.repeat(40);

    const r = await post('/teams/dawn/claim', {
      key: team.json.agent_key,
      target: { seat: 'Ada' },
      grant: await standingGrant(tok, 'Ada'),
      surface: 'cli',
      build: sha,
    });
    expect(r.status).toBe(200);
    const roster = await get('/teams/dawn/members', tok);
    const ada = roster.json.members.find((m: any) => m.name === 'Ada');
    expect(ada.presences[0].build).toBe(sha);
  });
});

describe('v0.3 P2 governance enforcement (ADR 071)', () => {
  /** Narrow a seat's effective caps directly (in P1 reconcile is the only writer; tests stand in for it). */
  function setCaps(
    slug: string,
    name: string,
    partial: Partial<typeof GENERALIST_CAPABILITIES>,
    accountStatus: string | null = null,
  ): void {
    const team = getTeamBySlug(server.db, slug)!;
    const m = getMemberByName(server.db, team.id, name)!;
    setMemberGovernance(
      server.db,
      m.id,
      accountStatus,
      JSON.stringify({ ...GENERALIST_CAPABILITIES, ...partial }),
    );
  }
  function auditRows(slug: string) {
    return listAudit(server.db, getTeamBySlug(server.db, slug)!.id);
  }
  function urgentEnv(from: string, to: string, id: string) {
    return {
      id,
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from,
      to: { kind: 'member', name: to },
      act: 'message',
      body: 'ping',
      meta: { urgent: true, urgent_reason: 'prod is down' },
      ts: Date.now(),
    };
  }

  it('creator seat is admin; a non-admin cannot reclaim/remove once an admin exists', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    // The creator-admin default (ADR 071) is on the returned member …
    expect(team.json.member.capabilities.is_admin).toBe(true);
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    await post('/teams/dawn/members', { name: 'Bob', kind: 'agent' }, nickTok);

    // Ada (generalist, not admin) is refused governance now that nick is an admin.
    const denied = await post(
      '/teams/dawn/members/Bob/reclaim',
      {},
      { key: team.json.agent_key, seat: 'Ada' },
    );
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('forbidden');
    // The admin may.
    const ok = await post('/teams/dawn/members/Bob/reclaim', {}, nickTok);
    expect(ok.status).toBe(200);
    expect(auditRows('dawn').some((r) => r.action === 'member.reclaim' && r.actor === 'nick')).toBe(
      true,
    );
  });

  it('empty-admin fallback: with no admin on the team, any member may reclaim (no flag day)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    await post('/teams/dawn/members', { name: 'Bob', kind: 'agent' }, nickTok);
    // Strip the only admin → the team has zero admins → governance falls back to v0.2 open behaviour.
    setCaps('dawn', 'nick', { is_admin: false });

    const ok = await post(
      '/teams/dawn/members/Bob/reclaim',
      {},
      { key: team.json.agent_key, seat: 'Ada' },
    );
    expect(ok.status).toBe(200);
    const entry = auditRows('dawn').find((r) => r.action === 'member.reclaim');
    expect(entry?.detail).toContain('no-admin');
  });

  it('GET /audit is admin-only', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    await post('/teams/dawn/members/Ada/reclaim', {}, nickTok); // write one entry

    const adminView = await get('/teams/dawn/audit', nickTok);
    expect(adminView.status).toBe(200);
    expect(adminView.json.audit.length).toBeGreaterThan(0);
    expect(adminView.json.audit[0]).toMatchObject({ action: 'member.reclaim', result: 'allow' });

    const nonAdmin = await get('/teams/dawn/audit', { key: team.json.agent_key, seat: 'Ada' });
    expect(nonAdmin.status).toBe(403);
    const anon = await get('/teams/dawn/audit');
    expect(anon.status).toBe(401);
  });

  it('can_flag_urgent: an allowed seat keeps urgent + is audited; a denied seat is downgraded, not rejected', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
    const bobTok = bob.json.human_credential; // human seat → its own credential, not the agent key
    await post('/teams/dawn/members', { name: 'Mut', kind: 'agent' }, nickTok);

    // nick is generalist-ish (can_flag_urgent true) → urgent rides through.
    const allowed = await post(
      '/teams/dawn/messages',
      { envelope: urgentEnv('nick', 'Bob', 'u-allow') },
      nickTok,
    );
    expect(allowed.status).toBe(201);

    // Mut is narrowed to can_flag_urgent:false → the message still lands, just downgraded.
    setCaps('dawn', 'Mut', { can_flag_urgent: false });
    const downgraded = await post(
      '/teams/dawn/messages',
      { envelope: urgentEnv('Mut', 'Bob', 'u-deny') },
      { key: team.json.agent_key, seat: 'Mut' },
    );
    expect(downgraded.status).toBe(201); // delivered, not rejected

    const inbox = await get('/teams/dawn/inbox', bobTok, { 'x-musterd-no-touch': '1' });
    const msgs = inbox.json.messages as any[];
    const kept = msgs.find((m) => m.id === 'u-allow');
    const down = msgs.find((m) => m.id === 'u-deny');
    expect(kept.meta.urgent).toBe(true);
    expect(down.meta.urgent).toBeUndefined();
    expect(down.meta.wasnt_urgent).toBe(true);

    const audit = auditRows('dawn');
    expect(audit.some((r) => r.action === 'urgent.flagged' && r.actor === 'nick')).toBe(true);
    expect(audit.some((r) => r.action === 'urgent.denied' && r.actor === 'Mut')).toBe(true);
  });

  it('interrupt line (ADR 088): raises only for a waiting urgent directed act, composes without the body, audits once', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
    const bobTok = bob.json.human_credential;

    // Nothing waiting → silent (raised:false), the free common path.
    const quiet = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
      'x-musterd-no-touch': '1',
    });
    expect(quiet.status).toBe(200);
    expect(quiet.json).toEqual({ raised: false });

    // A NON-urgent directed act does not clear the interrupt bar.
    await post(
      '/teams/dawn/messages',
      { envelope: { ...urgentEnv('nick', 'Bob', 'plain'), meta: undefined, body: 'just fyi' } },
      nickTok,
    );
    const stillQuiet = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
      'x-musterd-no-touch': '1',
    });
    expect(stillQuiet.json).toEqual({ raised: false });

    // An urgent directed act raises: the line is daemon-composed from structured fields, never the body.
    await post('/teams/dawn/messages', { envelope: urgentEnv('nick', 'Bob', 'u-1') }, nickTok);
    const raised = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
      'x-musterd-no-touch': '1',
    });
    expect(raised.status).toBe(200);
    expect(raised.json.raised).toBe(true);
    expect(raised.json.count).toBe(1);
    expect(raised.json.act).toMatchObject({ id: 'u-1', from: 'nick', act: 'message' });
    expect(raised.json.line).toContain('⚡ musterd:');
    expect(raised.json.line).toContain('nick');
    expect(raised.json.line).not.toContain('ping'); // §4: never the raw message body

    // Delivery is audited once per (recipient, act) — who grabbed the mic, when, at whom.
    const afterFirst = auditRows('dawn').filter((r) => r.action === 'interrupt.raised');
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ actor: 'nick', target: 'Bob', result: 'allow' });
    expect(afterFirst[0]!.detail).toContain('u-1');

    // The probe re-fires at every tool boundary (cursor untouched), but the audit stays deduped to one.
    const again = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
      'x-musterd-no-touch': '1',
    });
    expect(again.json.raised).toBe(true);
    expect(auditRows('dawn').filter((r) => r.action === 'interrupt.raised')).toHaveLength(1);
  });

  it('steer act (ADR 103): persists through the DB and raises the interrupt line without an urgent flag', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
    const bobTok = bob.json.human_credential;

    // A non-urgent steer — no meta.urgent. It must persist (the v14 migration widened messages.act
    // beyond the frozen v5 CHECK) and, being interrupt-class by definition, raise the line anyway.
    const steer = {
      id: 'st-1',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from: 'nick',
      to: { kind: 'member', name: 'Bob' },
      act: 'steer',
      body: 'switch to the v2 schema',
      meta: undefined,
      ts: Date.now(),
    };
    const sent = await post('/teams/dawn/messages', { envelope: steer }, nickTok);
    expect(sent.status).toBe(201); // did not fail at the DB CHECK layer

    const raised = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
      'x-musterd-no-touch': '1',
    });
    expect(raised.json.raised).toBe(true);
    expect(raised.json.act).toMatchObject({ id: 'st-1', act: 'steer' });
    expect(raised.json.line).toContain('steer'); // raise class named on the line
    expect(raised.json.line).not.toContain('v2 schema'); // §4: never the raw body

    // Audited with the steer raise class, not a hardcoded 'urgent'.
    const audit = auditRows('dawn').filter((r) => r.action === 'interrupt.raised');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toContain('steer');
  });

  it('defer act (ADR 111, inc3): re-sequences the Goal, bumps its epoch, and wakes the stale lane owner', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const stan = await post('/teams/dawn/members', { name: 'stan', kind: 'human' }, nickTok);
    const stanTok = stan.json.human_credential;

    // Two declared Goals; `spine` sorts first by wave.
    await post('/teams/dawn/goals', { id: 'spine', title: 'Spine', wave: 1 }, nickTok);
    await post('/teams/dawn/goals', { id: 'client', title: 'Client', wave: 2 }, nickTok);

    // stan claims a lane on `spine` — building against epoch 0.
    const lane = await post(
      '/teams/dawn/lanes',
      { title: 'spine work', goal_id: 'spine', claim: true },
      stanTok,
    );
    expect(lane.status).toBe(201);

    // nick defers `spine` to the back (ts safely after the claim so the lane is provably stale).
    const deferEnv = {
      id: 'df-1',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from: 'nick',
      to: { kind: 'team' },
      act: 'defer',
      body: 'push spine behind client',
      meta: { goal_id: 'spine' },
      ts: Date.now() + 100_000,
    };
    const sent = await post('/teams/dawn/messages', { envelope: deferEnv }, nickTok);
    expect(sent.status).toBe(201);

    // Teeth #1 — the plan actually moved: `spine` is now `later` (sorts last) on epoch 1, so `next`
    // recommends `client` instead. Derived, no stored column touched.
    const goals = await get('/teams/dawn/goals', nickTok);
    const spine = goals.json.goals.find((g: { id: string }) => g.id === 'spine');
    expect(spine).toMatchObject({ wave: 'later', epoch: 1 });
    const next = await get('/teams/dawn/next', nickTok);
    expect(next.json.next_goal?.id).toBe('client');

    // Teeth #2 — targeted invalidation: stan (the stale lane's owner) got a directed stale_plan wake.
    const inbox = await get('/teams/dawn/inbox?unread=1', stanTok);
    const stale = inbox.json.messages.filter(
      (m: { meta?: { lane_warning?: { kind?: string } } }) =>
        m.meta?.lane_warning?.kind === 'stale_plan',
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].meta.lane_warning.subject).toBe(lane.json.lane.id);

    // ...and the board reflects it live.
    const board = await get('/teams/dawn/lanes', stanTok);
    expect(
      board.json.warnings.filter((w: { kind: string }) => w.kind === 'stale_plan'),
    ).toHaveLength(1);
  });

  it('delivery ledger (ADR 090): logged → seen (cursor) → answered, on the endpoint and the report', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
    const bobTok = bob.json.human_credential;

    // nick hands off to Bob.
    const env = { ...urgentEnv('nick', 'Bob', 'h-1'), act: 'handoff' };
    await post('/teams/dawn/messages', { envelope: env }, nickTok);

    // Unseen: the ledger shows logged, and the act sits on the report's open directed ledger.
    let ledger = await get('/teams/dawn/messages/h-1/delivery', bobTok);
    expect(ledger.status).toBe(200);
    expect(ledger.json).toMatchObject({ id: 'h-1', act: 'handoff', urgent: true });
    expect(ledger.json.recipients).toEqual([
      expect.objectContaining({ seat: 'Bob', seat_id: 'bob', state: 'logged', seen_by: null }),
    ]);
    let report = await get('/teams/dawn/report', nickTok);
    expect(report.json.open_directed.map((d: { id: string }) => d.id)).toContain('h-1');

    // Bob's cursor crosses the act → seen (watermark timestamp, not a receipt).
    await post('/teams/dawn/inbox/cursor', { last_read_message_id: 'h-1' }, bobTok);
    ledger = await get('/teams/dawn/messages/h-1/delivery', bobTok);
    expect(ledger.json.recipients[0]).toMatchObject({ state: 'seen' });
    expect(ledger.json.recipients[0].seen_by).not.toBeNull();

    // Bob accepts → answered, and the open directed ledger empties.
    await post(
      '/teams/dawn/messages',
      {
        envelope: {
          ...urgentEnv('Bob', 'nick', 'a-1'),
          act: 'accept',
          meta: { in_reply_to: 'h-1' },
        },
      },
      bobTok,
    );
    ledger = await get('/teams/dawn/messages/h-1/delivery', bobTok);
    expect(ledger.json.recipients[0]).toMatchObject({ state: 'answered' });
    expect(ledger.json.recipients[0].answered).toMatchObject({ act: 'accept', id: 'a-1' });
    report = await get('/teams/dawn/report', nickTok);
    expect(report.json.open_directed).toHaveLength(0);

    // Unknown act id → 404.
    const missing = await get('/teams/dawn/messages/nope/delivery', bobTok);
    expect(missing.status).toBe(404);
  });

  it('account_status + can_message gate sends', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
    await post('/teams/dawn/members', { name: 'Dis', kind: 'agent' }, nickTok);
    await post('/teams/dawn/members', { name: 'Mute', kind: 'agent' }, nickTok);

    setCaps('dawn', 'Dis', {}, 'disabled');
    setCaps('dawn', 'Mute', { can_message: 'none' });

    const baseEnv = (from: string, id: string) => ({
      id,
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from,
      to: { kind: 'member', name: 'Bob' },
      act: 'message',
      body: 'hi',
      ts: Date.now(),
    });
    const disabled = await post(
      '/teams/dawn/messages',
      { envelope: baseEnv('Dis', 'd1') },
      { key: team.json.agent_key, seat: 'Dis' },
    );
    expect(disabled.status).toBe(403);
    const muted = await post(
      '/teams/dawn/messages',
      { envelope: baseEnv('Mute', 'm1') },
      { key: team.json.agent_key, seat: 'Mute' },
    );
    expect(muted.status).toBe(403);
    const audit = auditRows('dawn');
    expect(audit.filter((r) => r.action === 'send.denied').length).toBe(2);
  });

  it('banned = inert: a disabled/banned seat cannot READ the inbox or firehose either (defense-in-depth)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Dis', kind: 'agent' }, nickTok);
    const auth = { key: team.json.agent_key as string, seat: 'Dis' };

    // Active, it reads fine...
    expect((await get('/teams/dawn/inbox', auth)).status).toBe(200);
    expect((await get('/teams/dawn/messages', auth)).status).toBe(200);

    // ...then disabling it closes BOTH reads (the send gate already blocked its sends). Banned means out.
    setCaps('dawn', 'Dis', {}, 'disabled');
    expect((await get('/teams/dawn/inbox', auth)).status).toBe(403);
    expect((await get('/teams/dawn/messages', auth)).status).toBe(403);
  });

  it('visibility_level: a non-admin viewer sees its own caps but not other seats’ authority map', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // Admin sees every seat's caps.
    const adminView = await get('/teams/dawn/members', nickTok);
    expect(adminView.json.members.find((m: any) => m.name === 'nick').capabilities).toBeDefined();
    expect(adminView.json.members.find((m: any) => m.name === 'Ada').capabilities).toBeDefined();

    // Ada (team-level) sees her own caps but not nick's.
    const adaView = await get('/teams/dawn/members', { key: team.json.agent_key, seat: 'Ada' });
    expect(adaView.json.members.find((m: any) => m.name === 'Ada').capabilities).toBeDefined();
    expect(adaView.json.members.find((m: any) => m.name === 'nick').capabilities).toBeUndefined();
    // Handles/roles/presence still visible — only the authority map is hidden.
    expect(adaView.json.members.find((m: any) => m.name === 'nick').name).toBe('nick');

    // Anonymous read → no caps at all.
    const anon = await get('/teams/dawn/members');
    expect(anon.json.members.every((m: any) => m.capabilities === undefined)).toBe(true);
  });

  it('can_observe: a seat narrowed to can_observe:false is refused the firehose', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Watcher', kind: 'human' }, nickTok);
    setCaps('dawn', 'Watcher', { can_observe: false });

    const w = new TestWs();
    await w.open();
    await w.claim(
      'dawn',
      team.json.agent_key,
      'Watcher',
      'cli',
      await standingGrant(team.json.human_credential, 'Watcher'),
    );
    w.send({ type: 'subscribe', scope: 'team-all' });
    const err = await w.waitFor('error');
    expect((err as any).code).toBe('forbidden');
    expect(auditRows('dawn').some((r) => r.action === 'observe.denied')).toBe(true);
    w.close();
  });

  // ── v0.3 P3.1 credential/grant admin endpoints (ADR 076) ───────────────────────────────────────
  it('issues a grant (msgr_, shown once), lists it without the secret, and revokes it', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;

    const issued = await post(
      '/teams/dawn/grants',
      { scope: 'seat', target: 'Ada', lifetime: 'once' },
      nickTok,
    );
    expect(issued.status).toBe(201);
    expect(issued.json.token).toMatch(/^msgr_/);
    expect(issued.json.grant.single_use).toBe(true);
    expect(auditRows('dawn').some((r) => r.action === 'grant.issue' && r.actor === 'nick')).toBe(
      true,
    );
    const issue = auditRows('dawn').find((r) => r.action === 'grant.issue')!;
    expect(JSON.parse(issue.detail!).authorized_by).toBe('nick');

    // listed without the secret token/hash
    const list = await get('/teams/dawn/grants', nickTok);
    expect(list.status).toBe(200);
    expect(list.json.grants).toHaveLength(1);
    expect(JSON.stringify(list.json.grants[0])).not.toContain('msgr_');
    expect(list.json.grants[0]).not.toHaveProperty('token_hash');

    const id = issued.json.grant.id;
    const revoked = await fetch(`${base}/teams/dawn/grants/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${nickTok}` },
    });
    expect(revoked.status).toBe(200);
    expect(auditRows('dawn').some((r) => r.action === 'grant.revoke')).toBe(true);
    // a second revoke of the same id is a 404 (already revoked)
    const again = await fetch(`${base}/teams/dawn/grants/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${nickTok}` },
    });
    expect(again.status).toBe(404);
  });

  it('rotates the team agent key (mskey_, shown once) + sets policy — both audited', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;

    const key = await post('/teams/dawn/agent-key/rotate', {}, nickTok);
    expect(key.status).toBe(200);
    expect(key.json.agent_key).toMatch(/^mskey_/);
    expect(auditRows('dawn').some((r) => r.action === 'key.rotate')).toBe(true);

    const pol = await post('/teams/dawn/policy', { allow_pre_issued_grants: true }, nickTok);
    expect(pol.status).toBe(200);
    expect(pol.json.policy.allow_pre_issued_grants).toBe(true);
    expect(auditRows('dawn').some((r) => r.action === 'policy.change')).toBe(true);
  });

  it('the P3.1 admin endpoints are is_admin-only (a non-admin is 403)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const denied = await post(
      '/teams/dawn/grants',
      { scope: 'seat', target: 'Ada', lifetime: 'standing' },
      { key: team.json.agent_key, seat: 'Ada' },
    );
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('forbidden');
    const key = await post(
      '/teams/dawn/agent-key/rotate',
      {},
      { key: team.json.agent_key, seat: 'Ada' },
    );
    expect(key.status).toBe(403);
  });
});

describe('coordination lanes, Phase 1 (ADR 083)', () => {
  it('warns inline + wakes the affected owner exactly once; board reflects live state', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
    const boTok = bo.json.human_credential;

    // nick opens + activates a schema lane.
    const l1 = await post(
      '/teams/dawn/lanes',
      {
        title: 'P3.1 schema',
        project: 'musterd',
        surface_globs: ['packages/server/src/store/**'],
        claim: true,
      },
      nickTok,
    );
    expect(l1.status).toBe(201);
    expect(l1.json.warnings).toHaveLength(0);
    await fetch(base + `/teams/dawn/lanes/${l1.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
      body: JSON.stringify({ state: 'active' }),
    });

    // bo opens a lane that depends on nick's AND overlaps its surface → two inline warnings.
    const l2 = await post(
      '/teams/dawn/lanes',
      {
        title: 'P3.2 handshake',
        project: 'musterd',
        surface_globs: ['packages/server/**'],
        depends_on: [l1.json.lane.id],
        claim: true,
      },
      boTok,
    );
    expect(l2.status).toBe(201);
    const kinds = l2.json.warnings.map((w: { kind: string }) => w.kind).sort();
    expect(kinds).toEqual(['surface_overlap', 'unmet_dependency']);

    // nick (the affected owner) got directed [lane] wakes — plus bo's lane-open broadcast to the
    // team (ADR 083 §4 extended: open/resolve are board-shape changes, unlike warnings which stay
    // directed). nick's own l1 open never appears here — the inbox excludes the sender's own acts.
    const inbox = await get('/teams/dawn/inbox?unread=1', nickTok);
    const laneMsgs = inbox.json.messages.filter((m: { body: string }) =>
      m.body.startsWith('[lane]'),
    );
    expect(laneMsgs).toHaveLength(3);
    // Order-independent: the three [lane] messages are emitted in one request and can share a
    // millisecond `ts`, so their inbox order falls to the ulid-`id` tiebreak (non-deterministic under
    // load — this assertion was flaky by fixed index). Assert the multiset instead: two directed
    // warnings to nick + one lane-open broadcast.
    expect(
      laneMsgs.filter((m: { meta: Record<string, unknown> }) => m.meta.lane_warning),
    ).toHaveLength(2);
    expect(
      laneMsgs.filter((m: { meta: Record<string, unknown> }) => m.meta.lane_open),
    ).toHaveLength(1);

    // Dedup: an unrelated update to bo's lane does NOT re-send the standing warnings (or a fresh
    // open broadcast — that's a one-time event).
    await fetch(base + `/teams/dawn/lanes/${l2.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(boTok) },
      body: JSON.stringify({ detail: 'progress note' }),
    });
    const inbox2 = await get('/teams/dawn/inbox?unread=1', nickTok);
    expect(
      inbox2.json.messages.filter((m: { body: string }) => m.body.startsWith('[lane]')),
    ).toHaveLength(3);

    // Board: both lanes, the pair of warnings annotated (overlap deduped to one).
    const board = await get('/teams/dawn/lanes?project=musterd', boTok);
    expect(board.json.lanes).toHaveLength(2);
    expect(board.json.warnings.length).toBe(2);

    // nick resolves his lane → bo's dependency warning clears from the board.
    await fetch(base + `/teams/dawn/lanes/${l1.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
      body: JSON.stringify({ state: 'done' }),
    });
    const board2 = await get('/teams/dawn/lanes', boTok);
    expect(
      board2.json.warnings.filter((w: { kind: string }) => w.kind === 'unmet_dependency'),
    ).toHaveLength(0);
  });

  it('handoff carries the branch to the recipient as a directed act', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
    const boTok = bo.json.human_credential;

    const lane = await post(
      '/teams/dawn/lanes',
      { title: 'BindingSchema', branch: 'agent/riley', claim: true },
      nickTok,
    );
    const handed = await fetch(base + `/teams/dawn/lanes/${lane.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(nickTok) },
      body: JSON.stringify({ owner_seat: 'bo' }),
    });
    const handedJson = (await handed.json()) as { lane: { owner_seat: string; branch: string } };
    expect(handedJson.lane.owner_seat).toBe('bo');
    expect(handedJson.lane.branch).toBe('agent/riley');

    // bo's inbox also has nick's lane-open broadcast ahead of the handoff — pick the handoff
    // specifically by its meta rather than the first `[lane]`-prefixed body.
    const inbox = await get('/teams/dawn/inbox?unread=1', boTok);
    const msg = inbox.json.messages.find(
      (m: { meta?: { lane_handoff?: unknown } }) => m.meta?.lane_handoff,
    );
    expect(msg.body).toContain('handed to you');
    expect(msg.body).toContain('agent/riley');
    expect(msg.meta.lane_handoff.branch).toBe('agent/riley');
  });

  it('resolving a branch-carrying lane audits git.pr_merged with the attested merge detail (ADR 109)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'ada', kind: 'agent' }, nickTok);
    const ada = { key: team.json.agent_key, seat: 'ada' };

    const lane = await post(
      '/teams/dawn/lanes',
      { title: 'seat attribution', branch: 'feat/seat-git-attribution', claim: true },
      ada,
    );
    await fetch(base + `/teams/dawn/lanes/${lane.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(ada) },
      body: JSON.stringify({
        state: 'done',
        merged: { pr: 167, sha: 'abc1234', authorized_by: 'nick', extra: 'stripped-by-schema' },
      }),
    });

    const audit = await get('/teams/dawn/audit', nickTok);
    const row = audit.json.audit.find((r: { action: string }) => r.action === 'git.pr_merged');
    expect(row).toBeDefined();
    expect(row.actor).toBe('ada');
    expect(row.target).toBe('feat/seat-git-attribution');
    const detail = row.detail; // GET /audit returns detail already parsed
    expect(detail).toMatchObject({ pr: 167, sha: 'abc1234', authorized_by: 'nick' });
    expect(detail.extra).toBeUndefined();

    // An abandoned branch-carrying lane does NOT attest a merge.
    const lane2 = await post(
      '/teams/dawn/lanes',
      { title: 'dead end', branch: 'feat/dead-end', claim: true },
      ada,
    );
    await fetch(base + `/teams/dawn/lanes/${lane2.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(ada) },
      body: JSON.stringify({ state: 'abandoned' }),
    });
    const audit2 = await get('/teams/dawn/audit', nickTok);
    expect(
      audit2.json.audit.filter((r: { action: string }) => r.action === 'git.pr_merged'),
    ).toHaveLength(1);
  });

  it('surfaces noteless lane transitions: self-claim + non-terminal state move (ADR 102)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const ada = { key: team.json.agent_key, seat: 'ada' };
    await post('/teams/dawn/members', { name: 'ada', kind: 'agent' }, nickTok);

    // Open unowned (no claim), then ada claims it — the self-claim is a team-visible transition.
    const lane = await post('/teams/dawn/lanes', { title: 'eviction fix' }, nickTok);
    const laneId = lane.json.lane.id;
    await fetch(base + `/teams/dawn/lanes/${laneId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(ada) },
      body: JSON.stringify({ owner_seat: 'ada' }),
    });
    // A non-terminal move (active → blocked) is a transition; a terminal move (→ done) is a resolve.
    await fetch(base + `/teams/dawn/lanes/${laneId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(ada) },
      body: JSON.stringify({ state: 'blocked' }),
    });
    await fetch(base + `/teams/dawn/lanes/${laneId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(ada) },
      body: JSON.stringify({ state: 'done' }),
    });

    const stream = await get('/teams/dawn/messages', nickTok);
    const metas = stream.json.messages.map((m: { meta?: Record<string, unknown> }) => m.meta ?? {});
    const claim = metas.find((m: Record<string, unknown>) => m['lane_claim']) as
      | { lane_claim: { lane: string; title: string } }
      | undefined;
    const stateMove = metas.find((m: Record<string, unknown>) => m['lane_state']) as
      | { lane_state: { state: string } }
      | undefined;
    expect(claim?.lane_claim.title).toBe('eviction fix');
    // Only the non-terminal move emits lane_state; the → done move rides lane_resolve, not lane_state.
    expect(stateMove?.lane_state.state).toBe('blocked');
    expect(metas.filter((m: Record<string, unknown>) => m['lane_state']).length).toBe(1);
    expect(metas.some((m: Record<string, unknown>) => m['lane_resolve'])).toBe(true);
  });

  it('goal_id join + GET /next: the orientation brief over lanes + the handoff why (ADR 049/084)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const ada = { key: team.json.agent_key, seat: 'Ada' };
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // Ada opens two lanes on one Goal — one active (carrying), one done (shipped).
    const carrying = await post(
      '/teams/dawn/lanes',
      { title: 'spine command', goal_id: 'orientation-spine', claim: true },
      ada,
    );
    expect(carrying.status).toBe(201);
    expect(carrying.json.lane.goal_id).toBe('orientation-spine');
    await fetch(base + `/teams/dawn/lanes/${carrying.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(ada) },
      body: JSON.stringify({ state: 'active' }),
    });
    const shipped = await post(
      '/teams/dawn/lanes',
      { title: 'spine migration', goal_id: 'orientation-spine', claim: true },
      ada,
    );
    await fetch(base + `/teams/dawn/lanes/${shipped.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(ada) },
      body: JSON.stringify({ state: 'done' }),
    });
    // An unowned lane anyone could pick up.
    await post('/teams/dawn/lanes', { title: 'backlog item' }, nickTok);

    // The goal filter returns only the two joined lanes.
    const byGoal = await get('/teams/dawn/lanes?goal=orientation-spine', ada);
    expect(byGoal.json.lanes).toHaveLength(2);

    // nick hands off to the team with a goal pointer — the brief's why.
    await post(
      '/teams/dawn/messages',
      {
        envelope: {
          id: 'ho1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'nick',
          to: { kind: 'team' },
          act: 'handoff',
          body: 'pick up the orientation spine',
          meta: { goal_id: 'orientation-spine' },
          ts: Date.now(),
        },
      },
      nickTok,
    );

    const brief = await get('/teams/dawn/next', ada);
    expect(brief.status).toBe(200);
    expect(brief.json.member).toBe('Ada');
    expect(brief.json.in_flight.map((l: { id: string }) => l.id)).toEqual([carrying.json.lane.id]);
    expect(brief.json.shipped.map((l: { id: string }) => l.id)).toEqual([shipped.json.lane.id]);
    expect(brief.json.up_next).toHaveLength(1);
    expect(brief.json.why.from).toBe('nick');
    expect(brief.json.why.goal_id).toBe('orientation-spine');
  });
});

describe('declared Goals + next_goal (ADR 048/084)', () => {
  it('declares Goals over HTTP, derives status from lanes, and surfaces the next one in the brief', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const ada = { key: team.json.agent_key, seat: 'Ada' };
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // Two Goals: 'engine' (wave 1) and 'surface' (wave 2, depends on engine).
    const g1 = await post(
      '/teams/dawn/goals',
      { id: 'engine', title: 'Insight engine', wave: 1 },
      nickTok,
    );
    expect(g1.status).toBe(201);
    expect(g1.json.goal.status).toBe('planned');
    await post(
      '/teams/dawn/goals',
      { id: 'surface', title: 'CLI surface', wave: 2, depends_on: ['engine'] },
      nickTok,
    );

    // GET /goals lists both, newest-declaration-per-id, with derived status.
    const goals = await get('/teams/dawn/goals', ada);
    expect(goals.json.goals.map((g: { id: string }) => g.id).sort()).toEqual(['engine', 'surface']);

    // next_goal = first planned by wave = engine (surface is blocked on engine).
    let brief = await get('/teams/dawn/next', ada);
    expect(brief.json.next_goal.id).toBe('engine');

    // Ada opens + resolves a lane on 'engine' → engine ships → next_goal advances to 'surface'.
    const lane = await post(
      '/teams/dawn/lanes',
      { title: 'build engine', goal_id: 'engine', claim: true },
      ada,
    );
    await fetch(base + `/teams/dawn/lanes/${lane.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(ada) },
      body: JSON.stringify({ state: 'done' }),
    });

    const engineNow = (await get('/teams/dawn/goals', ada)).json.goals.find(
      (g: { id: string }) => g.id === 'engine',
    );
    expect(engineNow.status).toBe('shipped');
    brief = await get('/teams/dawn/next', ada);
    expect(brief.json.next_goal.id).toBe('surface');
  });
});

describe('insight report (ADR 050/084)', () => {
  it('GET /report projects flow metrics, waiting-on, goals, and blocked lanes', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const ada = { key: team.json.agent_key, seat: 'Ada' };
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // A shipped lane (throughput + goal status) and a blocked lane (the exception).
    await post('/teams/dawn/goals', { id: 'engine', title: 'Engine', wave: 1 }, nickTok);
    const shipped = await post(
      '/teams/dawn/lanes',
      { title: 'built', goal_id: 'engine', claim: true },
      ada,
    );
    await fetch(base + `/teams/dawn/lanes/${shipped.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(ada) },
      body: JSON.stringify({ state: 'done' }),
    });
    const stuck = await post('/teams/dawn/lanes', { title: 'stuck work', claim: true }, ada);
    await fetch(base + `/teams/dawn/lanes/${stuck.json.lane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(ada) },
      body: JSON.stringify({ state: 'blocked' }),
    });

    // nick directs a request_help at Ada → Ada owes → waiting-on Ada.
    await post(
      '/teams/dawn/messages',
      {
        envelope: {
          id: 'rh1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'Ada' },
          act: 'request_help',
          body: 'need a hand',
          ts: Date.now() - 60_000,
        },
      },
      nickTok,
    );

    const report = await get('/teams/dawn/report', ada);
    expect(report.status).toBe(200);
    expect(report.json.team).toBe('dawn');
    expect(report.json.flow.throughput_7d).toBe(1);
    expect(report.json.flow.wip).toBe(1); // the blocked lane contends
    expect(report.json.goals.find((g: { id: string }) => g.id === 'engine').status).toBe('shipped');
    expect(report.json.blocked.map((b: { id: string }) => b.id)).toEqual([stuck.json.lane.id]);
    expect(report.json.waiting_on).toEqual([
      expect.objectContaining({ member: 'Ada', threads: 1 }),
    ]);
    // Coordination-density is present; a tiny sample never flags.
    expect(report.json.coordination).toMatchObject({ window_days: 7, flag: false });
  });
});

describe('seat memory endpoints + occupy envelope (ADR 093)', () => {
  async function dawn() {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential as string;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    const ada: Auth = { key: team.json.agent_key as string, seat: 'Ada' };
    return { team, nickTok, ada };
  }

  it('PUT saves for the authenticated seat; GET returns the body; DELETE clears', async () => {
    const { ada } = await dawn();
    const put = await req(
      'PUT',
      '/teams/dawn/memory',
      { headline: 'mid-refactor', body: 'ws.ts' },
      ada,
    );
    expect(put.status).toBe(204);

    const got = await get('/teams/dawn/memory', ada);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ headline: 'mid-refactor', body: 'ws.ts' });
    expect(typeof got.json.saved_at).toBe('number');

    const del = await req('DELETE', '/teams/dawn/memory', undefined, ada);
    expect(del.status).toBe(204);
    expect((await get('/teams/dawn/memory', ada)).status).toBe(404);
    // idempotent — a second DELETE still 204s
    expect((await req('DELETE', '/teams/dawn/memory', undefined, ada)).status).toBe(204);
  });

  it('memory is self-scoped: a seat only ever reads/writes its own — no cross-seat path, admin included', async () => {
    const { nickTok, ada } = await dawn();
    await req('PUT', '/teams/dawn/memory', { headline: "ada's note", body: 'secret' }, ada);

    // nick (an admin/human) hitting /memory reads NICK's own memory (none) — never Ada's. There is no
    // URL that names another seat, so the note cannot leak across seats (ADR 093 §4).
    const asAdmin = await get('/teams/dawn/memory', nickTok);
    expect(asAdmin.status).toBe(404);

    // and Ada still sees her own
    expect((await get('/teams/dawn/memory', ada)).json.body).toBe('secret');
  });

  it('GET ?envelope=1 returns headline + age + size, never the body (the status one-liner read)', async () => {
    const { ada } = await dawn();
    // Nothing saved → same 404 as the body read.
    expect((await get('/teams/dawn/memory?envelope=1', ada)).status).toBe(404);

    await req('PUT', '/teams/dawn/memory', { headline: 'mid-refactor', body: '€€' }, ada);
    const env = await get('/teams/dawn/memory?envelope=1', ada);
    expect(env.status).toBe(200);
    expect(env.json).toEqual({
      headline: 'mid-refactor',
      saved_at: expect.any(Number),
      size_bytes: 6, // '€€' = 6 UTF-8 bytes
    });
    expect(env.json.body).toBeUndefined();
  });

  it('banned = inert: a disabled seat cannot read, write, or clear its memory (defense-in-depth)', async () => {
    const { ada } = await dawn();
    await req('PUT', '/teams/dawn/memory', { headline: 'before', body: 'note' }, ada);

    const setStatus = (status: string | null) => {
      const teamRow = getTeamBySlug(server.db, 'dawn')!;
      const m = getMemberByName(server.db, teamRow.id, 'Ada')!;
      setMemberGovernance(server.db, m.id, status, JSON.stringify(GENERALIST_CAPABILITIES));
    };
    setStatus('disabled');
    expect((await get('/teams/dawn/memory', ada)).status).toBe(403);
    expect((await get('/teams/dawn/memory?envelope=1', ada)).status).toBe(403);
    expect((await req('PUT', '/teams/dawn/memory', { headline: 'after' }, ada)).status).toBe(403);
    expect((await req('DELETE', '/teams/dawn/memory', undefined, ada)).status).toBe(403);

    // Re-enabling restores access and the note survived untouched.
    setStatus('active');
    expect((await get('/teams/dawn/memory', ada)).json.headline).toBe('before');
  });

  it('an occupied frame (WS claim) carries the envelope when memory exists, null when not', async () => {
    const { team, nickTok, ada } = await dawn();

    // First claim with no saved memory → occupied.memory is null.
    const w1 = new TestWs();
    await w1.open();
    const occ1 = (await w1.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'cli',
      await standingGrant(nickTok, 'Ada'),
    )) as any;
    expect(occ1.memory).toBeNull();
    w1.close();

    // Save a note, then a fresh claim carries the envelope (headline + size, never a body).
    await req('PUT', '/teams/dawn/memory', { headline: 'left off at eviction', body: '€€' }, ada);
    const w2 = new TestWs();
    await w2.open();
    const occ2 = (await w2.claim(
      'dawn',
      team.json.agent_key,
      'Ada',
      'cli',
      await standingGrant(nickTok, 'Ada'),
    )) as any;
    expect(occ2.memory).toEqual({
      headline: 'left off at eviction',
      saved_at: expect.any(Number),
      size_bytes: 6, // '€€' = 6 UTF-8 bytes
    });
    expect(occ2.memory.body).toBeUndefined();
    w2.close();
  });

  it('oversize body → 400 naming the 8192 limit; missing headline → 400', async () => {
    const { ada } = await dawn();
    const big = await req(
      'PUT',
      '/teams/dawn/memory',
      { headline: 'h', body: 'x'.repeat(8193) },
      ada,
    );
    expect(big.status).toBe(400);
    expect(big.json.error.message).toContain('8192');

    const noHeadline = await req('PUT', '/teams/dawn/memory', { body: 'x' }, ada);
    expect(noHeadline.status).toBe(400);
  });

  it('audit rows for memory.save carry sizes only — never the headline or body text', async () => {
    const { ada } = await dawn();
    await req(
      'PUT',
      '/teams/dawn/memory',
      { headline: 'sensitive subject', body: 'PASSWORD=hunter2' },
      ada,
    );

    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    const rows = listAudit(server.db, teamId).filter((r) => r.action === 'memory.save');
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail!);
    expect(detail).toEqual({ size_bytes: 16, headline_len: 17 });
    // the content itself never appears in the audit row
    expect(rows[0]!.detail).not.toContain('hunter2');
    expect(rows[0]!.detail).not.toContain('sensitive subject');

    await req('DELETE', '/teams/dawn/memory', undefined, ada);
    const clears = listAudit(server.db, teamId).filter((r) => r.action === 'memory.clear');
    expect(clears).toHaveLength(1);
  });
});

/**
 * Seat provisioning is localhost-trust — and now actually enforces it.
 *
 * `POST /members` mints a seat and returns its secret, and an `{observer:true}` seat reads every
 * directed message on the team (GET /messages and the firehose both exempt observers, ADR 128). The
 * route always *described* itself as localhost-trust but never checked the peer, so on an ADR 040
 * off-loopback bind anyone who could reach the port could mint a DM-reading credential.
 *
 * These tests bind on loopback (so the peer really is 127.0.0.1) and flip `trustProxy` to model the
 * off-loopback deployment: with a proxy in front, the peer address stops being evidence of anything,
 * which is exactly the case a naive `remoteAddress === '127.0.0.1'` check would get catastrophically
 * wrong.
 */
describe('provisioning is localhost-trust, enforced (observer DM disclosure)', () => {
  let proxied: RunningServer;
  let pbase: string;

  beforeEach(async () => {
    proxied = createServer({ db: openDb(':memory:'), port: 0, trustProxy: true });
    const { port } = await proxied.listen();
    pbase = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    await proxied.close();
  });

  async function ppost(path: string, body: unknown, auth?: string) {
    const res = await fetch(pbase + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  it('refuses to mint an observer for an unauthenticated non-local caller', async () => {
    await ppost('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });

    const res = await ppost('/teams/dawn/members', {
      name: 'watcher',
      kind: 'human',
      observer: true,
    });

    expect(res.status).toBe(401);
    // The refusal has to explain *where they are*, not just "unauthorized" — the caller is a browser.
    expect(res.json.error.message).toMatch(/directed messages|admin credential/i);
  });

  it('refuses an ordinary seat too — the mint itself is the privilege', async () => {
    await ppost('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const res = await ppost('/teams/dawn/members', { name: 'Ada', kind: 'agent' });
    expect(res.status).toBe(401);
  });

  it('an admin credential still provisions from anywhere', async () => {
    const team = await ppost('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential as string;
    expect(team.json.member.capabilities.is_admin).toBe(true);

    const res = await ppost(
      '/teams/dawn/members',
      { name: 'watcher', kind: 'human', observer: true },
      nickTok,
    );
    expect(res.status).toBe(201);
    expect(res.json.human_credential).toMatch(/^mscr_/);
  });

  it('a non-admin seat cannot mint — no privilege laundering through an ordinary credential', async () => {
    const team = await ppost('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential as string;
    const ada = await ppost('/teams/dawn/members', { name: 'Ada', kind: 'human' }, nickTok);
    const adaTok = ada.json.human_credential as string;

    const res = await ppost(
      '/teams/dawn/members',
      { name: 'watcher', kind: 'human', observer: true },
      adaTok,
    );
    expect(res.status).toBe(403);
  });

  it('the local dashboard is untouched: a loopback peer still provisions unauthenticated', async () => {
    // `server` (the outer suite's) has no trustProxy — a real 127.0.0.1 peer, the /live case.
    await post('/teams', { slug: 'dusk', creator: { name: 'nick', kind: 'human' } });
    const res = await post('/teams/dusk/members', { name: 'web-1', kind: 'human', observer: true });
    expect(res.status).toBe(201);
    expect(res.json.human_credential).toMatch(/^mscr_/);
  });
});

/**
 * Observer grades (ADR 136) — a shared watch-link sees only public traffic.
 *
 * `members.observer` said *that* a seat was a read-only watcher but not *how much it may see*, so
 * every observer was full-visibility and a shared watch-link carried the team's DMs. A link now mints
 * a **public-grade** observer of its own.
 *
 * The enforcement is deliberately *not* a new query: a public observer is simply no longer exempt from
 * the ADR 128 recipient-scoping, and for an observer that predicate collapses to exactly the public
 * timeline — it can never be a sender (read-only), and team/broadcast fanout excludes it.
 */
describe('observer grades: a public-grade observer sees only public traffic (ADR 136)', () => {
  async function seedTeam() {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = team.json.human_credential as string;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
    return { team, tok, key: team.json.agent_key as string };
  }

  /** Ada→Lin DM (private), then Ada→team (public). */
  async function seedTraffic(key: string) {
    await post(
      '/teams/dawn/messages',
      {
        envelope: {
          id: 'dm1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'Lin' },
          act: 'message',
          body: 'private',
          ts: Date.now(),
        },
      },
      { key, seat: 'Ada' },
    );
    await post(
      '/teams/dawn/messages',
      {
        envelope: {
          id: 'pub1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: 'public',
          ts: Date.now() + 1,
        },
      },
      { key, seat: 'Ada' },
    );
  }

  it('GET /messages: the public observer gets team traffic, never the DM — the full one gets both', async () => {
    const { tok, key } = await seedTeam();
    const shared = await post(
      '/teams/dawn/members',
      { name: 'watch-1', kind: 'human', observer: true, observer_scope: 'public' },
      tok,
    );
    const local = await post(
      '/teams/dawn/members',
      { name: 'web-1', kind: 'human', observer: true },
      tok,
    );
    await seedTraffic(key);

    const sharedView = await get('/teams/dawn/messages', shared.json.human_credential);
    expect(sharedView.json.messages.map((m: any) => m.id)).toEqual(['pub1']);

    // The local dashboard is unchanged — grade defaults to full, so it still sees the coordination.
    const localView = await get('/teams/dawn/messages', local.json.human_credential);
    expect(localView.json.messages.map((m: any) => m.id)).toEqual(['dm1', 'pub1']);
  });

  it('firehose: the public observer is not pushed a DM between two others, but does get team acts', async () => {
    const { team, tok, key } = await seedTeam();
    const shared = await post(
      '/teams/dawn/members',
      { name: 'watch-1', kind: 'human', observer: true, observer_scope: 'public' },
      tok,
    );
    expect(shared.status).toBe(201);

    const a = new TestWs();
    const w = new TestWs();
    await Promise.all([a.open(), w.open()]);
    await a.claim('dawn', key, 'Ada', 'claude-code', await standingGrant(tok, 'Ada'));
    await w.claim('dawn', key, 'watch-1', 'web', await standingGrant(tok, 'watch-1'));
    await w.subscribe('team-all');

    // A DM between two other seats must NOT reach the shared link …
    a.send({
      type: 'send',
      envelope: {
        id: 'dm1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'member', name: 'Lin' },
        act: 'message',
        body: 'private',
        ts: Date.now(),
      },
    });
    // … while a team act, sent after it, must. Asserting on the *next* frame is what makes this a real
    // test: if the DM leaked it would arrive first, and the public act would not be frame #1.
    a.send({
      type: 'send',
      envelope: {
        id: 'pub1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'status_update',
        body: 'public',
        ts: Date.now() + 1,
      },
    });

    const frame = await w.waitFor('deliver');
    expect((frame as any).envelope.id).toBe('pub1');
    expect((frame as any).envelope.body).toBe('public');

    a.close();
    w.close();
    expect(team.status).toBe(201);
  });

  it('a DM addressed TO the public observer still reaches it — it is that seat’s own mail', async () => {
    const { tok, key } = await seedTeam();
    const shared = await post(
      '/teams/dawn/members',
      { name: 'watch-1', kind: 'human', observer: true, observer_scope: 'public' },
      tok,
    );
    await post(
      '/teams/dawn/messages',
      {
        envelope: {
          id: 'toWatcher',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'watch-1' },
          act: 'message',
          body: 'for the watcher',
          ts: Date.now(),
        },
      },
      { key, seat: 'Ada' },
    );

    const view = await get('/teams/dawn/messages', shared.json.human_credential);
    expect(view.json.messages.map((m: any) => m.id)).toEqual(['toWatcher']);
  });

  it('existing observers are unaffected by the migration — no silent downgrade of a live dashboard', async () => {
    const { tok, key } = await seedTeam();
    // A seat minted with no grade at all — the pre-ADR-135 shape, and what v17 backfills to 'full'.
    const legacy = await post(
      '/teams/dawn/members',
      { name: 'web-legacy', kind: 'human', observer: true },
      tok,
    );
    await seedTraffic(key);
    const view = await get('/teams/dawn/messages', legacy.json.human_credential);
    expect(view.json.messages.map((m: any) => m.id)).toEqual(['dm1', 'pub1']);
  });
});

describe('tool-call telemetry ingest (ADR 144 inc 1)', () => {
  it('folds a flush into the report, stamps role at ingest, and 400s malformed batches', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const ada = { key: team.json.agent_key, seat: 'Ada' };
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent', role: 'ux' }, nickTok);

    // Malformed: an outcome outside the enum bounces the whole batch (parseOrBadRequest).
    const bad = await post(
      '/teams/dawn/telemetry/tool-calls',
      {
        events: [{ tool: 't', outcome: 'meh', calls: 1, total_duration_ms: 0, max_duration_ms: 0 }],
      },
      ada,
    );
    expect(bad.status).toBe(400);

    const ok = await post(
      '/teams/dawn/telemetry/tool-calls',
      {
        events: [
          {
            tool: 'team_send',
            outcome: 'ok',
            calls: 2,
            total_duration_ms: 90,
            max_duration_ms: 60,
          },
          {
            tool: 'team_send',
            outcome: 'invalid_input',
            calls: 1,
            total_duration_ms: 3,
            max_duration_ms: 3,
          },
        ],
        surface: { tools: 18, bytes: 40_000, est_tokens: 10_000 },
      },
      ada,
    );
    expect(ok.status).toBe(200);

    const report = await get('/teams/dawn/report', nickTok);
    const t = report.json.tool_calls;
    expect(t.calls).toBe(3);
    expect(t.bounces).toBe(1);
    // Role was stamped server-side from the member row — the wire carries no role field.
    expect(t.tools[0].by_role).toEqual({ ux: 3 });
    expect(t.surface).toEqual([
      expect.objectContaining({ seat: 'Ada', tools: 18, bytes: 40_000, est_tokens: 10_000 }),
    ]);
    // The attestation is an ordinary append-only audit row (the wake_cost precedent).
    const teamRow = getTeamBySlug(server.db, 'dawn')!;
    const audit = listAudit(server.db, teamRow.id).filter(
      (r) => r.action === 'mcp.surface_rendered',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe('Ada');
  });
});

describe('dogfood re-seat (ADR 146)', () => {
  it('re-occupies a held agent seat over WS with no grant when the policy is on', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);

    // First occupancy stamps the durable `bound_at` marker — the "already held it" signal.
    const a1 = new TestWs();
    await a1.open();
    await a1.claim('dawn', team.json.agent_key, 'Ada', 'cli', await standingGrant(nickCred, 'Ada'));
    a1.close();

    // The team opts into dogfood-mode re-seat.
    const pol = await post('/teams/dawn/policy', { standing_reseat_known_agents: true }, nickCred);
    expect(pol.json.policy.standing_reseat_known_agents).toBe(true);

    // A fresh session re-claims with only the team agent key — occupies immediately, no pending gate.
    const a2 = new TestWs();
    await a2.open();
    const occ = await a2.claim('dawn', team.json.agent_key, 'Ada', 'cli');
    expect(occ.type).toBe('occupied');
    expect((occ as any).seat.name).toBe('Ada');

    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    await pollUntil(() => listAudit(server.db, teamId).some((x) => x.action === 'claim.reseated'));
    a2.close();
  });

  it('still opens a pending request for a never-bound seat even with the policy on', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
    await post('/teams/dawn/policy', { standing_reseat_known_agents: true }, nickCred);

    // Ada was never occupied — admission, not a re-seat: the server opens a pending request.
    const a = new TestWs();
    await a.open();
    a.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: team.json.agent_key,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    const pending = await a.waitFor('pending');
    expect(pending.type).toBe('pending');
    a.close();
  });
});

describe('the to-human ask stream (ADR 147)', () => {
  /** Build a schema-shaped envelope for POST /messages (the harness posts raw envelopes). */
  function env(from: string, to: unknown, act: string, meta: Record<string, unknown>, id: string) {
    return { id, v: PROTOCOL_VERSION, team: 'dawn', from, to, act, body: '', meta, ts: Date.now() };
  }

  it('raises ask.raised carrying species+tier and lands the ask in the admin inbox', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
    const ada = { key: team.json.agent_key, seat: 'Ada' };

    const sent = await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'ask',
          { species: 'escalate', tier: 'blocking' },
          'ask-1',
        ),
      },
      ada,
    );
    expect(sent.status).toBe(201);

    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    const raised = listAudit(server.db, teamId).find((r) => r.action === 'ask.raised');
    expect(raised).toBeDefined();
    expect(JSON.parse(raised!.detail!)).toMatchObject({ species: 'escalate', tier: 'blocking' });

    // The durable reach: the admin (creator) sees the ask waiting in their inbox.
    const inbox = await get('/teams/dawn/inbox', nickCred);
    expect(inbox.json.messages.some((m: any) => m.id === 'ask-1' && m.act === 'ask')).toBe(true);
  });

  it('pushes a member-directed ask to a live admin too (guaranteed reach, §3)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickCred); // a non-admin human
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
    const ada = { key: team.json.agent_key, seat: 'Ada' };

    // nick (admin) is live on WS but NOT a firehose subscriber — the only path to them is deliverToAdmins.
    const nick = new TestWs();
    await nick.open();
    await nick.claim('dawn', nickCred, 'nick', 'cli');

    // Ada asks a *non-admin* human — nick is not a recipient, yet must still receive it (asks route to admins).
    await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'member', name: 'bo' },
          'ask',
          { species: 'consult', tier: 'standard' },
          'ask-2',
        ),
      },
      ada,
    );
    const deliver = await nick.waitFor('deliver');
    expect((deliver as any).envelope.id).toBe('ask-2');
    expect((deliver as any).envelope.act).toBe('ask');
    nick.close();
  });

  it('records the no-answer resolutions and the human "deciding" reply', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
    const ada = { key: team.json.agent_key, seat: 'Ada' };
    const teamId = getTeamBySlug(server.db, 'dawn')!.id;

    // Below-top ask timed out unanswered → the agent proceeds, recording what it risked.
    await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'status_update',
          {
            ask_ref: 'ask-x',
            ask_outcome: 'risk_accepted',
            risk: 'may re-run a migration',
            chosen_approach: 'ran it idempotently behind a guard',
          },
          'res-1',
        ),
      },
      ada,
    );
    // Top-tier ask timed out → the agent holds, does not proceed.
    await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'status_update',
          { ask_ref: 'ask-y', ask_outcome: 'held' },
          'res-2',
        ),
      },
      ada,
    );
    // The human answers "deciding — check back in 1h" (rides `wait`).
    await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'nick',
          { kind: 'member', name: 'Ada' },
          'wait',
          { ask_ref: 'ask-y', until: '1h' },
          'res-3',
        ),
      },
      nickCred,
    );

    const audit = listAudit(server.db, teamId);
    const risk = audit.find((r) => r.action === 'ask.risk_accepted');
    expect(JSON.parse(risk!.detail!)).toMatchObject({
      ask_ref: 'ask-x',
      risk: 'may re-run a migration',
      chosen_approach: 'ran it idempotently behind a guard',
      human_unreachable: true,
    });
    expect(audit.some((r) => r.action === 'ask.held')).toBe(true);
    const deferred = audit.find((r) => r.action === 'ask.deferred');
    expect(JSON.parse(deferred!.detail!)).toMatchObject({ ask_ref: 'ask-y', until: '1h' });

    // ADR 153: the strand terminal — top-tier timeout with no reachable unblocker; the agent released
    // its lane and stopped. One `ask.stranded` row carrying the reason makes the dead-end queryable.
    await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'status_update',
          { ask_ref: 'ask-z', ask_outcome: 'stranded' },
          'res-4',
        ),
      },
      ada,
    );
    const stranded = listAudit(server.db, teamId).find((r) => r.action === 'ask.stranded');
    expect(JSON.parse(stranded!.detail!)).toMatchObject({
      ask_ref: 'ask-z',
      reason: 'no_reachable_unblocker',
    });
  });

  it('an ask ack carries the derived contract with the reachability projection (ADR 153 §1)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, undefined, team.json.token);
    const ada = { key: team.json.agent_key, seat: 'Ada' };

    const res = await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'ask',
          { species: 'approve', tier: 'blocking' },
          'ask-r-1',
        ),
      },
      ada,
    );
    expect(res.status).toBe(201);
    // nick (the creator, admin human) exists but has no live presence and no loud reach is wired, and
    // Ada is the raiser with no live teammate — provably unreachable: the FB3 shape.
    expect(res.json.ask_contract).toMatchObject({
      timeout_ms: 15 * 60_000,
      no_answer: 'hold',
      unblocker_reachable: false,
    });
    // A non-ask ack stays contract-free (additive — nothing rides responses that don't need it).
    const plain = await post(
      '/teams/dawn/messages',
      { envelope: env('Ada', { kind: 'team' }, 'status_update', null, 'su-r-1') },
      ada,
    );
    expect(plain.json.ask_contract).toBeUndefined();
  });

  it('round-trips the ask_fallback_to_nonadmin team policy (default off)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    expect(team.json.policy.ask_fallback_to_nonadmin).toBe(false);

    const set = await post('/teams/dawn/policy', { ask_fallback_to_nonadmin: true }, nickCred);
    expect(set.json.policy.ask_fallback_to_nonadmin).toBe(true);
    // Setting the ask knob must not clobber the other policy defaults (read-merge-write).
    expect(set.json.policy.standing_reseat_known_agents).toBe(false);
    const got = await get('/teams/dawn/policy', nickCred);
    expect(got.json.policy.ask_fallback_to_nonadmin).toBe(true);
  });
});

describe('ask surfaces — Slack delivery (ADR 149)', () => {
  function env(from: string, to: unknown, act: string, meta: Record<string, unknown>, id: string) {
    return {
      id,
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from,
      to,
      act,
      body: 'need a call',
      meta,
      ts: Date.now(),
    };
  }

  /** Intercept only the Slack webhook host; every other URL (the test server itself) passes through —
   *  the daemon and these test helpers share the one global fetch. */
  function stubSlack(handler: (body: { text: string }) => Response | Promise<Response>) {
    const realFetch = globalThis.fetch;
    const calls: { url: string; text: string }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://hooks.slack.test/')) {
        const body = JSON.parse(String(init?.body)) as { text: string };
        calls.push({ url, text: body.text });
        return handler(body);
      }
      return realFetch(input as never, init);
    });
    return calls;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('posts a raised ask to the configured webhook and audits ask.surfaced ok:true', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
    await post(
      '/teams/dawn/policy',
      { ask_slack_webhook: 'https://hooks.slack.test/T/B/x' },
      nickCred,
    );
    // ADR 155 Inc 2: the at-raise fire is the away-admin case — pin nick away so this test can't be
    // flipped quiet by an incidental presence touch.
    await post('/teams/dawn/availability', { status: 'away' }, nickCred);
    const calls = stubSlack(() => new Response('ok', { status: 200 }));

    const sent = await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'ask',
          { species: 'escalate', tier: 'blocking' },
          'ask-s1',
        ),
      },
      { key: team.json.agent_key, seat: 'Ada' },
    );
    expect(sent.status).toBe(201);

    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    await pollUntil(() => listAudit(server.db, teamId).some((r) => r.action === 'ask.surfaced'));
    const surfaced = listAudit(server.db, teamId).find((r) => r.action === 'ask.surfaced')!;
    expect(JSON.parse(surfaced.detail!)).toMatchObject({ surface: 'slack', ok: true, status: 200 });
    // The URL is a secret — the audit row must not carry it.
    expect(surfaced.detail).not.toContain('hooks.slack.test');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('[dawn] Ada escalated to you');
    expect(calls[0]!.text).toContain('blocking — holds after 15m');
    expect(calls[0]!.text).toContain('need a call');
  });

  it('a dead webhook cannot fail the send — 201 anyway, ask.surfaced ok:false', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
    await post(
      '/teams/dawn/policy',
      { ask_slack_webhook: 'https://hooks.slack.test/T/B/dead' },
      nickCred,
    );
    await post('/teams/dawn/availability', { status: 'away' }, nickCred);
    stubSlack(() => {
      throw new Error('ECONNREFUSED');
    });

    const sent = await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'ask',
          { species: 'consult', tier: 'advisory' },
          'ask-s2',
        ),
      },
      { key: team.json.agent_key, seat: 'Ada' },
    );
    expect(sent.status).toBe(201);

    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    await pollUntil(() => listAudit(server.db, teamId).some((r) => r.action === 'ask.surfaced'));
    const surfaced = listAudit(server.db, teamId).find((r) => r.action === 'ask.surfaced')!;
    expect(JSON.parse(surfaced.detail!)).toMatchObject({ surface: 'slack', ok: false });
  });

  it('fires no outbound call and writes no ask.surfaced row when the knob is unset (default off)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
    const calls = stubSlack(() => new Response('ok', { status: 200 }));

    await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'ask',
          { species: 'approve', tier: 'standard' },
          'ask-s3',
        ),
      },
      { key: team.json.agent_key, seat: 'Ada' },
    );

    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    // The raised row proves the ask routed; give the (nonexistent) dispatch a beat, then assert silence.
    expect(listAudit(server.db, teamId).some((r) => r.action === 'ask.raised')).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
    expect(listAudit(server.db, teamId).some((r) => r.action === 'ask.surfaced')).toBe(false);
  });

  // ── ADR 155 Increment 2: presence informs the ask clock, never the ceiling ──

  it('stays quiet at raise while an admin human is present — the loud surface waits for the re-notify', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
    await post(
      '/teams/dawn/policy',
      { ask_slack_webhook: 'https://hooks.slack.test/T/B/x' },
      nickCred,
    );
    // Make the admin PRESENT: an explicit presence row (the /presence ping) composes him working/idle.
    await post('/teams/dawn/presence', { surface: 'web' }, nickCred);
    const calls = stubSlack(() => new Response('ok', { status: 200 }));

    const sent = await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'ask',
          { species: 'escalate', tier: 'blocking' },
          'ask-p1',
        ),
      },
      { key: team.json.agent_key, seat: 'Ada' },
    );
    expect(sent.status).toBe(201);

    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    expect(listAudit(server.db, teamId).some((r) => r.action === 'ask.raised')).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
    expect(listAudit(server.db, teamId).some((r) => r.action === 'ask.surfaced')).toBe(false);

    // The agent's re-notify — an in-thread ask — always fires the loud surface, present admin or not:
    // the human's silence despite presence is exactly what earns the escalation.
    const renotify = await post(
      '/teams/dawn/messages',
      {
        envelope: {
          ...env(
            'Ada',
            { kind: 'team' },
            'ask',
            { species: 'escalate', tier: 'blocking' },
            'ask-p2',
          ),
          thread: 'ask-p1',
        },
      },
      { key: team.json.agent_key, seat: 'Ada' },
    );
    expect(renotify.status).toBe(201);
    await pollUntil(() => listAudit(server.db, teamId).some((r) => r.action === 'ask.surfaced'));
    expect(calls).toHaveLength(1);
  });

  it('the ADR 153 ceiling guard: presence never moves the tier contract — present and away yield byte-identical clocks', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickCred = team.json.human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
    await post(
      '/teams/dawn/policy',
      { ask_slack_webhook: 'https://hooks.slack.test/T/B/x' },
      nickCred,
    );
    stubSlack(() => new Response('ok', { status: 200 }));
    await post('/teams/dawn/presence', { surface: 'web' }, nickCred);

    // Present admin (fresh presence row just attached).
    const present = await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'ask',
          { species: 'escalate', tier: 'blocking' },
          'ask-g1',
        ),
      },
      { key: team.json.agent_key, seat: 'Ada' },
    );
    // Away admin: only escalation-eagerness may change, never the clock.
    await post('/teams/dawn/availability', { status: 'away' }, nickCred);
    const away = await post(
      '/teams/dawn/messages',
      {
        envelope: env(
          'Ada',
          { kind: 'team' },
          'ask',
          { species: 'escalate', tier: 'blocking' },
          'ask-g2',
        ),
      },
      { key: team.json.agent_key, seat: 'Ada' },
    );

    // Byte-for-byte the shipped ADR 147 default in both worlds — a hold whose window moved with
    // presence would be a defect (ADR 153 invariant, ADR 155 guard metric a).
    expect(present.json.ask_contract).toEqual({
      timeout_ms: 15 * 60_000,
      no_answer: 'hold',
      unblocker_reachable: true,
    });
    expect(away.json.ask_contract).toEqual(present.json.ask_contract);
  });
});
