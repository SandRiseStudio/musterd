import { PROTOCOL_VERSION, type WSServerFrame } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';

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

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function get(path: string, token?: string, extraHeaders?: Record<string, string>) {
  const res = await fetch(base + path, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders ?? {}),
    },
  });
  return { status: res.status, json: (await res.json()) as any };
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
  hello(team: string, as: string, token: string, surface = 'cli') {
    this.send({ type: 'hello', v: PROTOCOL_VERSION, team, as, token, surface });
    return this.waitFor('welcome');
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
    const dup = await post('/teams', { slug: 'dawn', creator: { name: 'x', kind: 'human' } });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('conflict');
  });

  it('sends and reads an inbox over HTTP with unread accounting', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.token;
    const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
    const boTok = bo.json.token;

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

  it('rejects an invalid act with 422 validation', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, team.json.token);
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
      team.json.token,
    );
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe('validation');
  });

  it('ambient presence: a one-shot authenticated command flips the agent present (ADR 057)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    const adaTok = ada.json.token;

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
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // A read carrying the no-touch header (a background poller, e.g. notify) must NOT flip Ada present.
    await get('/teams/dawn/inbox', ada.json.token, { 'x-musterd-no-touch': '1' });
    const after = await get('/teams/dawn/members', nickTok);
    expect(after.json.members.find((m: any) => m.name === 'Ada')?.activity).toBe('offline');
  });

  it('ambient presence: a status_update reads working, and the surface header is honored (ADR 057)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    const adaTok = ada.json.token;

    const res = await fetch(base + '/teams/dawn/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adaTok}`,
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
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    const adaTok = ada.json.token;

    // nick watches the team roster live.
    const watcher = new TestWs();
    await watcher.open();
    await watcher.hello('dawn', 'nick', nickTok);
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

describe('WebSocket', () => {
  it('/health connections reflects a live session (ADR 047)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.token);
    expect((await get('/health')).json.connections).toBe(0);

    const a = new TestWs();
    await a.open();
    await a.hello('dawn', 'Ada', ada.json.token, 'claude-code');
    expect((await get('/health')).json.connections).toBe(1);
    a.close();
  });

  it('delivers live to a present recipient and acks the sender', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.token);
    const lin = await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, team.json.token);

    const a = new TestWs();
    const l = new TestWs();
    await Promise.all([a.open(), l.open()]);
    await a.hello('dawn', 'Ada', ada.json.token, 'claude-code');
    await l.hello('dawn', 'Lin', lin.json.token, 'codex');

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
    const tok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    const lin = await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
    const obs = await post('/teams/dawn/members', { name: 'Obs', kind: 'agent' }, tok);

    const a = new TestWs();
    const l = new TestWs();
    const o = new TestWs();
    await Promise.all([a.open(), l.open(), o.open()]);
    await a.hello('dawn', 'Ada', ada.json.token, 'claude-code');
    await l.hello('dawn', 'Lin', lin.json.token, 'codex');
    await o.hello('dawn', 'Obs', obs.json.token, 'web');

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
    const tok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    const lin = await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);

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
      ada.json.token,
    );
    await post(
      '/teams/dawn/messages',
      { envelope: mk('t2', 'Lin', { kind: 'team' }, 'all', 2000) },
      lin.json.token,
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

  it('a message to an offline member surfaces via inbox', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // nick present, Ada offline.
    const n = new TestWs();
    await n.open();
    await n.hello('dawn', 'nick', nickTok, 'cli');
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

    const inbox = await get('/teams/dawn/inbox?unread=1', ada.json.token);
    expect(inbox.json.messages).toHaveLength(1);
    expect(inbox.json.messages[0].act).toBe('request_help');
    n.close();
  });

  it('roster activity reflects working from a status_update, online when present, offline otherwise', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickTok); // never connects → offline

    // nick present but idle; Ada present and working.
    const n = new TestWs();
    const a = new TestWs();
    await Promise.all([n.open(), a.open()]);
    await n.hello('dawn', 'nick', nickTok, 'cli');
    await a.hello('dawn', 'Ada', ada.json.token, 'claude-code');

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
    const nickTok = team.json.token;
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

  it('records provenance + workspace from the hello and surfaces them on the roster (ADR 014)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const a = new TestWs();
    await a.open();
    a.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      as: 'Ada',
      token: ada.json.token,
      surface: 'claude-code',
      provenance: 'session',
      workspace: 'movetrail@feat/login',
    });
    await a.waitFor('welcome');

    const roster = await get('/teams/dawn/members', nickTok);
    const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
    expect(adaRow.presences[0].provenance).toBe('session');
    expect(adaRow.presences[0].workspace).toBe('movetrail@feat/login');

    a.close();
  });

  it('records the driver from the hello and surfaces it on the roster (ADR 021)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const a = new TestWs();
    await a.open();
    a.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      as: 'Ada',
      token: ada.json.token,
      surface: 'claude-code',
      provenance: 'session',
      driver: 'nick',
    });
    await a.waitFor('welcome');

    const roster = await get('/teams/dawn/members', nickTok);
    const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
    expect(adaRow.presences[0].driver).toBe('nick');

    a.close();
  });

  it('a second live session for the same member takes over; the first is superseded (ADR 017)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.token);

    const a1 = new TestWs();
    await a1.open();
    await a1.hello('dawn', 'Ada', ada.json.token, 'claude-code');

    // The newer session wins: it gets `welcome`, and the older one is told it was superseded.
    const a2 = new TestWs();
    await a2.open();
    const welcome = await a2.hello('dawn', 'Ada', ada.json.token, 'cli');
    expect(welcome.type).toBe('welcome');

    const superseded = await a1.waitFor('error');
    expect((superseded as any).code).toBe('superseded');

    // Exactly one live presence remains — the new one (single-active still holds).
    const roster = await get('/teams/dawn/members', team.json.token);
    const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
    expect(adaRow.presences).toHaveLength(1);
    expect(adaRow.presences[0].surface).toBe('cli');

    a1.close();
    a2.close();
  });

  it('a human seat fans out: two concurrent sessions both stay live, neither superseded (ADR 042)', async () => {
    // The team creator (nick) is a human seat.
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.token;

    const phone = new TestWs();
    const laptop = new TestWs();
    await Promise.all([phone.open(), laptop.open()]);
    const w1 = await phone.hello('dawn', 'nick', nickTok, 'cli');
    const w2 = await laptop.hello('dawn', 'nick', nickTok, 'claude-code');
    expect(w1.type).toBe('welcome');
    expect(w2.type).toBe('welcome');

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
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // nick holds two live sessions; Ada is the sender.
    const phone = new TestWs();
    const laptop = new TestWs();
    const a = new TestWs();
    await Promise.all([phone.open(), laptop.open(), a.open()]);
    await phone.hello('dawn', 'nick', nickTok, 'cli');
    await laptop.hello('dawn', 'nick', nickTok, 'claude-code');
    await a.hello('dawn', 'Ada', ada.json.token, 'claude-code');

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
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const a = new TestWs();
    await a.open();
    await a.hello('dawn', 'Ada', ada.json.token, 'claude-code');

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
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const a = new TestWs();
    await a.open();
    await a.hello('dawn', 'Ada', ada.json.token, 'claude-code');

    // Ada unbinds herself with her *own* token (self-only — no target name).
    const r = await post('/teams/dawn/unbind', {}, ada.json.token);
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
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    const a = new TestWs();
    await a.open();
    await a.hello('dawn', 'Ada', ada.json.token, 'claude-code');

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
    const nickTok = team.json.token;
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

    // nick stays present so we can observe Ada's offline event after she drops.
    const n = new TestWs();
    await n.open();
    await n.hello('dawn', 'nick', nickTok, 'cli');

    const a1 = new TestWs();
    await a1.open();
    await a1.hello('dawn', 'Ada', ada.json.token, 'claude-code');
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
    const welcome = await a2.hello('dawn', 'Ada', ada.json.token, 'cli');
    expect(welcome.type).toBe('welcome');

    n.close();
    a2.close();
  });

  it('rejects a hello whose name does not match the token', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.token);
    const w = new TestWs();
    await w.open();
    w.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      as: 'Lin',
      token: ada.json.token,
      surface: 'cli',
    });
    const err = await w.waitFor('error');
    expect((err as any).code).toBe('forbidden');
    w.close();
  });
});
