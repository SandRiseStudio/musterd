import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { buildPlist, LIVE_LABEL, LIVE_SYNC_LABEL, SERVICE_LABEL } from '../service/launchd.js';
import type { LiveCtx } from '../service/live.js';
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
      readFile: (p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      },
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

  // The plist embeds process.execPath; a node that can't load better-sqlite3 crashloops the daemon while
  // `install` reports success (this took the dogfood daemon down). Guard only that verb, only on a
  // definite ABI mismatch.
  describe('install ABI guard', () => {
    const ABI_ERR =
      "Error: The module '/repo/node_modules/.pnpm/better-sqlite3/build/Release/better_sqlite3.node'\n" +
      'was compiled against a different Node.js version using\nNODE_MODULE_VERSION 127. This version of ' +
      'Node.js requires\nNODE_MODULE_VERSION 115.';
    /** Fail the `node -e` probe with `err`; every other command (launchctl) succeeds. */
    const probeFails =
      (err: string): Runner =>
      (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd.endsWith('node')) return { status: 1, stdout: '', stderr: err };
        return { status: 0, stdout: '', stderr: '' };
      };

    it('refuses to install when the embedded node has the wrong ABI', async () => {
      const c = ctx(probeFails(ABI_ERR));
      await expect(
        serviceCommand(parseArgs(['install']), { platform: 'darwin', ctx: c }),
      ).rejects.toThrow(/refusing to install|NODE_MODULE_VERSION/);
      // and it never wrote the plist / bootstrapped
      expect(existsSync(c.plistPath)).toBe(false);
      expect(calls.some((k) => k.cmd === 'launchctl')).toBe(false);
    });

    it('--force overrides the guard', async () => {
      const c = ctx(probeFails(ABI_ERR));
      const { code } = await capture(() =>
        serviceCommand(parseArgs(['install', '--force']), { platform: 'darwin', ctx: c }),
      );
      expect(code).toBe(0);
      expect(existsSync(c.plistPath)).toBe(true);
    });

    it('proceeds when the probe fails for any NON-ABI reason (never blocks what it cannot read)', async () => {
      const c = ctx(probeFails("Error: Cannot find module 'better-sqlite3'")); // packaged install, etc.
      const { code } = await capture(() =>
        serviceCommand(parseArgs(['install']), { platform: 'darwin', ctx: c }),
      );
      expect(code).toBe(0);
      expect(existsSync(c.plistPath)).toBe(true);
    });

    it('does not guard refresh/start/restart (they never re-embed a node)', async () => {
      const c = ctx(probeFails(ABI_ERR));
      const { code } = await capture(() =>
        serviceCommand(parseArgs(['start']), { platform: 'darwin', ctx: c }),
      );
      expect(code).toBe(0); // start reuses the existing plist — no ABI decision to make
    });
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
    // The ABI guard probes the target node *before* touching launchd (it must not half-install).
    expect(calls[0]?.cmd).toBe(c.node);
    expect(calls.filter((x) => x.cmd === 'launchctl').map((x) => x.args[0])).toEqual([
      'bootout',
      'bootstrap',
      'kickstart',
    ]);
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

  // Issue #289: run from a seat worktree, refresh must still target the DAEMON's own checkout —
  // read back from the installed plist — not the invoked CLI's `workingDir`, which used to silently
  // rebuild the worktree and restart the daemon on stale code.
  it('refresh targets the daemon checkout from the plist, not the invoked CLI', async () => {
    writeFileSync(
      join(dir, 'agent.plist'),
      buildPlist({
        label: SERVICE_LABEL,
        node: '/opt/homebrew/bin/node',
        binJs: '/Users/nick/agents/packages/cli/dist/bin.js', // daemon runs from ~/agents
        serveArgs: ['serve'],
        workingDir: '/Users/nick/agents',
        stdoutPath: '/l',
        stderrPath: '/e',
        path: '/p',
      }),
    );
    // ...but the CLI was invoked from a seat worktree.
    const c = { ...ctx(refreshRunner()), workingDir: '/Users/nick/agents-stanley' };
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['refresh']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0 }),
      }),
    );
    expect(code).toBe(0);
    // every git op runs against the daemon's checkout, never the worktree the CLI ran from.
    const gitDirs = calls
      .filter((x) => x.cmd === 'git')
      .map((x) => x.args[x.args.indexOf('-C') + 1]);
    expect(gitDirs.every((d) => d === '/Users/nick/agents')).toBe(true);
    expect(calls.some((x) => x.cmd === 'pnpm' && x.args.includes('/Users/nick/agents'))).toBe(true);
    expect(
      calls.some((x) => x.cmd === 'pnpm' && x.args.includes('/Users/nick/agents-stanley')),
    ).toBe(false);
    expect(out).toContain("targeting the daemon's own checkout");
    expect(out).toContain('/Users/nick/agents-stanley'); // names where you invoked from
  });

  it('refresh falls back to the invoked checkout when no plist is installed', async () => {
    // No plist written → daemonCheckout returns null → behaves exactly as before.
    const c = ctx(refreshRunner());
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['refresh']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0 }),
      }),
    );
    expect(code).toBe(0);
    const gitDirs = calls
      .filter((x) => x.cmd === 'git')
      .map((x) => x.args[x.args.indexOf('-C') + 1]);
    expect(gitDirs.every((d) => d === '/repo')).toBe(true);
    expect(out).not.toContain("targeting the daemon's own checkout");
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

  // ADR 130: status names the running daemon's build and its skew against origin/main.
  function gitScriptedRunner(over: { revList?: RunResult }): Runner {
    return (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd !== 'git') return { status: 0, stdout: '\tpid = 7\n\tstate = running\n', stderr: '' };
      const verb = args[2];
      if (verb === 'rev-parse') return { status: 0, stdout: 'true\n', stderr: '' };
      if (verb === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (verb === 'rev-list') return over.revList ?? { status: 0, stdout: '0\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
  }
  const buildSha = 'a'.repeat(40);

  it('status warns when the daemon build is behind origin/main, naming service refresh', async () => {
    const c = ctx(gitScriptedRunner({ revList: { status: 0, stdout: '3\n', stderr: '' } }));
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['status']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0, build: buildSha }),
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain('3 commits behind origin/main');
    expect(out).toContain('musterd service refresh');
    // The comparison ran against the daemon's own checkout.
    expect(calls.some((x) => x.cmd === 'git' && x.args.join(' ').includes('/repo'))).toBe(true);
  });

  it('status reports up-to-date when the daemon build matches origin/main', async () => {
    const c = ctx(gitScriptedRunner({}));
    const { out } = await capture(() =>
      serviceCommand(parseArgs(['status']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0, build: buildSha }),
      }),
    );
    expect(out).toContain('up to date with origin/main');
  });

  it('strips a -dirty suffix before rev-list but keeps it in the display (ADR 135)', async () => {
    const c = ctx(gitScriptedRunner({ revList: { status: 0, stdout: '2\n', stderr: '' } }));
    const { out } = await capture(() =>
      serviceCommand(parseArgs(['status']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0, build: `${buildSha}-dirty` }),
      }),
    );
    // git plumbing saw the clean sha (rev-list would fail on `…-dirty..origin/main`)…
    const revList = calls.find((x) => x.cmd === 'git' && x.args.includes('rev-list'));
    expect(revList?.args.join(' ')).toContain(`${buildSha}..origin/main`);
    expect(revList?.args.join(' ')).not.toContain('-dirty..');
    // …while the human-facing ref keeps the honest dirty flag and the verdict still lands.
    expect(out).toContain('-dirty');
    expect(out).toContain('2 commits behind origin/main');
  });

  it('status degrades to the bare build ref when the commit is unknown locally', async () => {
    const c = ctx(gitScriptedRunner({ revList: { status: 128, stdout: '', stderr: 'unknown' } }));
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['status']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0, build: buildSha }),
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain(buildSha.slice(0, 7));
    expect(out).not.toContain('behind origin/main');
  });

  it('status prints no build line when the daemon reports none', async () => {
    const c = ctx(recorder({ status: 0, stdout: '\tpid = 7\n\tstate = running\n', stderr: '' }));
    const { out } = await capture(() =>
      serviceCommand(parseArgs(['status']), {
        platform: 'darwin',
        ctx: c,
        health: async () => ({ connections: 0 }),
      }),
    );
    expect(out).not.toContain('build:');
  });

  // ADR 132: `--live` retargets the verbs at the /live build-publisher instead of the daemon.
  function liveCtx(runner: Runner): LiveCtx {
    return {
      uid: 501,
      buildLabel: LIVE_LABEL,
      legacySyncLabel: LIVE_SYNC_LABEL,
      worktree: join(dir, 'agents-live'),
      sourceRepo: join(dir, 'agents'),
      webRoot: join(dir, 'live', 'web'),
      buildPlistPath: join(dir, `${LIVE_LABEL}.plist`),
      buildScriptPath: join(dir, 'live', 'build.sh'),
      buildLogPath: join(dir, 'live', 'build.log'),
      legacySyncPlistPath: join(dir, `${LIVE_SYNC_LABEL}.plist`),
      legacyServeScriptPath: join(dir, 'live', 'serve.sh'),
      legacySyncScriptPath: join(dir, 'live', 'sync.sh'),
      nodeDir: '/opt/node/bin',
      gitDir: '/opt/homebrew/bin',
      intervalSeconds: 60,
      run: runner,
      sleep: () => {},
    };
  }

  it('install --live adds the worktree, writes artifacts, and bootstraps the build agent', async () => {
    const lc = liveCtx(recorder());
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['install', '--live']), { platform: 'darwin', liveCtx: lc }),
    );
    expect(code).toBe(0);
    expect(out).toContain('build-publisher');
    expect(existsSync(lc.buildPlistPath)).toBe(true);
    expect(calls).toContainEqual({
      cmd: 'launchctl',
      args: ['bootstrap', 'gui/501', lc.buildPlistPath],
    });
  });

  it('refresh --live kickstarts the build agent (no live-session guard, no health call)', async () => {
    const lc = liveCtx(recorder());
    const health = vi.fn(async () => ({ connections: 5 })); // would BLOCK a daemon refresh
    const { code } = await capture(() =>
      serviceCommand(parseArgs(['refresh', '--live']), { platform: 'darwin', liveCtx: lc, health }),
    );
    expect(code).toBe(0);
    expect(health).not.toHaveBeenCalled();
    expect(calls).toContainEqual({
      cmd: 'launchctl',
      args: ['kickstart', '-k', `gui/501/${LIVE_LABEL}`],
    });
  });

  it('status --live reports the build agent and probes the daemon /live', async () => {
    const lc = liveCtx(
      recorder({ status: 0, stdout: '\tpid = 42\n\tstate = running\n', stderr: '' }),
    );
    const { code, out } = await capture(() =>
      serviceCommand(parseArgs(['status', '--live']), {
        platform: 'darwin',
        liveCtx: lc,
        probeViewer: async () => true,
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain(LIVE_LABEL);
    expect(out).toContain('up');
    expect(out).toContain('/live');
  });
});
