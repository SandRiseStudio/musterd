import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import type { HostRegistryEntry } from '../host/registry.js';
import { doorbellCommand } from './doorbell.js';
import { teamCommand } from './team.js';

describe('doorbell command (ADR 443)', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-doorbell-'));
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
  const run = (args: string[], deps = {}) => capture(() => doorbellCommand(parseArgs(args), deps));

  // `team create` auto-binds the cwd identity (ADR 036), so the command resolves `nick`.
  const setupTeam = () => capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));

  const registry = (host: string): { entries: HostRegistryEntry[] } => ({
    entries: [
      {
        server: serverUrl,
        team: 'dawn',
        seat: 'izzo',
        workspace: '/ws/izzo',
        harness: 'claude-code',
        host,
        updated_at: 1,
      },
    ],
  });

  it('shows each sink and where its state comes from', async () => {
    await setupTeam();
    const res = await run([]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/on .*live .*always on/);
    expect(res.out).toMatch(/on .*os .*team default/);
    expect(res.out).toMatch(/off.*slack .*off by team default · no url set/);
  });

  it('a personal URL prints masked to its host, never its path', async () => {
    await setupTeam();
    const on = await run(['webhook', 'on', '--url', 'https://ntfy.sh/nick-secret-topic']);
    expect(on.code).toBe(0);
    const res = await run([]);
    expect(res.out).toMatch(/webhook .*your override · your url → ntfy\.sh/);
    expect(res.out).not.toContain('nick-secret-topic');
  });

  it('webhook on with no --url and no team URL exits 2 with the reason', async () => {
    await setupTeam();
    await expect(run(['webhook', 'on'])).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/^no webhook url/),
    });
  });

  it('a private URL is refused by the daemon, naming the sink and not the URL', async () => {
    await setupTeam();
    await expect(run(['webhook', 'on', '--url', 'https://192.168.1.5/x'])).rejects.toMatchObject({
      message: 'the webhook url must not point at a private, loopback or link-local host',
    });
  });

  it('os on records this machine’s host label, and refuses when no host runs here', async () => {
    await setupTeam();
    await expect(
      run(['os', 'on'], { loadRegistry: () => ({ entries: [] }) }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/^no musterd host runs on this machine/),
    });
    const on = await run(['os', 'on'], { loadRegistry: () => registry('mac-a') });
    expect(on.code).toBe(0);
    expect((await run([])).out).toMatch(/os .*your override · host mac-a/);
  });

  it('live cannot be switched off', async () => {
    await setupTeam();
    await expect(run(['live', 'off'])).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/^live is always on/),
    });
  });

  it('team knobs: the allow-list narrows every human’s route', async () => {
    await setupTeam();
    const team = await run(['team', '--allow', 'live,slack', '--defaults', 'live']);
    expect(team.code).toBe(0);
    expect(team.out).toContain('allow     live, slack');
    expect((await run([])).out).toMatch(/off.*os .*not allowed on this team/);
  });

  it('team knobs: a non-public team URL is refused', async () => {
    await setupTeam();
    await expect(run(['team', '--webhook', 'http://ntfy.sh/x'])).rejects.toMatchObject({
      message: 'the team webhook url must use https',
    });
  });
});
