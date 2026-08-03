import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { sendCommand } from './send.js';
import { teamCommand } from './team.js';
import { wakeContextCommand } from './wake-context.js';

describe('wake-context command (ADR 209)', () => {
  let server: RunningServer;
  let dir: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    previousEnv = {
      MUSTERD_SERVER: process.env['MUSTERD_SERVER'],
      MUSTERD_CONFIG: process.env['MUSTERD_CONFIG'],
      MUSTERD_NO_NUDGE: process.env['MUSTERD_NO_NUDGE'],
    };
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-wake-context-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NO_NUDGE'] = '1';
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function capture(fn: () => Promise<number>): Promise<string> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: never) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await fn();
      return chunks.join('');
    } finally {
      spy.mockRestore();
    }
  }

  it('returns a body-free packet as JSON and rejects missing targets', async () => {
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
    await capture(() =>
      sendCommand(parseArgs(['--to', 'nick', '--act', 'message', 'wake body stays remote'])),
    );
    const messages = server.db.prepare<[], { id: string }>('SELECT id FROM messages').all();
    const out = await capture(() =>
      wakeContextCommand(parseArgs(['--act', messages[0]!.id, '--json'])),
    );
    expect(JSON.parse(out)).toMatchObject({ wake: { kind: 'reply', act_id: messages[0]!.id } });
    expect(out).not.toContain('wake body stays remote');
    await expect(wakeContextCommand(parseArgs([]))).rejects.toThrow(/--act <id> \| --lane <id>/);
  });
});
