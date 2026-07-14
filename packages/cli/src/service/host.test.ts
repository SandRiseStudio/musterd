import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installWakeHost,
  statusWakeHost,
  stopWakeHost,
  uninstallWakeHost,
  type WakeHostCtx,
} from './host.js';
import { buildHostPlist, HOST_LABEL } from './launchd.js';
import type { RunResult, Runner } from './manage.js';

/**
 * The wake actuator as a LaunchAgent (ADR 131 inc 5) — exercised entirely through the injected
 * runner + a temp dir: no real launchctl, no writes outside the sandbox. The plist invariants
 * matter most: the argv must be `node bin.js host …` (never `serve`), KeepAlive must hold (the
 * loop runs forever — any exit is restart-worthy), and the label must be the DEDICATED host label
 * (a collision with the daemon's would boot the daemon out on install --wake).
 */

describe('buildHostPlist', () => {
  const plist = buildHostPlist({
    label: HOST_LABEL,
    node: '/opt/homebrew/bin/node',
    binJs: '/Users/nick/agents/packages/cli/dist/bin.js',
    hostArgs: ['--interval', '10', '--timeout', '300'],
    workingDir: '/Users/nick/agents',
    stdoutPath: '/Users/nick/.musterd/host.log',
    stderrPath: '/Users/nick/.musterd/host.err.log',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
  });

  it('runs `node bin.js host <flags>` — the actuator, never the daemon', () => {
    expect(plist).toContain('<string>host</string>');
    expect(plist).not.toContain('<string>serve</string>');
    const order =
      plist.indexOf('/node<') < plist.indexOf('dist/bin.js') &&
      plist.indexOf('dist/bin.js') < plist.indexOf('<string>host</string>') &&
      plist.indexOf('<string>host</string>') < plist.indexOf('<string>--interval</string>');
    expect(order).toBe(true);
  });

  it('is KeepAlive + RunAtLoad under its own label (reboot-safe, daemon untouched)', () => {
    expect(plist).toContain(`<string>${HOST_LABEL}</string>`);
    expect(HOST_LABEL).not.toBe('studio.sandrise.musterd');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>ThrottleInterval</key>');
  });

  it('carries PATH for the loop AND the harnesses it spawns (launchd default is minimal)', () => {
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('/opt/homebrew/bin');
  });
});

describe('wake host lifecycle (injected runner, temp dir)', () => {
  let dir: string;
  let calls: { cmd: string; args: string[] }[];
  const runner: Runner = (cmd, args): RunResult => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '', stderr: '' };
  };
  const ctx = (): WakeHostCtx => ({
    uid: 501,
    label: HOST_LABEL,
    plistPath: join(dir, 'LaunchAgents', `${HOST_LABEL}.plist`),
    node: '/fake/node',
    binJs: '/fake/bin.js',
    hostArgs: ['--timeout', '300'],
    workingDir: '/fake/repo',
    logPath: join(dir, 'musterd', 'host.log'),
    errLogPath: join(dir, 'musterd', 'host.err.log'),
    path: '/fake/bin',
    run: runner,
    sleep: () => undefined,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wake-host-'));
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('install writes the plist and boots it (bootout-then-bootstrap); uninstall removes it', () => {
    const c = ctx();
    const res = installWakeHost(c);
    expect(res.status).toBe(0);
    expect(existsSync(c.plistPath)).toBe(true);
    expect(readFileSync(c.plistPath, 'utf8')).toContain('<string>host</string>');
    expect(calls.map((x) => x.args[0])).toEqual(['bootout', 'bootstrap']);

    calls = [];
    const un = uninstallWakeHost(c);
    expect(un.removedPlist).toBe(true);
    expect(existsSync(c.plistPath)).toBe(false);
    // Uninstalling again is a clean no-op (idempotent).
    expect(uninstallWakeHost(c).removedPlist).toBe(false);
  });

  it('stop boots out without touching the plist; status parses launchctl print', () => {
    const c = ctx();
    installWakeHost(c);
    calls = [];
    stopWakeHost(c);
    expect(calls[0]!.args[0]).toBe('bootout');
    expect(existsSync(c.plistPath)).toBe(true);
    const s = statusWakeHost({
      ...c,
      run: () => ({ status: 0, stdout: 'state = running\npid = 4242\n', stderr: '' }),
    });
    expect(s.loaded).toBe(true);
    expect(s.pid).toBe(4242);
  });
});
