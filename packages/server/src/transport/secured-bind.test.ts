import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type WSServerFrame } from '@musterd/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Tear down whatever a test started. */
let running: RunningServer | null = null;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) {
  savedEnv[k] = process.env[k];
  process.env[k] = v;
}
afterEach(async () => {
  if (running) await running.close();
  running = null;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A tiny WS test client (claim → occupied / refused). */
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
  claim(team: string, key: string, seat: string, surface = 'cli', grant?: string) {
    this.ws.send(
      JSON.stringify({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team,
        key,
        target: { seat },
        ...(grant ? { grant } : {}),
        surface,
      }),
    );
    return this.waitFor('occupied');
  }
  close() {
    this.ws.close();
  }
}

async function createTeam(base: string) {
  const res = await fetch(base + '/teams', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'dawn', creator: { name: 'nick', kind: 'human' } }),
  });
  return (await res.json()) as { agent_key: string; human_credential: string };
}

/** Mint a standing seat grant (admin-authed) so an agent claim occupies immediately. */
async function standingGrant(base: string, adminCred: string, seat: string): Promise<string> {
  const res = await fetch(base + '/teams/dawn/grants', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminCred}` },
    body: JSON.stringify({ scope: 'seat', target: seat, lifetime: 'standing' }),
  });
  return ((await res.json()) as { token: string }).token;
}

describe('secured off-loopback bind (ADR 040)', () => {
  it('refuses to construct a non-loopback plaintext daemon', () => {
    expect(() => createServer({ db: openDb(':memory:'), host: '10.0.0.1', port: 0 })).toThrow(
      /refusing to bind 10\.0\.0\.1 in plaintext/,
    );
  });

  it('allows a non-loopback bind when a TLS-terminating proxy is acknowledged', () => {
    // The guard runs at construction; trusting a proxy lets it through without actually exposing a port.
    const s = createServer({ db: openDb(':memory:'), host: '10.0.0.1', port: 0, trustProxy: true });
    running = s;
    expect(s.scheme).toBe('ws');
  });

  it.skipIf(!hasOpenssl)('serves wss:// with native TLS configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-tls-'));
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    );
    const s = createServer({
      db: openDb(':memory:'),
      host: '127.0.0.1',
      port: 0,
      tlsCert: certPath,
      tlsKey: keyPath,
    });
    running = s;
    expect(s.scheme).toBe('wss');
    const { port } = await s.listen();
    // Connect over wss, accepting the self-signed cert.
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', rej);
    });
    ws.close();
  });
});

describe('WS upgrade Origin/Host gate (ADR 040)', () => {
  it('rejects an upgrade carrying a browser Origin (cross-site / DNS-rebinding)', async () => {
    const s = createServer({ db: openDb(':memory:'), port: 0 });
    running = s;
    const { port } = await s.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example' });
    const err = await new Promise<Error>((res) => ws.on('error', res));
    expect(String(err)).toMatch(/403/);
  });

  it('admits the no-Origin CLI/MCP client on a loopback Host', async () => {
    const s = createServer({ db: openDb(':memory:'), port: 0 });
    running = s;
    const { port } = await s.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', rej);
    });
    ws.close();
  });

  it('admits a same-origin browser Origin — the daemon-served page (ADR 062)', async () => {
    const s = createServer({ db: openDb(':memory:'), port: 0 });
    running = s;
    const { port } = await s.listen();
    // Origin host:port == the Host header the browser connected to → same-origin, allowed.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', rej);
    });
    ws.close();
  });
});

describe('newest-wins self-heal at WAN-tuned timeouts (ADR 017 / 040 §6)', () => {
  it('reclaims a seat after a high-latency reconnect, and a newer session still displaces', async () => {
    // WAN tuning: widen presence timeout + reclaim grace well past any test-introduced latency.
    setEnv('MUSTERD_PRESENCE_TIMEOUT_MS', '120000');
    setEnv('MUSTERD_RECLAIM_GRACE_MS', '120000');
    const s = createServer({ db: openDb(':memory:'), port: 0 });
    running = s;
    const { port } = await s.listen();
    const base = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const { agent_key, human_credential } = await createTeam(base);
    await fetch(base + '/teams/dawn/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${human_credential}` },
      body: JSON.stringify({ name: 'Ada', kind: 'agent' }),
    });
    const grant = await standingGrant(base, human_credential, 'Ada');

    // Ada attaches, then drops (a flaky WAN link). The claims carry no workspace → displace-all
    // newest-wins (ADR 017), so the self-heal path is exercised without same-workspace flap-scoping.
    const a1 = new TestWs(wsUrl);
    await a1.open();
    await a1.claim('dawn', agent_key, 'Ada', 'claude-code', grant);
    a1.close();

    // Simulate WAN latency before the same identity reconnects; well within the widened grace.
    await new Promise((r) => setTimeout(r, 250));

    // The same Ada reclaims her held seat — occupied, not a busy refusal.
    const a2 = new TestWs(wsUrl);
    await a2.open();
    const occupied = await a2.claim('dawn', agent_key, 'Ada', 'cli', grant);
    expect(occupied.type).toBe('occupied');

    // A newer concurrent session still wins (the intended self-heal), displacing a2.
    const a3 = new TestWs(wsUrl);
    await a3.open();
    const occupied3 = await a3.claim('dawn', agent_key, 'Ada', 'cli', grant);
    expect(occupied3.type).toBe('occupied');
    const superseded = await a2.waitFor('error');
    expect((superseded as { code?: string }).code).toBe('superseded');

    a3.close();
  });
});
