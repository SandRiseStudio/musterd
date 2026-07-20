import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import type { AutoRefreshCtx } from '../service/autorefresh.js';
import { AUTOREFRESH_LABEL } from '../service/launchd.js';
import type { RunResult, Runner, ServiceCtx } from '../service/manage.js';
import { serviceCommand } from './service.js';

/**
 * The `service refresh --auto` tick (ADR 118/130 fast-follow) — the quiet-period policy, exercised
 * through the injected runner + fake health + in-memory debounce store. It must: no-op a current
 * daemon (never rebuild/bounce when not behind), refresh straight through when idle, DEFER under
 * `idle` mode with live sessions, NOTIFY + force-bounce under `notice` mode with live sessions, and
 * debounce a tip whose build already failed so a broken main can't rebuild every interval forever.
 */
describe('service refresh --auto (the tick)', () => {
  let dir: string;
  let calls: { cmd: string; args: string[] }[];

  function ctx(runner: Runner): ServiceCtx {
    return {
      uid: 501,
      label: 'studio.sandrise.musterd',
      plistPath: join(dir, 'agent.plist'), // absent → daemonCheckout falls back to workingDir
      node: '/opt/homebrew/bin/node',
      binJs: '/repo/packages/cli/dist/bin.js',
      serveArgs: ['serve'],
      workingDir: '/repo',
      stdoutPath: join(dir, 'daemon.log'),
      stderrPath: join(dir, 'daemon.err.log'),
      path: '/usr/bin:/bin',
      run: runner,
      sleep: () => {},
      readFile: () => null,
    };
  }

  // Mocks the git/pnpm/launchctl surface the tick + refreshDaemon touch.
  function autoRunner(o: {
    behind: number;
    tip?: string;
    buildStatus?: number;
    dirty?: string;
  }): Runner {
    let head = 0;
    return (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'git') {
        if (args.includes('--is-inside-work-tree'))
          return { status: 0, stdout: 'true', stderr: '' };
        if (args.includes('--porcelain')) return { status: 0, stdout: o.dirty ?? '', stderr: '' };
        if (args.includes('rev-list')) return { status: 0, stdout: String(o.behind), stderr: '' };
        if (args.includes('rev-parse') && args.includes('origin/main'))
          return { status: 0, stdout: o.tip ?? 'newtip1111', stderr: '' };
        if (args.includes('--short'))
          return { status: 0, stdout: head++ === 0 ? 'aaa1111' : 'bbb2222', stderr: '' };
        return { status: 0, stdout: '', stderr: '' }; // fetch / switch
      }
      if (cmd === 'pnpm') return { status: o.buildStatus ?? 0, stdout: '', stderr: 'boom' };
      return { status: 0, stdout: '', stderr: '' }; // launchctl
    };
  }

  const memState = (initial: string | null = null) => {
    let v = initial;
    return {
      read: () => v || null,
      write: vi.fn((sha: string) => {
        v = sha;
      }),
    };
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

  const tick = (over: {
    argv?: string[];
    ctx: ServiceCtx;
    health: () => Promise<{ connections?: number; build?: string }>;
    notify?: (n: { id: string; title: string; body: string }) => void;
    autoState?: { read: () => string | null; write: (sha: string) => void };
  }) =>
    capture(() =>
      serviceCommand(parseArgs(over.argv ?? ['refresh', '--auto', '--mode', 'notice']), {
        platform: 'darwin',
        ctx: over.ctx,
        health: over.health,
        notify: over.notify,
        // Default to a fresh in-memory store so tests never touch (or share) the real ~/.musterd stamp.
        autoState: over.autoState ?? memState(),
      }),
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autorefresh-tick-'));
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('no-ops a current daemon — never rebuilds or bounces when not behind', async () => {
    const { code, out } = await tick({
      ctx: ctx(autoRunner({ behind: 0 })),
      health: async () => ({ connections: 5, build: 'newtip1111' }),
    });
    expect(code).toBe(0);
    expect(out).toContain('up to date');
    expect(calls.some((x) => x.cmd === 'pnpm')).toBe(false);
    expect(calls.some((x) => x.args.includes('switch'))).toBe(false);
  });

  it('refreshes straight through when the daemon is behind and idle (0 connections)', async () => {
    const { code, out } = await tick({
      ctx: ctx(autoRunner({ behind: 2 })),
      health: async () => ({ connections: 0, build: 'oldsha0' }),
    });
    expect(code).toBe(0);
    expect(calls.some((x) => x.cmd === 'pnpm' && x.args.includes('build'))).toBe(true);
    expect(out).toContain('restarted the musterd daemon');
  });

  it('DEFERS under idle mode when live sessions are connected (no bounce)', async () => {
    const notify = vi.fn();
    const { code, out } = await tick({
      argv: ['refresh', '--auto', '--mode', 'idle'],
      ctx: ctx(autoRunner({ behind: 3 })),
      health: async () => ({ connections: 2, build: 'oldsha0' }),
      notify,
    });
    expect(code).toBe(0);
    expect(out).toContain('deferring refresh');
    expect(calls.some((x) => x.cmd === 'pnpm')).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('NOTIFIES then force-bounces under notice mode when live sessions are connected', async () => {
    const notify = vi.fn();
    const { code, out } = await tick({
      argv: ['refresh', '--auto', '--mode', 'notice'],
      ctx: ctx(autoRunner({ behind: 1 })),
      health: async () => ({ connections: 4, build: 'oldsha0' }),
      notify,
    });
    expect(code).toBe(0);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0].body).toMatch(/4 live sessions/);
    expect(calls.some((x) => x.cmd === 'pnpm' && x.args.includes('build'))).toBe(true);
    expect(out).toContain('restarted the musterd daemon');
  });

  it('debounces a tip whose build already failed (waits for a new commit)', async () => {
    const { code, out } = await tick({
      ctx: ctx(autoRunner({ behind: 2, tip: 'deadbeef99' })),
      health: async () => ({ connections: 0, build: 'oldsha0' }),
      autoState: memState('deadbeef99'), // already attempted this exact tip
    });
    expect(code).toBe(0);
    expect(out).toContain('already attempted');
    expect(calls.some((x) => x.cmd === 'pnpm')).toBe(false);
  });

  it('marks the attempted tip BEFORE building, so a build failure debounces next time', async () => {
    const state = memState(null);
    await expect(
      serviceCommand(parseArgs(['refresh', '--auto', '--mode', 'notice']), {
        platform: 'darwin',
        ctx: ctx(autoRunner({ behind: 1, tip: 'freshtip77', buildStatus: 1 })),
        health: async () => ({ connections: 0, build: 'oldsha0' }),
        autoState: state,
      }),
    ).rejects.toThrow(/build failed/);
    expect(state.write).toHaveBeenCalledWith('freshtip77');
  });

  it('no-ops when the daemon is unreachable (watcher, never gatekeeper)', async () => {
    const { code, out } = await tick({
      ctx: ctx(autoRunner({ behind: 5 })),
      health: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(code).toBe(0);
    expect(out).toContain('unreachable');
    expect(calls.some((x) => x.cmd === 'pnpm')).toBe(false);
  });
});

describe('service <verb> --auto (lifecycle dispatch)', () => {
  let dir: string;
  const runner: Runner = (): RunResult => ({ status: 0, stdout: '', stderr: '' });

  const daemonCtx = (): ServiceCtx => ({
    uid: 501,
    label: 'studio.sandrise.musterd',
    plistPath: join(dir, 'agent.plist'),
    node: '/n',
    binJs: '/repo/packages/cli/dist/bin.js',
    serveArgs: ['serve'],
    workingDir: '/repo',
    stdoutPath: '/l',
    stderrPath: '/e',
    path: '/p',
    run: runner,
    sleep: () => {},
    readFile: () => null,
  });

  const arCtx = (): AutoRefreshCtx => ({
    uid: 501,
    label: AUTOREFRESH_LABEL,
    plistPath: join(dir, 'LaunchAgents', `${AUTOREFRESH_LABEL}.plist`),
    node: '/n',
    binJs: '/repo/packages/cli/dist/bin.js',
    refreshArgs: ['refresh', '--auto', '--mode', 'idle'],
    workingDir: '/repo',
    logPath: join(dir, 'musterd', 'autorefresh', 'refresh.log'),
    errLogPath: join(dir, 'musterd', 'autorefresh', 'refresh.log'),
    path: '/p',
    intervalSeconds: 90,
    run: runner,
    sleep: () => undefined,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autorefresh-dispatch-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('install --auto writes the auto-refresher plist and reports the cadence + mode', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    let code: number;
    try {
      code = await serviceCommand(parseArgs(['install', '--auto', '--mode', 'idle']), {
        platform: 'darwin',
        ctx: daemonCtx(),
        autoRefreshCtx: arCtx(),
      });
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join('');
    expect(code).toBe(0);
    const plistPath = join(dir, 'LaunchAgents', `${AUTOREFRESH_LABEL}.plist`);
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(plistPath, 'utf8')).toContain('<string>--auto</string>');
    expect(out).toContain('installed + started the daemon auto-refresher');
    expect(out).toContain('every 90s');
    expect(out).toContain('idle only'); // the mode's quiet-period summary
  });
});
