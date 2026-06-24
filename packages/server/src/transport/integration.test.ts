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

async function get(path: string, token?: string) {
  const res = await fetch(base + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
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
  close() {
    this.ws.close();
  }
}

describe('HTTP API', () => {
  it('health responds with the protocol version, db path, and schema version', async () => {
    const r = await get('/health');
    expect(r.json).toMatchObject({ ok: true, v: PROTOCOL_VERSION });
    expect(typeof r.json.db).toBe('string');
    expect(typeof r.json.schema).toBe('number');
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
});

describe('WebSocket', () => {
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
