import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { teamCommand } from './team.js';

/**
 * CLI coverage for `musterd team policy` (ADR 146) — the operable surface that flips a team into
 * dogfood-mode re-seat. The read → merge → POST semantics (one knob without clobbering the rest) and
 * the on/off parsing are what this exercises; the server-side re-seat behaviour is covered in the
 * server package's claim tests.
 */
describe('team policy command', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-team-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    // Creator becomes the admin and auto-binds this folder, so `team policy` resolves nick without --as.
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

  it('shows the policy with re-seat off by default', async () => {
    const res = await capture(() => teamCommand(parseArgs(['policy'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('team policy — dawn');
    expect(res.out).toContain('re-seat known agents: off');
  });

  it('turns re-seat on and reads it back', async () => {
    const set = await capture(() =>
      teamCommand(parseArgs(['policy', '--reseat-known-agents', 'on'])),
    );
    expect(set.code).toBe(0);
    expect(set.out).toContain('re-seat known agents on');

    const show = await capture(() => teamCommand(parseArgs(['policy', '--json'])));
    expect(JSON.parse(show.out).standing_reseat_known_agents).toBe(true);
  });

  it('turning re-seat on does not clobber the residency wake defaults (read-merge-write)', async () => {
    const before = JSON.parse(
      (await capture(() => teamCommand(parseArgs(['policy', '--json'])))).out,
    );
    await capture(() => teamCommand(parseArgs(['policy', '--reseat-known-agents', 'on'])));
    const after = JSON.parse(
      (await capture(() => teamCommand(parseArgs(['policy', '--json'])))).out,
    );
    expect(after.residency).toEqual(before.residency);
    expect(after.standing_reseat_known_agents).toBe(true);
  });

  it('can turn re-seat back off', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--reseat-known-agents', 'on'])));
    await capture(() => teamCommand(parseArgs(['policy', '--reseat-known-agents', 'off'])));
    const show = await capture(() => teamCommand(parseArgs(['policy', '--json'])));
    expect(JSON.parse(show.out).standing_reseat_known_agents).toBe(false);
  });

  it('rejects a non-on/off value', async () => {
    await expect(
      teamCommand(parseArgs(['policy', '--reseat-known-agents', 'maybe'])),
    ).rejects.toThrow(/on\|off/);
  });
});
