import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { readBindingAt, type Config } from '../config.js';
import { teamCommand } from './team.js';

/**
 * `musterd team create` must not repoint every CLI on the machine (lane 01KZVKF3H0R81XEA818G2QBRZC).
 *
 * THE INCIDENT, 2026-08-12: a seat created an isolated team on :4899 for an ADR 252 live wake check
 * — a reasonable, required thing to do. `team create` wrote `server` and `current` into the
 * machine-wide config, so every OTHER folder without a binding, and every reader that consults the
 * global config directly (`service status`, `stream doctor`), silently started measuring a port that
 * vanished when the probe ended. Four checks failed correctly about the wrong daemon; ~1h was lost
 * chasing healthy infrastructure, and the mis-pointed config was first cause of a second incident.
 *
 * The fix rests on a fact that was already true: `team create` ALSO writes a binding for the
 * creating folder, and a binding outranks the global default. So the folder that ran the command is
 * served correctly without the global write — which makes stealing an established machine default
 * pure side effect.
 *
 * These tests run TWO real daemons on different ports, because a single-server test cannot tell
 * "left the default alone" from "overwrote it with the same value" — the exact shape of the bug.
 */
describe('team create and the machine-wide default', () => {
  let first: RunningServer;
  let second: RunningServer;
  let firstUrl: string;
  let secondUrl: string;
  let homeDir: string;
  let probeDir: string;

  beforeEach(async () => {
    first = createServer({ db: openDb(':memory:'), port: 0 });
    second = createServer({ db: openDb(':memory:'), port: 0 });
    firstUrl = `http://127.0.0.1:${(await first.listen()).port}`;
    secondUrl = `http://127.0.0.1:${(await second.listen()).port}`;
    homeDir = mkdtempSync(join(tmpdir(), 'musterd-home-'));
    probeDir = mkdtempSync(join(tmpdir(), 'musterd-probe-'));
    process.env['MUSTERD_CONFIG'] = join(homeDir, 'config.json');
    // Deliberately NOT setting MUSTERD_SERVER: it would mask the global default this exercises.
    delete process.env['MUSTERD_SERVER'];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([first.close(), second.close()]);
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
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

  function readConfig(): Config {
    return JSON.parse(readFileSync(process.env['MUSTERD_CONFIG'] as string, 'utf8')) as Config;
  }

  /** Create a team from `dir` against `server`, as the real command would be invoked. */
  async function createFrom(
    dir: string,
    slug: string,
    server: string,
    ...extra: string[]
  ): Promise<{ code: number; out: string }> {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    return capture(() =>
      teamCommand(parseArgs(['create', slug, '--as', 'nick', '--server', server, ...extra])),
    );
  }

  it('adopts the machine default on a virgin config — first-time setup still needs one', async () => {
    const res = await createFrom(homeDir, 'dawn', firstUrl);
    expect(res.code).toBe(0);
    const config = readConfig();
    expect(config.current).toBe('dawn');
    expect(config.server).toBe(firstUrl);
    expect(res.out).toContain('machine default');
  });

  it('leaves an established machine default alone, and still binds the creating folder', async () => {
    await createFrom(homeDir, 'dawn', firstUrl);
    const res = await createFrom(probeDir, 'probe', secondUrl);
    expect(res.code).toBe(0);

    // The incident, asserted: the machine default must still name the real team and its daemon.
    const config = readConfig();
    expect(config.current).toBe('dawn');
    expect(config.server).toBe(firstUrl);

    // …while the folder that ran the command is fully usable, via the binding it already wrote.
    const binding = readBindingAt(probeDir);
    expect(binding?.team).toBe('probe');
    expect(binding?.server).toBe(secondUrl);

    // Silence is what made this expensive. Say both halves at the call site.
    expect(res.out).toContain('dawn');
    expect(res.out).toContain('--switch');
  });

  it('--switch takes the machine default deliberately', async () => {
    await createFrom(homeDir, 'dawn', firstUrl);
    const res = await createFrom(probeDir, 'probe', secondUrl, '--switch');
    expect(res.code).toBe(0);
    const config = readConfig();
    expect(config.current).toBe('probe');
    expect(config.server).toBe(secondUrl);
    expect(res.out).toContain('machine default');
  });

  it('keeps the creating folder bound in every branch — the binding is not what changed', async () => {
    await createFrom(homeDir, 'dawn', firstUrl);
    expect(readBindingAt(homeDir)?.team).toBe('dawn');
    await createFrom(probeDir, 'probe', secondUrl, '--switch');
    expect(readBindingAt(probeDir)?.team).toBe('probe');
  });
});
