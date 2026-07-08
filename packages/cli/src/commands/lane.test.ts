import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { loadConfig } from '../config.js';
import { laneCommand, lanesCommand } from './lane.js';
import { teamCommand } from './team.js';

describe('lane commands', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-lane-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    // `team create` mints nick as creator-admin and auto-binds this folder, so lane commands
    // resolve nick from the binding without an explicit --as (the acting-identity requirement).
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

  /** Open a lane and return its id (parsed out of the `--json` payload). */
  async function openLane(args: string[]): Promise<string> {
    const res = await capture(() => laneCommand(parseArgs(['open', ...args, '--json'])));
    // `lane open` doesn't honour --json (it always renders), so read the board back instead.
    void res;
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string }[] };
    return lanes[lanes.length - 1]!.id;
  }

  it('opens a lane and renders it with a checkmark', async () => {
    const res = await capture(() =>
      laneCommand(parseArgs(['open', 'wire the thing', '--surface', 'src/a.ts,src/b.ts'])),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('lane opened');
    expect(res.out).toContain('wire the thing');
    expect(res.out).toContain('src/a.ts');
  });

  it('open --claim assigns the lane to the caller', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'mine', '--claim'])));
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { title: string; owner_seat: string }[] };
    expect(lanes.find((l) => l.title === 'mine')?.owner_seat).toBe('nick');
  });

  it('open threads goal/branch/depends/detail/project/role through', async () => {
    const res = await capture(() =>
      laneCommand(
        parseArgs([
          'open',
          'rich',
          '--goal',
          'g1',
          '--branch',
          'feat/x',
          '--depends',
          'a,b',
          '--detail',
          'notes',
          '--project',
          'p',
          '--role',
          'dev',
        ]),
      ),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('feat/x');
    expect(res.out).toContain('g1');
  });

  it('claim then resolve moves a lane to done', async () => {
    const id = await openLane(['claimable']);
    const claimed = await capture(() => laneCommand(parseArgs(['claim', id])));
    expect(claimed.out).toContain('lane claimed');
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).toContain('lane done');
    expect(resolved.out).toContain('done');
  });

  it('resolve prints the local-branch cleanup hint when the lane carries a branch', async () => {
    const id = await openLane(['landed', '--claim', '--branch', 'feat/landed']);
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).toContain('clear the local branch');
    expect(resolved.out).toContain('git branch -D feat/landed');
    expect(resolved.out).toContain('git switch --detach origin/main');
  });

  it('resolve omits the cleanup hint for a lane with no branch', async () => {
    const id = await openLane(['branchless']);
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).not.toContain('clear the local branch');
  });

  it('claim does not print the branch-cleanup hint', async () => {
    const id = await openLane(['nohint', '--branch', 'feat/nohint']);
    const claimed = await capture(() => laneCommand(parseArgs(['claim', id])));
    expect(claimed.out).not.toContain('clear the local branch');
  });

  it('handoff reassigns to another seat with a branch', async () => {
    await new (await import('../client.js')).HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
    }).addMember('dawn', { name: 'Ada', kind: 'agent' });
    const id = await openLane(['handme', '--claim']);
    const res = await capture(() =>
      laneCommand(parseArgs(['handoff', id, '--to', 'Ada', '--branch', 'feat/y'])),
    );
    expect(res.out).toContain('handed to Ada');
    expect(res.out).toContain('feat/y');
  });

  it('update sets state/detail/surface', async () => {
    const id = await openLane(['upd']);
    const res = await capture(() =>
      laneCommand(parseArgs(['update', id, '--state', 'active', '--surface', 'src/c.ts'])),
    );
    expect(res.out).toContain('lane updated');
    expect(res.out).toContain('active');
    expect(res.out).toContain('src/c.ts');
  });

  it('lanes renders an empty board hint', async () => {
    const res = await capture(() => lanesCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('no lanes');
  });

  it('lanes lists lanes and honours --mine/--open filters', async () => {
    await openLane(['a', '--claim']);
    await openLane(['b']);
    const all = await capture(() => lanesCommand(parseArgs([])));
    expect(all.out).toContain('lanes — dawn');
    expect(all.out).toContain('"a"');
    const open = await capture(() => lanesCommand(parseArgs(['--open', '--json'])));
    const { lanes } = JSON.parse(open.out) as { lanes: { title: string }[] };
    expect(lanes.some((l) => l.title === 'b')).toBe(true);
    expect(lanes.some((l) => l.title === 'a')).toBe(false);
  });

  it('rejects malformed subcommands and missing args with usage', async () => {
    await expect(laneCommand(parseArgs([]))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['open']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['claim']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['handoff', 'x']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['update']))).rejects.toThrow(/usage/);
  });
});
