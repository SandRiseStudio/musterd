import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig } from '../config.js';
import { doneCommand } from './done.js';
import { laneCommand, lanesCommand } from './lane.js';
import { nextCommand } from './next.js';
import { teamCommand } from './team.js';

/** Covers the orientation pair: `musterd next` (the brief) and `musterd done` (close + chain). */
describe('next / done commands', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-orient-'));
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

  async function lastLaneId(): Promise<string> {
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string }[] };
    return lanes[lanes.length - 1]!.id;
  }

  it('next renders the empty-brief hint when nothing is in flight', async () => {
    const res = await capture(() => nextCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('nothing in flight');
  });

  it('next renders carrying + up-next once lanes exist', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'carried', '--claim'])));
    await capture(() => laneCommand(parseArgs(['open', 'available'])));
    const res = await capture(() => nextCommand(parseArgs([])));
    expect(res.out).toContain('carrying');
    expect(res.out).toContain('carried');
    expect(res.out).toContain('up next');
  });

  it('next --json emits the raw brief', async () => {
    const res = await capture(() => nextCommand(parseArgs(['--json'])));
    const brief = JSON.parse(res.out) as { member: string; in_flight: unknown[] };
    expect(brief.member).toBe('nick');
    expect(Array.isArray(brief.in_flight)).toBe(true);
  });

  it('done auto-targets the caller single live lane and closes it', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'finish me', '--claim'])));
    const res = await capture(() => doneCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('done');
    expect(res.out).toContain('finish me');
  });

  it('done <id> closes a named lane', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'named', '--claim'])));
    const id = await lastLaneId();
    const res = await capture(() => doneCommand(parseArgs([id])));
    expect(res.out).toContain('done');
  });

  it('done errors when there is no live lane', async () => {
    await expect(doneCommand(parseArgs([]))).rejects.toThrow(/no live lane/);
  });

  it('done errors when the caller owns several live lanes', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'one', '--claim'])));
    await capture(() => laneCommand(parseArgs(['open', 'two', '--claim'])));
    await expect(doneCommand(parseArgs([]))).rejects.toThrow(/live lanes/);
  });

  it('done chains into up-next when other open lanes exist', async () => {
    // Another seat opens work so the brief has an up-next entry after we close ours.
    await new HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
    }).openLane('dawn', { title: 'downstream' });
    await capture(() => laneCommand(parseArgs(['open', 'mine', '--claim'])));
    const res = await capture(() => doneCommand(parseArgs([])));
    expect(res.out).toContain('up next');
    expect(res.out).toContain('downstream');
  });
});
