import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig } from '../config.js';
import { inboxCommand } from './inbox.js';
import { teamCommand } from './team.js';

/**
 * Drives `musterd inbox` against an in-process server. The load-bearing case is the bounded-unread
 * invariant (ADR: elite inbox): a bounded default view must show EVERY unread and advance the read
 * cursor only past what it showed — never silently mark an unshown unread as read.
 */
describe('inbox command', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;
  let ada: HttpClient; // sends as the agent seat Ada (team agent key + seat header)
  let nick: HttpClient; // nick's own credential — for advancing nick's read cursor
  const base = Date.UTC(2026, 6, 7, 12, 0);

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-inbox-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
    const cfg = loadConfig();
    const nickKey = cfg.identities['dawn']!.key;
    const admin = new HttpClient({ server: serverUrl, key: nickKey });
    await admin.addMember('dawn', { name: 'Ada', kind: 'agent' });
    ada = new HttpClient({ server: serverUrl, key: cfg.agentKeys['dawn']!, seat: 'Ada' });
    nick = new HttpClient({ server: serverUrl, key: nickKey, seat: 'nick' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  /** Ada broadcasts `n` messages to @team (visible to nick), one per minute, oldest first. */
  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await ada.send(
        'dawn',
        makeEnvelope({
          id: ulid(),
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'message',
          body: `msg ${i}`,
          ts: base + i * 60_000,
          thread: null,
          meta: null,
        }),
      );
    }
  }

  /** How many unread nick currently has (via the JSON --unread view — a peek, never advances). */
  async function unreadCount(): Promise<number> {
    const r = await capture(() => inboxCommand(parseArgs(['--unread', '--peek', '--json'])));
    return (JSON.parse(r.out) as unknown[]).length;
  }

  it('bounds the default view to the recent window and reports "of total"', async () => {
    await seed(20);
    // Read everything first so the window shows READ context (isolating the bound from the unread rule).
    await capture(() => inboxCommand(parseArgs([])));
    await seed(0);
    const res = await capture(() => inboxCommand(parseArgs([])));
    const shownBodies = (res.out.match(/msg \d+/g) ?? []).length;
    expect(shownBodies).toBe(15); // default window
    expect(res.out).toContain('15 of 20');
    expect(res.out).toContain('--limit 0 for all history');
  });

  it('INVARIANT: a bounded view shows every unread and marks exactly them read', async () => {
    await seed(20); // all 20 unread, window default 15 < 20
    const res = await capture(() => inboxCommand(parseArgs([])));
    // All 20 unread are shown despite the window of 15 — none is hidden then silently consumed.
    expect((res.out.match(/msg \d+/g) ?? []).length).toBe(20);
    expect(res.out).toContain('20 unread');
    // And now they are all read — the cursor advanced past exactly what was displayed.
    expect(await unreadCount()).toBe(0);
  });

  it('shows recent read context + all unread when unread < window', async () => {
    await seed(20);
    // Mark the first 18 read, leaving 2 unread.
    const all = await capture(() => inboxCommand(parseArgs(['--limit', '0', '--peek', '--json'])));
    const msgs = JSON.parse(all.out) as Array<{ id: string; ts: number }>;
    // Advance nick's read cursor to the 18th message (leaves the last 2 unread).
    await nick.markRead('dawn', msgs[17]!.id);
    expect(await unreadCount()).toBe(2);

    const res = await capture(() => inboxCommand(parseArgs([])));
    expect((res.out.match(/msg \d+/g) ?? []).length).toBe(15); // recent window
    expect(res.out).toContain('2 unread');
    expect(await unreadCount()).toBe(0); // the 2 unread were consumed
  });

  it('--limit 0 shows the full history', async () => {
    await seed(20);
    const res = await capture(() => inboxCommand(parseArgs(['--limit', '0', '--peek'])));
    expect((res.out.match(/msg \d+/g) ?? []).length).toBe(20);
  });

  it('--peek never advances the read cursor', async () => {
    await seed(5);
    await capture(() => inboxCommand(parseArgs(['--peek'])));
    expect(await unreadCount()).toBe(5); // still all unread
  });

  it('groups the rendered messages under a day header', async () => {
    await seed(3);
    const res = await capture(() => inboxCommand(parseArgs(['--peek'])));
    // base is 2026-07-07; relative to render "now" it lands on a dated header, not a bare time.
    expect(res.out).toMatch(/Today|Yesterday|Jul 7|7\/7\//);
  });

  it('rejects a negative --limit', async () => {
    await expect(inboxCommand(parseArgs(['--limit', '-3']))).resolves.toBe(2);
  });
});
