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

  it('declares a goal with deps and renders it', async () => {
    const res = await capture(() =>
      goalCommand(
        parseArgs(['declare', 'Ship the thing', '--goal-id', 'ship', '--depends', 'a, b']),
      ),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('goal declared');
    expect(res.out).toContain('Ship the thing');
    expect(res.out).toContain('deps:2');
  });

  it('refuses a numeric --wave at the call site, and says what to use instead (ADR 257)', async () => {
    // The server would reject it anyway; failing here means the seat gets the reason, not a schema error.
    await expect(
      goalCommand(parseArgs(['declare', 'Ship the thing', '--goal-id', 'ship', '--wave', '2'])),
    ).rejects.toThrow(/--wave takes only "later".*--depends/s);
  });

  it('declares with a story and renders it (goals-front-door design)', async () => {
    const res = await capture(() =>
      goalCommand(
        parseArgs([
          'declare',
          'Native harness',
          '--goal-id',
          'native',
          '--story',
          'the daemon becomes its own harness',
        ]),
      ),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('"the daemon becomes its own harness"');
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

  it('records an outcome note and renders it (value-layer design)', async () => {
    await capture(() => goalCommand(parseArgs(['declare', 'G', '--goal-id', 'g'])));
    const res = await capture(() => goalCommand(parseArgs(['outcome', 'g', 'users can now X'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('outcome recorded');
    expect(res.out).toContain('users can now X');
    const listed = await capture(() => goalCommand(parseArgs(['list'])));
    expect(listed.out).toContain('users can now X');
  });

  it('outcome for an undeclared goal reports queued', async () => {
    const res = await capture(() => goalCommand(parseArgs(['outcome', 'ghost', 'note'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('queued');
  });

  it('rejects outcome without id/text', async () => {
    await expect(goalCommand(parseArgs(['outcome', 'g']))).rejects.toThrow(/usage/);
  });

  it('rejects declare without title/id and unknown subcommands', async () => {
    await expect(goalCommand(parseArgs(['declare', 'notitle-id-missing']))).rejects.toThrow(
      /usage/,
    );
    await expect(goalCommand(parseArgs(['bogus']))).rejects.toThrow(/usage/);
  });

  it('retracts a goal, list hides it by default, --all shows it (goal-retract design)', async () => {
    await capture(() => goalCommand(parseArgs(['declare', 'Scratch', '--goal-id', 'scratch'])));
    const res = await capture(() => goalCommand(parseArgs(['retract', 'scratch'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('goal retracted');
    const list = await capture(() => goalCommand(parseArgs(['list'])));
    expect(list.out).not.toContain('Scratch');
    expect(list.out).toContain('1 retracted');
    const all = await capture(() => goalCommand(parseArgs(['list', '--all'])));
    expect(all.out).toContain('Scratch');
    expect(all.out).toContain('retracted');
  });

  it('retracting an undeclared goal says the signal is queued', async () => {
    const res = await capture(() => goalCommand(parseArgs(['retract', 'ghost'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('not yet declared');
  });
});
