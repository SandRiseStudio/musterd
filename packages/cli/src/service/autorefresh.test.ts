import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installAutoRefresh,
  refreshAutoRefresh,
  statusAutoRefresh,
  stopAutoRefresh,
  uninstallAutoRefresh,
  type AutoRefreshCtx,
} from './autorefresh.js';
import { AUTOREFRESH_LABEL, buildAutoRefreshPlist } from './launchd.js';
import type { RunResult, Runner } from './manage.js';

/**
 * The daemon auto-refresher as a LaunchAgent (ADR 118/130 fast-follow) — exercised through the
 * injected runner + a temp dir. The plist invariants matter most: it must run `node bin.js service
 * refresh --auto …` (the tick, never `serve`), it must be StartInterval + NOT KeepAlive (the tick
 * runs and exits — a KeepAlive would relaunch it in a tight loop), and it must use the DEDICATED
 * label (a collision with the daemon's would boot the daemon out on `install --auto`).
 */

describe('buildAutoRefreshPlist', () => {
  const plist = buildAutoRefreshPlist({
    label: AUTOREFRESH_LABEL,
    node: '/opt/homebrew/bin/node',
    binJs: '/Users/nick/agents/packages/cli/dist/bin.js',
    refreshArgs: ['refresh', '--auto', '--mode', 'notice'],
    workingDir: '/Users/nick/agents',
    stdoutPath: '/Users/nick/.musterd/autorefresh/refresh.log',
    stderrPath: '/Users/nick/.musterd/autorefresh/refresh.log',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
    intervalSeconds: 120,
  });

  it('runs `node bin.js service refresh --auto` — the tick, never the daemon', () => {
    expect(plist).toContain('<string>service</string>');
    expect(plist).toContain('<string>refresh</string>');
    expect(plist).toContain('<string>--auto</string>');
    expect(plist).not.toContain('<string>serve</string>');
    const order =
      plist.indexOf('dist/bin.js') < plist.indexOf('<string>service</string>') &&
      plist.indexOf('<string>service</string>') < plist.indexOf('<string>refresh</string>') &&
      plist.indexOf('<string>refresh</string>') < plist.indexOf('<string>--auto</string>');
    expect(order).toBe(true);
  });

  it('is StartInterval + RunAtLoad and NOT KeepAlive, under its own label', () => {
    expect(plist).toContain(`<string>${AUTOREFRESH_LABEL}</string>`);
    expect(AUTOREFRESH_LABEL).not.toBe('studio.sandrise.musterd');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>120</integer>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });

  it('carries PATH so the tick can find git + pnpm (launchd default is minimal)', () => {
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('/opt/homebrew/bin');
  });
});

describe('auto-refresher lifecycle (injected runner, temp dir)', () => {
  let dir: string;
  let calls: { cmd: string; args: string[] }[];
  const runner: Runner = (cmd, args): RunResult => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '', stderr: '' };
  };
  const ctx = (): AutoRefreshCtx => ({
    uid: 501,
    label: AUTOREFRESH_LABEL,
    plistPath: join(dir, 'LaunchAgents', `${AUTOREFRESH_LABEL}.plist`),
    node: '/fake/node',
    binJs: '/fake/bin.js',
    refreshArgs: ['refresh', '--auto', '--mode', 'notice'],
    workingDir: '/fake/repo',
    logPath: join(dir, 'musterd', 'autorefresh', 'refresh.log'),
    errLogPath: join(dir, 'musterd', 'autorefresh', 'refresh.log'),
    path: '/fake/bin',
    intervalSeconds: 120,
    run: runner,
    sleep: () => undefined,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autorefresh-'));
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('install writes the plist and boots it (bootout-then-bootstrap); uninstall removes it', () => {
    const c = ctx();
    const res = installAutoRefresh(c);
    expect(res.status).toBe(0);
    expect(existsSync(c.plistPath)).toBe(true);
    expect(readFileSync(c.plistPath, 'utf8')).toContain('<string>--auto</string>');
    expect(calls.map((x) => x.args[0])).toEqual(['bootout', 'bootstrap']);

    calls = [];
    const un = uninstallAutoRefresh(c);
    expect(un.removedPlist).toBe(true);
    expect(existsSync(c.plistPath)).toBe(false);
    expect(uninstallAutoRefresh(c).removedPlist).toBe(false); // idempotent
  });

  it('restart kickstarts (a tick runs now); stop boots out; status parses launchctl print', () => {
    const c = ctx();
    installAutoRefresh(c);
    calls = [];
    refreshAutoRefresh(c);
    expect(calls[0]!.args.slice(0, 2)).toEqual(['kickstart', '-k']);

    calls = [];
    stopAutoRefresh(c);
    expect(calls[0]!.args[0]).toBe('bootout');
    expect(existsSync(c.plistPath)).toBe(true);

    const s = statusAutoRefresh({
      ...c,
      run: () => ({ status: 0, stdout: 'state = waiting\npid = 0\n', stderr: '' }),
    });
    expect(s.loaded).toBe(true);
    expect(s.state).toBe('waiting');
  });
});
