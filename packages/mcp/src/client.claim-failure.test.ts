import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { MusterdClient } from './client.js';

/*
 * A claim that fails server-side must reject, promptly, with the real cause.
 *
 * Found 2026-08-12 during the ADR 251 live wake: a presence INSERT threw inside the server's claim
 * handler, which sent `{type:'error', code:'server_error', message:'CHECK constraint failed…'}` —
 * the exact diagnosis. The client dropped it on the floor, because its only `error` branch matched
 * `code === 'superseded'`. `join()` then sat on an open socket until its 60s timer and reported
 * "timed out waiting for admin approval" — an approval nobody had requested and no request row
 * existed for. That wording sent diagnosis down the wrong path twice, and a one-line constraint
 * cost four rounds.
 *
 * The rule these tests pin: EVERY terminal server frame settles the join, and no message may assert
 * a cause the client has no evidence for.
 */

let wss: WebSocketServer | null = null;

afterEach(() => {
  wss?.close();
  wss = null;
});

/** Stand up a WS server that answers the first claim frame with `reply`, then hand back a client. */
async function serverAnswering(
  reply: unknown | null,
): Promise<{ client: MusterdClient; port: number }> {
  const server = new WebSocketServer({ port: 0 });
  wss = server;
  await new Promise<void>((r) => server.on('listening', () => r()));
  server.on('connection', (ws) => {
    ws.on('message', () => {
      if (reply !== null) ws.send(JSON.stringify(reply));
      // Deliberately NOT closing: the production server left the socket open too, which is what
      // turned a dropped frame into a hang rather than a fast failure.
    });
  });
  const { port } = server.address() as { port: number };
  const client = new MusterdClient({
    server: `http://127.0.0.1:${port}`,
    team: 'dawn',
    agent_key: 'mskey_team',
    surface: 'musterd',
    provenance: 'session',
    workspace: '/tmp/ws',
    claim: { mode: 'seat', name: 'Ada' },
  } as never);
  return { client, port };
}

describe('a claim that fails server-side rejects instead of hanging', () => {
  it('rejects with the server error frame, not after the timeout', async () => {
    const { client } = await serverAnswering({
      type: 'error',
      code: 'server_error',
      message: 'CHECK constraint failed: surface',
    });
    // A generous timeout that must NOT be what ends this call: if the frame is handled, the
    // rejection lands in milliseconds. Before the fix this test takes the full 3s and reports
    // an approval that was never requested.
    const started = Date.now();
    await expect(client.join(3000)).rejects.toThrow(/CHECK constraint failed/);
    expect(Date.now() - started).toBeLessThan(1000);
    client.close();
  });

  it('names the real cause — never an approval nobody asked for', async () => {
    const { client } = await serverAnswering({
      type: 'error',
      code: 'server_error',
      message: 'CHECK constraint failed: surface',
    });
    await expect(client.join(3000)).rejects.not.toThrow(/approval/);
    client.close();
  });

  it('an unexplained timeout says it is unexplained, and does not invent an approval', async () => {
    // The server says NOTHING at all — the one case where the timeout fallback is the only story
    // the client has. It must not fill that silence with an approval it never requested.
    const { client } = await serverAnswering(null);
    await expect(client.join(300)).rejects.toThrow(/no answer|unexplained/i);
    await expect(client.join(300)).rejects.not.toThrow(/approval/);
    client.close();
  });
});
