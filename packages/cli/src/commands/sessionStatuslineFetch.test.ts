import { SEAT_CHIP } from '@musterd/protocol';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitSessionStatusline } from './session.js';

/**
 * The fetcher↔server contract, exercised against a stub daemon.
 *
 * These exist because of a specific miss (ryder's #1076 re-check): the truncation marker was wired
 * to `inboxRes.truncated`, which the server emits ONLY for a caller naming no limit — so the marker
 * was dead on the live path. The emit-layer test passed anyway, because it injects
 * `waitingTruncated` at the fetcher boundary and therefore pins the renderer, not the claim. A
 * green test asserting behaviour the code cannot produce is worse than the missing behaviour: it
 * retires the question. So the wiring gets its own tests, and they talk to a real socket.
 */
describe('defaultStatuslineFetcher against a stub daemon', () => {
  let server: Server;
  let dir: string;
  let seen: { path: string; query: string; noTouch: string | undefined }[];
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
    seen = [];
    inboxBody = { messages: [], cursor: { last_read_ts: 0 } };
    server = createServer((req, res) => {
      const [path, query = ''] = (req.url ?? '').split('?');
      seen.push({
        path: path ?? '',
        query,
        noTouch: req.headers['x-musterd-no-touch'] as string | undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(path?.endsWith('/inbox') ? inboxBody : brief()));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    dir = mkdtempSync(join(tmpdir(), 'musterd-chip-'));
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

  it('renders a quiet seat and asks for exactly two presence-neutral reads', async () => {
    expect(await emitSessionStatusline(dir)).toBe(`${SEAT_CHIP} dolly · revive · lane: none`);
    // Two, not three: the orientation's memory-envelope call is dropped (the chip has no headline).
    expect(seen.map((s) => s.path)).toEqual(['/teams/revive/inbox', '/teams/revive/next']);
    // The required fix from the first review — a redraw must never fake liveness (ADR 057/241).
    expect(seen.every((s) => s.noTouch === '1')).toBe(true);
    expect(seen[0]?.query).toContain('limit=');
  });

  it('admits the undercount when the daemon says rows were cut past this page', async () => {
    // THE regression test. `unread_remaining` is the limit-naming caller's signal; `truncated` is
    // the no-limit caller's and is never sent here. Wiring the wrong one made `n+` unreachable.
    inboxBody = {
      messages: [
        {
          id: '01M0X4012RJ3C84QJN9GBKAH2T',
          from: 'stanley',
          to: 'dolly',
          act: 'ask',
          body: 'x',
          ts: Date.now(),
        },
      ],
      cursor: { last_read_ts: 0 },
      unread_remaining: 258,
    };
    expect(await emitSessionStatusline(dir)).toContain('⚑1+ waiting');
  });

  it('renders a bare count when nothing was cut', async () => {
    inboxBody = {
      messages: [
        {
          id: '01M0X4012RJ3C84QJN9GBKAH2T',
          from: 'stanley',
          to: 'dolly',
          act: 'ask',
          body: 'x',
          ts: Date.now(),
        },
      ],
      cursor: { last_read_ts: 0 },
    };
    const out = await emitSessionStatusline(dir);
    expect(out).toContain('⚑1 waiting');
    expect(out).not.toContain('+');
  });

  it('is silent, not loud, when the folder carries no binding', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'musterd-bare-'));
    try {
      expect(await emitSessionStatusline(bare)).toBeNull();
      expect(seen).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
