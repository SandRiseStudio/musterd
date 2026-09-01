import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { MusterdClient } from './client.js';

/**
 * ADR 347: a `lease` frame renews the adapter's HTTP authority mid-session. Before this the lease
 * was set once from `occupied` and every HTTP tool died five minutes later (lane 01M1FC77F2).
 */
let wss: WebSocketServer | null = null;
let dir: string;

afterEach(() => {
  wss?.close();
  wss = null;
  rmSync(dir, { recursive: true, force: true });
});

const occupied = (session_lease: string) => ({
  type: 'occupied',
  seat: {
    id: 'm1',
    team: 'dawn',
    name: 'Ada',
    role: 'backend',
    kind: 'agent',
    roles: [],
    lifecycle: 'forever',
    created_at: 0,
    presence: 'online',
    presences: [],
  },
  presence_id: 'p1',
  server_time: Date.now(),
  seat_credential: 'msac_ada',
  session_lease,
  memory: null,
});

async function serverThatRenews(): Promise<{
  client: MusterdClient;
  sendLease: (l: string) => void;
}> {
  const server = new WebSocketServer({ port: 0 });
  wss = server;
  await new Promise<void>((r) => server.on('listening', () => r()));
  let sock: import('ws').WebSocket | undefined;
  server.on('connection', (ws) => {
    sock = ws;
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as { type: string };
      if (f.type === 'claim') ws.send(JSON.stringify(occupied('msls_first')));
    });
  });
  const { port } = server.address() as { port: number };
  dir = mkdtempSync(join(tmpdir(), 'musterd-mcp-lease-'));
  mkdirSync(join(dir, '.musterd'));
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      version: 2,
      server: `http://127.0.0.1:${port}`,
      team: 'dawn',
      agent_key: 'mskey_team',
      claim: { mode: 'seat', name: 'Ada' },
    }),
  );
  const client = new MusterdClient({
    server: `http://127.0.0.1:${port}`,
    team: 'dawn',
    agent_key: 'mskey_team',
    surface: 'musterd',
    provenance: 'session',
    workspace: 'agents@main',
    claim: { mode: 'seat', name: 'Ada' },
    bindingDir: dir,
  } as never);
  return {
    client,
    sendLease: (session_lease) =>
      sock!.send(
        JSON.stringify({ type: 'lease', session_lease, expires_at: Date.now() + 300_000 }),
      ),
  };
}

const binding = () =>
  JSON.parse(readFileSync(join(dir, '.musterd', 'binding.json'), 'utf8')) as {
    session_lease?: string;
    claim: { name: string };
  };

describe('the adapter adopts a renewed lease (ADR 347)', () => {
  it("presents the renewed lease on HTTP and writes it to this seat's binding", async () => {
    const { client, sendLease } = await serverThatRenews();
    await client.join(3000);

    sendLease('msls_renewed');
    await new Promise((r) => setTimeout(r, 100));
    expect(binding().session_lease).toBe('msls_renewed');
    expect((client as unknown as { config: { sessionLease?: string } }).config.sessionLease).toBe(
      'msls_renewed',
    );
    client.close();
  });

  it('never writes a lease into a binding that names another seat', async () => {
    const { client, sendLease } = await serverThatRenews();
    await client.join(3000);
    // The worktree was re-provisioned to another seat mid-session.
    const b = JSON.parse(readFileSync(join(dir, '.musterd', 'binding.json'), 'utf8'));
    b.claim = { mode: 'seat', name: 'Lin' };
    delete b.session_lease;
    writeFileSync(join(dir, '.musterd', 'binding.json'), JSON.stringify(b));

    sendLease('msls_renewed');
    await new Promise((r) => setTimeout(r, 100));
    expect(binding().claim.name).toBe('Lin');
    expect(binding().session_lease).toBeUndefined();
    expect((client as unknown as { config: { sessionLease?: string } }).config.sessionLease).toBe(
      'msls_renewed',
    );
    client.close();
  });
});
