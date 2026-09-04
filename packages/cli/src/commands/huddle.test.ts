import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { CliError } from '../errors.js';
import { resolve } from './helpers.js';
import { huddleCommand, layoutRoom, mirrorTurn, parseTopic, parseUntil } from './huddle.js';
import { teamCommand } from './team.js';

/**
 * ADR 378 increment 1: a huddle is a thread. Every command here writes ordinary envelopes to a
 * real in-memory daemon; the whiteboard service is pointed at a dead port so the room layout is
 * the best-effort skip it is designed to be.
 */
describe('musterd huddle', () => {
  let server: RunningServer;
  let dir: string;
  const http = () => resolve({}).http;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-huddle-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['WHITEBOARD_PORT'] = '1'; // nothing listens: the room is skipped, never spawned
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
    delete process.env['WHITEBOARD_PORT'];
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

  async function open(extra: string[] = []): Promise<Record<string, unknown>> {
    const res = await capture(() =>
      huddleCommand(
        parseArgs([
          'open',
          '--topic',
          'lane:01LANE',
          '--anchor',
          'docs/design/thing.md',
          '--turns',
          '5',
          ...extra,
          'why',
          'we',
          'huddle',
          '--json',
        ]),
      ),
    );
    expect(res.code).toBe(0);
    return JSON.parse(res.out) as Record<string, unknown>;
  }

  it('open sends the root act with meta.huddle; the envelope id is the huddle id; the room is named after it', async () => {
    const root = await open();
    expect(root['act']).toBe('message');
    expect(root['thread']).toBeNull();
    expect(root['huddle_id']).toBe(root['id']);
    const id = String(root['id']);
    expect(root['room']).toBe(`http://127.0.0.1:1/b/huddle-${id.toLowerCase()}`);
    expect(root['room_laid_out']).toBe(false);
    expect(root['meta']).toMatchObject({
      huddle: {
        topic: { kind: 'lane', id: '01LANE' },
        anchor: 'docs/design/thing.md',
        room: root['room'],
        budget: { turns: 5 },
      },
    });
  });

  it('open with --to a,b carries the eligible set; --room overrides the derived URL', async () => {
    await capture(() => teamCommand(parseArgs(['add', 'lin', '--kind', 'agent', '--as', 'nick'])));
    await capture(() => teamCommand(parseArgs(['add', 'ada', '--kind', 'agent', '--as', 'nick'])));
    const root = await open(['--to', 'lin,ada', '--room', 'http://example.test/b/x']);
    expect(root['to']).toEqual({ kind: 'team' });
    expect(root['meta']).toMatchObject({
      eligible: ['lin', 'ada'],
      huddle: { room: 'http://example.test/b/x' },
    });
  });

  it('say is an ordinary act in the thread; close is a resolve naming anchor_ref; the thread reads back whole', async () => {
    const root = await open();
    const id = String(root['id']);

    const say = await capture(() =>
      huddleCommand(parseArgs(['say', id, '--act', 'challenge', 'why', 'five?', '--json'])),
    );
    expect(say.code).toBe(0);
    const turn = JSON.parse(say.out) as Record<string, unknown>;
    expect(turn['act']).toBe('challenge');
    expect(turn['thread']).toBe(id);
    expect(turn['meta']).not.toHaveProperty('huddle');

    const close = await capture(() =>
      huddleCommand(
        parseArgs(['close', id, '--anchor-ref', 'docs/design/thing.md@abc123', 'landed', '--json']),
      ),
    );
    expect(close.code).toBe(0);
    const res = JSON.parse(close.out) as Record<string, unknown>;
    expect(res['act']).toBe('resolve');
    expect(res['thread']).toBe(id);
    expect(res['meta']).toMatchObject({ anchor_ref: 'docs/design/thing.md@abc123' });

    // The whole-team timeline (ADR 061) holds the thread as three ordinary rows.
    const { messages } = await http().messages('dawn');
    const inThread = messages.filter((m) => m.id === id || m.thread === id).map((m) => m.act);
    expect(inThread.sort()).toEqual(['challenge', 'message', 'resolve']);
  });

  it('refuses a turn act that is not a turn, a missing anchor, and a bad topic', async () => {
    await expect(
      huddleCommand(parseArgs(['open', '--topic', 'lane:01LANE', 'no', 'anchor'])),
    ).rejects.toThrow(/--anchor is required/);
    await expect(
      huddleCommand(parseArgs(['say', '01X', '--act', 'accept', 'nope'])),
    ).rejects.toThrow(/--act must be one of/);
    await expect(huddleCommand(parseArgs(['close', '01X', 'no', 'ref']))).rejects.toThrow(
      /--anchor-ref is required/,
    );
    expect(() => parseTopic('sprint:1')).toThrow(CliError);
    expect(() => parseTopic('lane')).toThrow(CliError);
    expect(parseTopic('design:asks-rail')).toEqual({ kind: 'design', id: 'asks-rail' });
    expect(parseUntil('1733760000000')).toBe(1733760000000);
    expect(parseUntil('2026-09-03T12:00:00Z')).toBe(Date.parse('2026-09-03T12:00:00Z'));
    expect(() => parseUntil('soon')).toThrow(CliError);
  });

  describe('room layout over the whiteboard HTTP port', () => {
    let stub: Server;
    let calls: { path: string; body: unknown }[];

    beforeEach(async () => {
      calls = [];
      stub = createHttpServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const path = req.url ?? '';
          calls.push({ path, body: raw ? JSON.parse(raw) : null });
          res.setHeader('Content-Type', 'application/json');
          if (path === '/healthz')
            return res.end(JSON.stringify({ status: 'ok', service: 'agent-whiteboard' }));
          if (path.endsWith('/open')) return res.end(JSON.stringify({ created: true, url: 'x' }));
          if (path.endsWith('/add')) return res.end(JSON.stringify({ ids: ['a'], version: 1 }));
          res.statusCode = 404;
          res.end('{}');
        });
      });
      await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
      const addr = stub.address();
      process.env['WHITEBOARD_PORT'] = String(typeof addr === 'object' && addr ? addr.port : 0);
    });

    afterEach(async () => {
      await new Promise<void>((r) => stub.close(() => r()));
    });

    it('lays a fresh board out as Anchor + Turns, mirrors a turn, and never spawns', async () => {
      expect(
        await layoutRoom('huddle-x', 'izzo', { anchor: 'docs/a.md', topic: 'lane:1', body: 'why' }),
      ).toBe(true);
      const add = calls.find((c) => c.path === '/api/boards/huddle-x/add')?.body as {
        actor: string;
        items: { kind: string; title?: string; text?: string }[];
      };
      expect(add.actor).toBe('seat:izzo');
      expect(add.items.filter((i) => i.kind === 'cluster').map((i) => i.title)).toEqual([
        'Anchor',
        'Turns',
      ]);
      expect(add.items.some((i) => i.kind === 'note' && i.text === 'docs/a.md')).toBe(true);

      expect(await mirrorTurn('huddle-x', 'lin', 'a turn')).toBe(true);
      const turn = calls.filter((c) => c.path === '/api/boards/huddle-x/add').at(-1)?.body as {
        items: { text: string }[];
      };
      expect(turn.items[0]?.text).toBe('lin: a turn');
    });

    it('a service that is not the whiteboard, or not up, is a quiet false', async () => {
      process.env['WHITEBOARD_PORT'] = '1';
      expect(await layoutRoom('huddle-y', 'izzo', { anchor: 'a', topic: 't', body: 'b' })).toBe(
        false,
      );
      expect(await mirrorTurn('huddle-y', 'izzo', 'b')).toBe(false);
    });
  });

  describe('the room as a view over the log (ADR 378)', () => {
    it('show renders the transcript, who is in it, who has yet to speak, and the budget spent', async () => {
      await capture(() =>
        teamCommand(parseArgs(['add', 'lin', '--kind', 'agent', '--as', 'nick'])),
      );
      const root = await open(['--to', 'lin']);
      const id = String(root['id']);
      await capture(() => huddleCommand(parseArgs(['say', id, 'a first turn', '--json'])));

      const shown = await capture(() => huddleCommand(parseArgs(['show', id])));
      expect(shown.code).toBe(0);
      expect(shown.out).toContain('huddle lane:01LANE');
      expect(shown.out).toContain('open');
      expect(shown.out).toContain('1/5 turns'); // declared 5 in the fixture, one taken
      expect(shown.out).toContain('docs/design/thing.md'); // the anchor
      expect(shown.out).toContain('a first turn');
      expect(shown.out).toContain('yet to speak: lin'); // named but silent — who still owes the room
      expect(shown.out).toContain(`musterd huddle say ${id}`); // how to answer
    });

    it('show reports a closed huddle and where the artifact landed', async () => {
      const root = await open();
      const id = String(root['id']);
      await capture(() =>
        huddleCommand(
          parseArgs(['close', id, '--anchor-ref', 'docs/a.md@abc', 'landed', '--json']),
        ),
      );
      const shown = await capture(() => huddleCommand(parseArgs(['show', id])));
      expect(shown.out).toContain('closed');
      expect(shown.out).toContain('landed at docs/a.md@abc');
      expect(shown.out).not.toContain('answer with'); // a closed room takes no more turns
    });

    it('list shows the open huddles I am in, and says so when there are none', async () => {
      const empty = await capture(() => huddleCommand(parseArgs(['list'])));
      expect(empty.out).toContain('no open huddles you are in');

      const root = await open();
      const id = String(root['id']);
      const listed = await capture(() => huddleCommand(parseArgs(['list'])));
      expect(listed.out).toContain(id);
      expect(listed.out).toContain('lane:01LANE');

      // A closed huddle leaves the default list — the room is over.
      await capture(() =>
        huddleCommand(parseArgs(['close', id, '--anchor-ref', 'none', 'nothing landed', '--json'])),
      );
      const after = await capture(() => huddleCommand(parseArgs(['list'])));
      expect(after.out).toContain('no open huddles you are in');
      const all = await capture(() => huddleCommand(parseArgs(['list', '--all'])));
      expect(all.out).toContain(id);
    });

    it('show names an id it cannot find rather than rendering an empty room', async () => {
      await expect(huddleCommand(parseArgs(['show', '01NOPE']))).rejects.toThrow(
        /no huddle 01NOPE/,
      );
    });
  });
});
