import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { SERVICE_LABEL } from '../service/launchd.js';
import type { RunResult, Runner, ServiceCtx } from '../service/manage.js';
import { serviceCommand } from './service.js';

describe('serviceCommand', () => {
  let dir: string;
  let calls: { cmd: string; args: string[] }[];

  function ctx(runner: Runner): ServiceCtx {
    return {
      uid: 501,
      label: SERVICE_LABEL,
      plistPath: join(dir, 'agent.plist'),
      node: '/opt/homebrew/bin/node',
      binJs: '/repo/packages/cli/dist/bin.js',
      serveArgs: ['serve'],
      workingDir: '/repo',
      stdoutPath: join(dir, 'daemon.log'),
      stderrPath: join(dir, 'daemon.err.log'),
      path: '/usr/bin:/bin',
      run: runner,
      sleep: () => {},
    };
  }
  const recorder =
    (result: RunResult = { status: 0, stdout: '', stderr: '' }): Runner =>
    (cmd, args) => {
      calls.push({ cmd, args });
      return result;
    };

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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-svccmd-'));
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('requires a subcommand', async () => {
    await expect(serviceCommand(parseArgs([]))).rejects.toThrow(/usage/);
  });

  it('refuses unsupported platforms with the systemd/Windows seam', async () => {
    await expect(serviceCommand(parseArgs(['install']), { platform: 'linux' })).rejects.toThrow(
      /macOS-only/,
    );
  });

  it('install writes the plist, bootstraps, kickstarts, and reports', async () => {
    const c = ctx(recorder());
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['install']), { platform: 'darwin', ctx: c }),
    );
    expect(code).toBe(0);
    expect(existsSync(c.plistPath)).toBe(true);
    expect(out).toContain('installed + started');
    expect(calls.map((x) => x.args[0])).toEqual(['bootout', 'bootstrap', 'kickstart']);
  });

  it('install surfaces a bootstrap failure as a CliError', async () => {
    let n = 0;
    const c = ctx((cmd, args) => {
      calls.push({ cmd, args });
      return { status: n++ === 0 ? 0 : 1, stdout: '', stderr: 'denied' };
    });
    await expect(
      serviceCommand(parseArgs(['install']), { platform: 'darwin', ctx: c }),
    ).rejects.toThrow(/install \(bootstrap\) failed/);
  });

  it('stop treats an already-stopped agent as success', async () => {
    const c = ctx(recorder({ status: 1, stdout: '', stderr: 'not loaded' }));
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['stop']), { platform: 'darwin', ctx: c }),
    );
    expect(code).toBe(0);
    expect(out).toContain('was not running');
  });

  it('uninstall removes the plist', async () => {
    const c = ctx(recorder());
    writeFileSync(c.plistPath, 'x', 'utf8');
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['uninstall']), { platform: 'darwin', ctx: c }),
    );
    expect(code).toBe(0);
    expect(existsSync(c.plistPath)).toBe(false);
    expect(out).toContain('removed');
  });

  it('logs (no follow) prints the tail of the daemon logs', async () => {
    const c = ctx(recorder());
    writeFileSync(c.stdoutPath, 'listening on ws://127.0.0.1:4849\n', 'utf8');
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['logs']), { platform: 'darwin', ctx: c }),
    );
    expect(code).toBe(0);
    expect(out).toContain('listening on ws://127.0.0.1:4849');
  });

  it('status renders the launchd state (health unreachable is fine)', async () => {
    const c = ctx(recorder({ status: 0, stdout: '\tpid = 7\n\tstate = running\n', stderr: '' }));
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['status']), { platform: 'darwin', ctx: c }),
    );
    expect(code).toBe(0);
    expect(out).toContain(SERVICE_LABEL);
    expect(out).toContain('loaded');
  });
});
