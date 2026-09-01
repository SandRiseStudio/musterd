import { PROTOCOL_VERSION, type WSServerFrame } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import {
  AGENT_SESSION_LEASE_RENEW_AHEAD_MS,
  AGENT_SESSION_LEASE_TTL_MS,
  revokeMemberSessionLeases,
} from '../store/session-leases.js';

/**
 * ADR 347: an agent session lease is renewed over the live WS before it expires.
 *
 * Measured 2026-09-01 (lane 01M1FC77F2): the adapter's HTTP tools present the lease minted at claim
 * and nothing ever renewed it, so every adapter lost lane_open/team_send five minutes in, until a
 * reconnect happened to mint another. These pin the renewal: pushed inside the window, never
 * outside it, the old lease valid to its own expiry, and nothing on a human connection.
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let nickCred: string;

class TestWs {
  ws: WebSocket;
  frames: WSServerFrame[] = [];
  private waiters: { type: string; resolve: (f: WSServerFrame) => void }[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as WSServerFrame;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => (w.type === f.type ? (w.resolve(f), false) : true));
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

/** The daemon's own lease-gated route, hit under a given lease. */
async function attestUnder(key: string, lease: string): Promise<number> {
  const res = await fetch(base + '/teams/dawn/residency/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'x-musterd-seat': 'Ada',
      'x-musterd-session-lease': lease,
    },
    body: JSON.stringify({ seat: 'Ada', harness: 'claude-code', event: 'start' }),
  });
  return res.status;
}

async function claimAda(): Promise<{ ws: TestWs; lease: string; credential: string }> {
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
  const occupied = (await ws.waitFor('occupied')) as Extract<WSServerFrame, { type: 'occupied' }>;
  return { ws, lease: occupied.session_lease!, credential: occupied.seat_credential! };
}

function ageLease(msLeft: number) {
  server.db.prepare('UPDATE session_leases SET expires_at = ?').run(Date.now() + msLeft);
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

describe('agent session lease renewal over the live WS (ADR 347)', () => {
  it('pushes a fresh lease on the first heartbeat inside the renewal window, and the old one stays valid', async () => {
    const { ws, lease, credential } = await claimAda();
    expect(lease).toMatch(/^msls_/);

    // Far from expiry: a heartbeat renews nothing.
    ws.send({ type: 'heartbeat', status: 'online' });
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.frames.filter((f) => f.type === 'lease')).toHaveLength(0);

    // Inside the window: the next heartbeat carries a renewal.
    ageLease(AGENT_SESSION_LEASE_RENEW_AHEAD_MS - 1000);
    ws.send({ type: 'heartbeat', status: 'online' });
    const renewed = (await ws.waitFor('lease')) as Extract<WSServerFrame, { type: 'lease' }>;
    expect(renewed.session_lease).toMatch(/^msls_/);
    expect(renewed.session_lease).not.toBe(lease);
    expect(renewed.expires_at).toBeGreaterThan(Date.now() + AGENT_SESSION_LEASE_TTL_MS - 5000);

    // Both leases are accepted by a lease-gated route: the old one dies at its own expiry, not now.
    expect(await attestUnder(credential, renewed.session_lease)).toBe(200);
    expect(await attestUnder(credential, lease)).toBe(200);

    // Audited by id, never plaintext.
    const rows = server.db
      .prepare<
        [],
        { detail: string }
      >("SELECT detail FROM audit WHERE action = 'agent_session_lease.renewed'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).not.toContain(renewed.session_lease);
    expect(rows[0]!.detail).not.toContain(lease);

    // Once renewed, the following heartbeat is quiet again.
    ws.send({ type: 'heartbeat', status: 'online' });
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.frames.filter((f) => f.type === 'lease')).toHaveLength(1);
    ws.close();
  });

  it('the renewed lease outlives the one it replaced — the five-minute death is gone', async () => {
    const { ws, lease, credential } = await claimAda();
    ageLease(1000);
    ws.send({ type: 'heartbeat', status: 'online' });
    const renewed = (await ws.waitFor('lease')) as Extract<WSServerFrame, { type: 'lease' }>;
    // Expire the original by its own clock; the renewed one is what the adapter now presents.
    server.db
      .prepare('UPDATE session_leases SET expires_at = ? WHERE expires_at < ?')
      .run(Date.now() - 1, Date.now() + 2000);
    expect(await attestUnder(credential, lease)).toBe(401);
    expect(await attestUnder(credential, renewed.session_lease)).toBe(200);
    ws.close();
  });

  it('a revoked lease is never renewed — a heartbeat must not undo ADR 337 §3', async () => {
    // dolly's probe on #1154: with "revoked ⇒ due", rotating the credential revoked the lease and
    // the next heartbeat minted a live one. Revocation is a lifecycle verdict; only §4's
    // reconnection earns a fresh lease.
    const { ws, lease, credential } = await claimAda();
    const memberId = server.db
      .prepare<[string], { id: string }>('SELECT id FROM members WHERE name = ?')
      .get('Ada')!.id;
    expect(revokeMemberSessionLeases(server.db, memberId)).toHaveLength(1);
    ws.send({ type: 'heartbeat', status: 'online' });
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.frames.filter((f) => f.type === 'lease')).toHaveLength(0);
    expect(await attestUnder(credential, lease)).toBe(401);
    expect(
      server.db.prepare('SELECT COUNT(*) AS n FROM session_leases WHERE revoked_at IS NULL').get(),
    ).toEqual({ n: 0 });
    ws.close();
  });
});
