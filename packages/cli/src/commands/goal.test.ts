import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { goalCommand } from './goal.js';
import { teamCommand } from './team.js';

describe('goal command', () => {
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-goal-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
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

  it('declares a goal with wave + deps and renders it', async () => {
    const res = await capture(() =>
      goalCommand(
        parseArgs([
          'declare',
          'Ship the thing',
          '--goal-id',
          'ship',
          '--wave',
          '2',
          '--depends',
          'a, b',
        ]),
      ),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('goal declared');
    expect(res.out).toContain('Ship the thing');
    expect(res.out).toContain('wave:2');
    expect(res.out).toContain('deps:2');
  });

  it('declares with wave "later"', async () => {
    const res = await capture(() =>
      goalCommand(parseArgs(['declare', 'Later goal', '--goal-id', 'later1', '--wave', 'later'])),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('goal declared');
  });

  it('lists declared goals (and empty state)', async () => {
    const empty = await capture(() => goalCommand(parseArgs(['list'])));
    expect(empty.out).toContain('no declared goals');

    await capture(() => goalCommand(parseArgs(['declare', 'G', '--goal-id', 'g'])));
    const listed = await capture(() => goalCommand(parseArgs(['list'])));
    expect(listed.out).toContain('"G"');
    expect(listed.out).toContain('declared by nick');
  });

  it('list --json emits a parseable array', async () => {
    await capture(() => goalCommand(parseArgs(['declare', 'G', '--goal-id', 'g'])));
    const res = await capture(() => goalCommand(parseArgs(['list', '--json'])));
    const arr = JSON.parse(res.out) as Array<{ id: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.id).toBe('g');
  });

  it('rejects declare without title/id and unknown subcommands', async () => {
    await expect(goalCommand(parseArgs(['declare', 'notitle-id-missing']))).rejects.toThrow(
      /usage/,
    );
    await expect(goalCommand(parseArgs(['bogus']))).rejects.toThrow(/usage/);
  });
});
