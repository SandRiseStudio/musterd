import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';

/**
 * Shutdown must complete while agents are connected (incident 2026-07-27).
 *
 * The daemon received SIGTERM, logged "shutting down", released its listening port — and then never
 * exited, because every live agent's WebSocket held it open. A still-alive process means launchd's
 * KeepAlive never fires, so nothing restarts it: the whole team's coordination layer stayed down
 * until a human noticed. Worse, every sanctioned bounce path (`service restart`, `service refresh`,
 * the 2-minute auto-refresh LaunchAgent) sends SIGTERM, so the mechanism meant to keep the daemon
 * current was the one able to wedge it — and the more seats were working, the likelier that got.
 *
 * The cause was one discarded value: `attachWsServer(ctx, http)`'s returned `WebSocketServer` was
 * thrown away, so `close()` had no handle and never terminated the upgraded sockets. They are
 * invisible to `http.closeAllConnections()` — `ws` runs in `noServer` mode behind an `upgrade`
 * listener, and Node detaches an upgraded socket from the HTTP server's connection tracking.
 *
 * These tests fail against that bug by HANGING rather than asserting false, which is why each carries
 * an explicit timeout: a hang is the actual production symptom.
 */
let server: RunningServer | null = null;

afterEach(() => {
  server = null;
});

/** Open a real client WS to the running server and resolve once it is established. */
async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

describe('RunningServer.close() with live WebSocket clients', () => {
  it('resolves promptly while a client is connected (the daemon must always be able to exit)', async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    const ws = await connect(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Before the fix this never settles — exactly how the daemon hung in production.
    await server.close();

    ws.terminate();
  }, 5_000);

  it('disconnects the client rather than leaving an orphaned socket', async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    const ws = await connect(port);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));

    await server.close();
    await closed; // the socket must die with the server, not outlive it

    expect(ws.readyState).toBe(WebSocket.CLOSED);
  }, 5_000);

  it('still resolves with several clients connected (a full team, not one seat)', async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    const clients = await Promise.all([connect(port), connect(port), connect(port)]);

    await server.close();

    for (const ws of clients) ws.terminate();
  }, 5_000);

  it('is idempotent — a second signal must not throw or hang', async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    const ws = await connect(port);

    // Production saw TWO "shutting down (SIGTERM)" lines: the second signal arrived while the
    // first close was still pending, so close() must tolerate being called again.
    await Promise.all([server.close(), server.close()]);

    ws.terminate();
  }, 5_000);
});
