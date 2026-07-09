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
      serviceCommand(parseArgs(['stop']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0 }),
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain('was not running');
  });

  // ADR 047: the destructive verbs refuse while teammates hold live sessions, unless --force.
  it('restart refuses when other sessions are live, with a heads-up nudge', async () => {
    const c = ctx(recorder());
    await expect(
      serviceCommand(parseArgs(['restart']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 2 }),
      }),
    ).rejects.toThrow(/2 live sessions are connected.*--force/s);
    // guard fired before any launchctl call
    expect(calls).toEqual([]);
  });

  it('restart proceeds with --force despite live sessions', async () => {
    const c = ctx(recorder());
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['restart', '--force']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 3 }),
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain('restarted');
  });

  it('stop proceeds when no sessions are connected', async () => {
    const c = ctx(recorder());
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['stop']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0 }),
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain('stopped the musterd daemon');
  });

  it('restart fails open when the daemon health is unreachable', async () => {
    const c = ctx(recorder());
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['restart']), {
        platform: 'darwin',
        ctx: c,
        health: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain('restarted');
  });

  // ADR 118: `service refresh` = sync main → build → restart, in one guarded verb.
  function refreshRunner(
    over: { dirty?: string; buildStatus?: number; before?: string; after?: string } = {},
  ): Runner {
    let head = 0;
    return (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'git') {
        if (args.includes('--is-inside-work-tree'))
          return { status: 0, stdout: 'true', stderr: '' };
        if (args.includes('--porcelain'))
          return { status: 0, stdout: over.dirty ?? '', stderr: '' };
        if (args.includes('HEAD'))
          return {
            status: 0,
            stdout: head++ === 0 ? (over.before ?? 'aaa111') : (over.after ?? 'bbb222'),
            stderr: '',
          };
        return { status: 0, stdout: '', stderr: '' }; // fetch / switch
      }
      if (cmd === 'pnpm')
        return { status: over.buildStatus ?? 0, stdout: '', stderr: 'build boom' };
      return { status: 0, stdout: '', stderr: '' }; // launchctl (restart)
    };
  }

  it('refresh syncs to main, rebuilds, and restarts', async () => {
    const c = ctx(refreshRunner());
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['refresh']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0 }),
      }),
    );
    expect(code).toBe(0);
    // the sequence: fetch → switch → pnpm build → launchctl restart
    expect(calls.some((x) => x.cmd === 'git' && x.args.includes('fetch'))).toBe(true);
    expect(calls.some((x) => x.cmd === 'git' && x.args.includes('switch'))).toBe(true);
    expect(calls.some((x) => x.cmd === 'pnpm' && x.args.includes('build'))).toBe(true);
    expect(calls.some((x) => x.cmd === 'launchctl')).toBe(true);
    expect(out).toContain('synced');
    expect(out).toContain('rebuilt dist');
    expect(out).toContain('restarted the musterd daemon on bbb222');
  });

  it('refresh refuses to clobber uncommitted changes (no build/restart)', async () => {
    const c = ctx(refreshRunner({ dirty: ' M packages/cli/src/x.ts' }));
    await expect(
      serviceCommand(parseArgs(['refresh']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0 }),
      }),
    ).rejects.toThrow(/uncommitted changes/);
    expect(calls.some((x) => x.cmd === 'pnpm')).toBe(false);
    expect(calls.some((x) => x.cmd === 'launchctl')).toBe(false);
  });

  it('refresh refuses with live sessions unless --force (guard before any side effect)', async () => {
    const c = ctx(refreshRunner());
    await expect(
      serviceCommand(parseArgs(['refresh']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 2 }),
      }),
    ).rejects.toThrow(/2 live sessions.*--force/s);
    expect(calls.some((x) => x.args.includes('fetch'))).toBe(false); // never synced
    expect(calls.some((x) => x.cmd === 'pnpm')).toBe(false);
  });

  it('refresh aborts on a build failure and does NOT restart', async () => {
    const c = ctx(refreshRunner({ buildStatus: 1 }));
    await expect(
      serviceCommand(parseArgs(['refresh', '--force']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 5 }),
      }),
    ).rejects.toThrow(/build failed/);
    expect(calls.some((x) => x.cmd === 'launchctl')).toBe(false); // daemon left running old code
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
