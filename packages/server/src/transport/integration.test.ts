import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type WSServerFrame } from '@musterd/protocol';
import { createServer, type RunningServer } from '../index.js';
import { openDb } from '../db/open.js';

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

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function get(path: string, token?: string) {
  const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
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
      this.waiters.push({ type, resolve: (f) => { clearTimeout(t); resolve(f); } });
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
  it('health responds with the protocol version', async () => {
    const r = await get('/health');
    expect(r.json).toEqual({ ok: true, v: PROTOCOL_VERSION });
  });

  it('creates a team + creator token; duplicate slug is 409', async () => {
    const r = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human', role: 'lead' } });
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
      id: 'mh1', v: PROTOCOL_VERSION, team: 'dawn', from: 'nick',
      to: { kind: 'member', name: 'bo' }, act: 'message', body: 'hi bo', ts: Date.now(),
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
    const bad = await post('/teams/dawn/messages', {
      envelope: { id: 'x', v: PROTOCOL_VERSION, team: 'dawn', from: 'nick', to: { kind: 'member', name: 'bo' }, act: 'yell', body: '', ts: 1 },
    }, team.json.token);
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
      envelope: { id: 'mw1', v: PROTOCOL_VERSION, team: 'dawn', from: 'Ada', to: { kind: 'member', name: 'Lin' }, act: 'handoff', body: 'ready', ts: Date.now() },
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
      envelope: { id: 'mw2', v: PROTOCOL_VERSION, team: 'dawn', from: 'nick', to: { kind: 'member', name: 'Ada' }, act: 'request_help', body: 'help', ts: Date.now() },
    });
    await n.waitFor('ack');

    const inbox = await get('/teams/dawn/inbox?unread=1', ada.json.token);
    expect(inbox.json.messages).toHaveLength(1);
    expect(inbox.json.messages[0].act).toBe('request_help');
    n.close();
  });

  it('rejects a hello whose name does not match the token', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const ada = await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.token);
    const w = new TestWs();
    await w.open();
    w.send({ type: 'hello', v: PROTOCOL_VERSION, team: 'dawn', as: 'Lin', token: ada.json.token, surface: 'cli' });
    const err = await w.waitFor('error');
    expect((err as any).code).toBe('forbidden');
    w.close();
  });
});
