import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STREAMWATCH_LABEL, buildStreamwatchPlist } from './launchd.js';
import type { RunResult, Runner } from './manage.js';
import {
  DEFAULT_STREAMWATCH_INTERVAL,
  installStreamwatch,
  statusStreamwatch,
  uninstallStreamwatch,
  type StreamwatchCtx,
} from './streamwatch.js';

/**
 * The stream supervisor as a LaunchAgent (ADR 293) — the sweep's shape: StartInterval (one
 * reconcile pass, then exit), a dedicated label, injected runner + temp dir so tests never touch
 * launchctl or ~/Library.
 */

describe('buildStreamwatchPlist', () => {
  const plist = buildStreamwatchPlist({
    label: STREAMWATCH_LABEL,
    node: '/opt/homebrew/bin/node',
    binJs: '/Users/nick/agents/packages/cli/dist/bin.js',
    workingDir: '/Users/nick/agents',
    stdoutPath: '/Users/nick/.musterd/stream/ensure.log',
    stderrPath: '/Users/nick/.musterd/stream/ensure.log',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
    intervalSeconds: DEFAULT_STREAMWATCH_INTERVAL,
  });

  it('runs `stream ensure` — the reconcile verb, never a daemon verb', () => {
    expect(plist).toContain('<string>stream</string>');
    expect(plist).toContain('<string>ensure</string>');
    expect(plist).not.toContain('<string>serve</string>');
  });

  it('is StartInterval + RunAtLoad and NOT KeepAlive, under its own label', () => {
    expect(plist).toContain(`<string>${STREAMWATCH_LABEL}</string>`);
    expect(STREAMWATCH_LABEL).not.toBe('studio.sandrise.musterd');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });

  it('ticks every 60s — a crash costs at most a minute of dead air plus the boot', () => {
    expect(DEFAULT_STREAMWATCH_INTERVAL).toBe(60);
    expect(plist).toContain(`<integer>${DEFAULT_STREAMWATCH_INTERVAL}</integer>`);
  });
});

describe('streamwatch lifecycle', () => {
  let dir: string;
  let calls: string[][];
  const run: Runner = (cmd, args): RunResult => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: '', stderr: '' };
  };

  function ctx(): StreamwatchCtx {
    return {
      uid: 501,
      label: STREAMWATCH_LABEL,
      plistPath: join(dir, `${STREAMWATCH_LABEL}.plist`),
      node: '/opt/homebrew/bin/node',
      binJs: '/Users/nick/agents/packages/cli/dist/bin.js',
      workingDir: '/Users/nick/agents',
      logPath: join(dir, 'ensure.log'),
      errLogPath: join(dir, 'ensure.log'),
      path: '/usr/bin:/bin',
      intervalSeconds: DEFAULT_STREAMWATCH_INTERVAL,
      run,
      sleep: () => {},
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-streamwatch-'));
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('install writes the plist and bootstraps it', () => {
    const res = installStreamwatch(ctx());
    expect(res.status).toBe(0);
    const xml = readFileSync(ctx().plistPath, 'utf8');
    expect(xml).toContain('<string>ensure</string>');
    expect(calls.some((c) => c[1] === 'bootstrap')).toBe(true);
  });

  it('uninstall boots out and removes the plist', () => {
    installStreamwatch(ctx());
    const r = uninstallStreamwatch(ctx());
    expect(r.removedPlist).toBe(true);
    expect(existsSync(ctx().plistPath)).toBe(false);
  });

  it('status parses launchctl print through the shared parser', () => {
    const st = statusStreamwatch(ctx());
    expect(typeof st.loaded).toBe('boolean');
  });
});
