import { PROTOCOL_VERSION, type WSServerFrame } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { clearPresenceById } from '../store/presence.js';

/**
 * A socket whose Presence row the reaper removed is a zombie: subscribed, receiving broadcasts,
 * heartbeating into `if (presenceById(...))` and dropped on the floor — and the session lease that
 * joined on that row is dead, so every `musterd inbox --interrupt-check` the seat's hook runs is
 * refused. Nothing told the adapter, so nothing reconnected. Measured 2026-09-14 (lane 01M2GBPX2S):
 * ghost's socket opened 2026-09-03, was reaped at 15:58:37Z inside one blocked reaper tick, and stayed
 * open and deaf — 33 `interrupt_probe_refused` rows — until it happened to drop at 16:17:28Z.
 *
 * The server owes the zombie a close: the adapter's reconnect re-claims, the `occupied` frame mints a
 * new Presence and lease, and #1369 writes that lease where the hook reads it.
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let nickCred: string;

class TestWs {
  ws: WebSocket;
  frames: WSServerFrame[] = [];
  closed: Promise<{ code: number; reason: string }>;
  private waiters: { type: string; resolve: (f: WSServerFrame) => void }[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as WSServerFrame;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => (w.type === f.type ? (w.resolve(f), false) : true));
    });
    this.closed = new Promise((resolve) => {
      this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }
  open() {
    return new Promise<void>((r, rej) => {
      this.ws.on('open', () => r());
      this.ws.on('error', rej);
    });
  }
  waitFor(type: string, ms = 1500): Promise<WSServerFrame> {
    const existing = this.frames.find((f) => f.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
      this.waiters.push({ type, resolve: (f) => (clearTimeout(t), resolve(f)) });
    });
  }
  send(frame: unknown) {
    this.ws.send(JSON.stringify(frame));
  }
  close() {
    this.ws.close();
  }
}

async function post(path: string, body: unknown, cred?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cred ? { authorization: `Bearer ${cred}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

async function claimAda(): Promise<TestWs> {
  const grant = await post(
    '/teams/dawn/grants',
    { scope: 'seat', target: 'Ada', lifetime: 'standing' },
    nickCred,
  );
  const ws = new TestWs(base.replace('http', 'ws') + '/ws');
  await ws.open();
  ws.send({
    type: 'claim',
    v: PROTOCOL_VERSION,
    team: 'dawn',
    key: agentKey,
    target: { seat: 'Ada' },
    grant: grant.json.token,
    surface: 'musterd',
    workspace: 'agents@main',
  });
  await ws.waitFor('occupied');
  return ws;
}

function adaPresenceId(): string {
  return server.db
    .prepare<
      [],
      { id: string }
    >(`SELECT p.id FROM presence p JOIN members m ON m.id = p.member_id WHERE m.name = 'Ada'`)
    .get()!.id;
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  agentKey = team.json.agent_key;
  nickCred = team.json.human_credential;
  await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
});
afterEach(async () => {
  await server.close();
});

describe('a reaped Presence closes its socket at the next heartbeat', () => {
  it('a heartbeat with no Presence row behind it gets the socket closed, so the adapter re-claims', async () => {
    const ws = await claimAda();

    // A live socket heartbeats and stays.
    ws.send({ type: 'heartbeat', status: 'online' });
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.ws.readyState).toBe(WebSocket.OPEN);

    // The reaper removed the row underneath it (the socket never dropped).
    clearPresenceById(server.db, adaPresenceId());

    ws.send({ type: 'heartbeat', status: 'online' });
    const { code, reason } = await Promise.race([
      ws.closed,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('socket stayed open after a reaped heartbeat')), 1500),
      ),
    ]);
    expect(code).toBe(4410);
    expect(reason).toMatch(/reaped/);
  });
});
