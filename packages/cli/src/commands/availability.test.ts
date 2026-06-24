import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { availabilityCommand } from './availability.js';
import { teamCommand } from './team.js';

describe('availability command', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-avail-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
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

  // `team create` auto-binds the cwd identity (ADR 036), so the command resolves `nick` from the
  // binding without an explicit --as.
  async function setupTeam(): Promise<void> {
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
  }

  it('sets away_until and the roster reflects it (off until <ts>)', async () => {
    await setupTeam();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const res = await capture(() => availabilityCommand(parseArgs(['away', '--until', until])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('availability set to');

    const roster = await new HttpClient({ server: serverUrl }).roster('dawn');
    const me = roster.members.find((m) => m.name === 'nick');
    expect(me?.availability?.status).toBe('away');
    expect(me?.availability?.until).toBe(Date.parse(until));
  });

  it('sets dnd', async () => {
    await setupTeam();
    const res = await capture(() => availabilityCommand(parseArgs(['dnd'])));
    expect(res.code).toBe(0);
    const roster = await new HttpClient({ server: serverUrl }).roster('dawn');
    expect(roster.members.find((m) => m.name === 'nick')?.availability).toEqual({ status: 'dnd' });
  });

  it('rejects an unknown status', async () => {
    await setupTeam();
    await expect(availabilityCommand(parseArgs(['vacation']))).rejects.toThrow(/usage/);
  });

  it('rejects --until on a non-away status', async () => {
    await setupTeam();
    await expect(
      availabilityCommand(parseArgs(['dnd', '--until', new Date().toISOString()])),
    ).rejects.toThrow(/only applies to/);
  });

  it('rejects an unparseable --until', async () => {
    await setupTeam();
    await expect(availabilityCommand(parseArgs(['away', '--until', 'soon']))).rejects.toThrow(
      /not a valid date/,
    );
  });
});
