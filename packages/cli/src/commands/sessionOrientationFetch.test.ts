import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitSessionOrientation } from './session.js';

/**
 * The orientation fetcher↔server contract, exercised against a stub daemon.
 *
 * Every other orientation test injects a `SessionOrientationInput` at the fetcher boundary, which
 * pins the composer and says nothing about whether `defaultOrientationFetcher` can produce what it
 * is handed. That is the exact shape of the miss ryder found on #1076 — a green test naming a claim
 * the live path could not make — and it recurred here: the `discharged` wiring was reverted on this
 * fetcher and all 2051 CLI tests stayed green. So the wiring gets a test that talks to a socket.
 */
describe('defaultOrientationFetcher against a stub daemon', () => {
  let server: Server;
  let dir: string;
  let inboxBody: Record<string, unknown>;

  const brief = (): Record<string, unknown> => ({
    member: 'dolly',
    in_flight: [],
    shipped: [],
    up_next: [],
    owed_reviews: [],
    incidents: [],
    why: null,
    next_goal: null,
    goals: [],
    review_debt: [],
  });

  beforeEach(async () => {
    inboxBody = { messages: [], cursor: { last_read_ts: 0 } };
    server = createServer((req, res) => {
      const [path = ''] = (req.url ?? '').split('?');
      if (path.endsWith('/memory')) {
        // An absent memory envelope is a normal state, and the fetcher catches it.
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(path.endsWith('/inbox') ? inboxBody : brief()));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    dir = mkdtempSync(join(tmpdir(), 'musterd-orient-'));
    mkdirSync(join(dir, '.musterd'));
    writeFileSync(
      join(dir, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: `http://127.0.0.1:${String(port)}`,
        team: 'revive',
        claim: { mode: 'seat', name: 'dolly' },
        agent_key: 'k_test',
        grant: 'g_test',
      }),
    );
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts a directed act the daemon reports as still owed', async () => {
    inboxBody = {
      messages: [
        {
          id: '01M0X4012RJ3C84QJN9GBKAH2T',
          from: 'stanley',
          to: 'dolly',
          act: 'ask',
          body: 'still mine',
          ts: Date.now(),
        },
      ],
      cursor: { last_read_ts: 0 },
    };
    expect(await emitSessionOrientation(dir)).toContain('1 directed act');
  });

  it('does not count an eligible-set act another seat already discharged', async () => {
    // ADR 254. `discharged` is server-computed and underivable here — the accept that took the act
    // is a DM to the asker, so this seat never sees it. The only way this passes is the fetcher
    // reading the field off the wire. Falsifier: drop `dischargedIds(inboxRes)` from the
    // orientation call in session.ts and ONLY this goes red.
    inboxBody = {
      messages: [
        {
          id: '01M0Y6WZ175QN2868880VBN65P',
          from: 'miley',
          to: '@team',
          act: 'request_help',
          body: 'review #1079',
          ts: Date.now(),
        },
        {
          id: '01M0X4012RJ3C84QJN9GBKAH2T',
          from: 'stanley',
          to: 'dolly',
          act: 'ask',
          body: 'still mine',
          ts: Date.now(),
        },
      ],
      cursor: { last_read_ts: 0 },
      discharged: [{ id: '01M0Y6WZ175QN2868880VBN65P', by: 'ryder' }],
    };
    // Two owed-looking acts on the wire, one of them already taken: the block must render and say
    // ONE. Asserting only "not 2" would pass on a fetcher that dropped both.
    const out = await emitSessionOrientation(dir);
    expect(out).toContain('1 directed act');
    expect(out).toContain('stanley');
    expect(out).not.toContain('miley');
  });

  it('is silent, not loud, when the folder carries no binding', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'musterd-bare-orient-'));
    try {
      expect(await emitSessionOrientation(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
