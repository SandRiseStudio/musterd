import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERALIST_CAPABILITIES, PROTOCOL_VERSION, type WSServerFrame } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  claim(team: string, key: string, seat: string, surface = 'cli', grant?: string) {
    this.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team,
      key,
      target: { seat },
      ...(grant ? { grant } : {}),
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
    expect(r.json.policy).toEqual({ allow_pre_issued_grants: false });
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
    expect(adaRow?.activity).toBe('online'); // present, but no status_update → not "working"
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

  it('firehose (subscribe team-all): an observer sees a directed DM between two other members (ADR 061)', async () => {
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

    // Lin is the recipient AND a firehose subscriber (tests dedup); Obs is a pure observer.
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

    // The observer — not addressed — still receives the directed envelope.
    const obsDeliver = await o.waitFor('deliver');
    expect((obsDeliver as any).envelope.body).toBe('firehose ping');
    expect((obsDeliver as any).envelope.to).toEqual({ kind: 'member', name: 'Lin' });

    // The recipient gets it exactly once, despite also being on the firehose (dedup via skip set).
    await l.waitFor('deliver');
    await new Promise((r) => setTimeout(r, 40));
    expect(l.countFrames('deliver')).toBe(1);

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

    // nick — party to neither — sees BOTH via the team timeline (firehose history backfill).
    const all = await get('/teams/dawn/messages', tok);
    expect(all.json.messages.map((m: any) => m.id)).toEqual(['t1', 't2']);

    // `since` pages forward (exclusive); `limit` caps.
    const since = await get('/teams/dawn/messages?since=1000', tok);
    expect(since.json.messages.map((m: any) => m.id)).toEqual(['t2']);
    const limited = await get('/teams/dawn/messages?limit=1', tok);
    expect(limited.json.messages).toHaveLength(1);
    expect(limited.json.messages[0].id).toBe('t1');
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

    // It still receives a directed DM between two others via the firehose.
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

  it('roster activity reflects working from a status_update, online when present, offline otherwise', async () => {
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
    expect(by('nick').activity).toBe('online');
    expect(by('nick').state).toBeNull();
    expect(by('Lin').activity).toBe('offline');

    n.close();
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

  it('steer act (ADR 102): persists through the DB and raises the interrupt line without an urgent flag', async () => {
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
    expect(laneMsgs[0].meta.lane_warning ?? laneMsgs[0].meta.lane_handoff).toBeTruthy();
    expect(laneMsgs[2].meta.lane_open).toBeTruthy();

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
