import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { huddleCommand } from './huddle.js';
import { statusCommand } from './status.js';
import { teamCommand } from './team.js';

/**
 * The roster's huddle mark (ADR 378): a huddle is invisible on `status` until the roll call joins the
 * derived room to the member list. Everything here goes through a real in-memory daemon and the real
 * `huddle` command, so the mark is proved against actual envelopes rather than a hand-built view.
 */
describe('musterd status — who is in a huddle', () => {
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-status-'));
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

  const openHuddle = async (): Promise<string> => {
    const res = await capture(() =>
      huddleCommand(
        parseArgs([
          'open',
          '--topic',
          'lane:01LANE',
          '--anchor',
          'docs/design/thing.md',
          'why',
          'we',
          'huddle',
          '--json',
        ]),
      ),
    );
    return String((JSON.parse(res.out) as { id: string }).id);
  };

  const status = async () => (await capture(() => statusCommand(parseArgs([])))).out;

  it('marks the seat that opened a huddle, naming the topic', async () => {
    expect(await status()).not.toContain('huddle');

    await openHuddle();

    expect(await status()).toContain('huddle lane:01LANE');
  });

  it('drops the mark when the huddle closes', async () => {
    const id = await openHuddle();
    expect(await status()).toContain('huddle lane:01LANE');

    await capture(() =>
      huddleCommand(parseArgs(['close', id, '--anchor-ref', 'docs/design/thing.md@abc', 'done'])),
    );

    expect(await status()).not.toContain('huddle lane:01LANE');
  });
});
