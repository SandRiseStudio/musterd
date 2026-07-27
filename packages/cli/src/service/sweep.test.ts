import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSweepPlist, SWEEP_LABEL } from './launchd.js';
import type { RunResult, Runner } from './manage.js';
import {
  DEFAULT_SWEEP_INTERVAL,
  installSweep,
  refreshSweep,
  statusSweep,
  stopSweep,
  uninstallSweep,
  type SweepCtx,
} from './sweep.js';

/**
 * The ADR 166 liveness sweep as a LaunchAgent — exercised through the injected runner + a temp dir.
 * The plist invariants carry the design: StartInterval (one pass, then exit — a KeepAlive would
 * spin), a dedicated label (a collision would boot out the daemon on `install --sweep`), and a
 * cadence at or under the 600s window a demotion is guaranteed to persist for.
 */

describe('buildSweepPlist', () => {
  const plist = buildSweepPlist({
    label: SWEEP_LABEL,
    node: '/opt/homebrew/bin/node',
    scriptPath: '/Users/nick/agents/scripts/research/adr-166-slot-sweep.ts',
    scriptArgs: ['--quiet'],
    workingDir: '/Users/nick/agents',
    stdoutPath: '/Users/nick/.musterd/research/sweep.log',
    stderrPath: '/Users/nick/.musterd/research/sweep.log',
    path: '/opt/homebrew/bin:/usr/bin:/bin',
    intervalSeconds: DEFAULT_SWEEP_INTERVAL,
  });

  it('runs the research script the ADR names — never a daemon verb', () => {
    expect(plist).toContain('<string>/Users/nick/agents/scripts/research/adr-166-slot-sweep.ts');
    expect(plist).toContain('<string>--quiet</string>');
    expect(plist).not.toContain('<string>serve</string>');
    // The type-stripping flag must precede the script path or Node 22 refuses the .ts entry.
    expect(plist.indexOf('--disable-warning=ExperimentalWarning')).toBeLessThan(
      plist.indexOf('adr-166-slot-sweep.ts'),
    );
  });

  it('is StartInterval + RunAtLoad and NOT KeepAlive, under its own label', () => {
    expect(plist).toContain(`<string>${SWEEP_LABEL}</string>`);
    expect(SWEEP_LABEL).not.toBe('studio.sandrise.musterd');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });

  it('defaults to a cadence that cannot miss a demotion', () => {
    // A demoted case persists ≥ LOCAL_SESSION_LIVE_MS (600s) from the last touch of the slot's
    // transcript. Sampling slower than that turns ADR 166's "target: zero" into an unfalsifiable
    // claim, so this bound is part of the design, not a preference.
    expect(DEFAULT_SWEEP_INTERVAL).toBeLessThanOrEqual(600);
    expect(plist).toContain(`<integer>${DEFAULT_SWEEP_INTERVAL}</integer>`);
  });
});

describe('sweep lifecycle (injected runner, temp dir)', () => {
  let dir: string;
  let calls: { cmd: string; args: string[] }[];
  const runner: Runner = (cmd, args): RunResult => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '', stderr: '' };
  };
  const ctx = (): SweepCtx => ({
    uid: 501,
    label: SWEEP_LABEL,
    plistPath: join(dir, 'LaunchAgents', `${SWEEP_LABEL}.plist`),
    node: '/fake/node',
    scriptPath: '/fake/repo/scripts/research/adr-166-slot-sweep.ts',
    scriptArgs: ['--quiet'],
    workingDir: '/fake/repo',
    logPath: join(dir, 'musterd', 'research', 'sweep.log'),
    errLogPath: join(dir, 'musterd', 'research', 'sweep.log'),
    path: '/fake/bin',
    intervalSeconds: DEFAULT_SWEEP_INTERVAL,
    run: runner,
    sleep: () => undefined,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-sweep-svc-'));
    calls = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('install writes the plist and boots it (bootout-then-bootstrap); uninstall removes it', () => {
    const c = ctx();
    expect(installSweep(c).status).toBe(0);
    expect(existsSync(c.plistPath)).toBe(true);
    expect(readFileSync(c.plistPath, 'utf8')).toContain('adr-166-slot-sweep.ts');
    expect(calls.map((x) => x.args[0])).toEqual(['bootout', 'bootstrap']);

    const un = uninstallSweep(c);
    expect(un.removedPlist).toBe(true);
    expect(existsSync(c.plistPath)).toBe(false);
    expect(uninstallSweep(c).removedPlist).toBe(false); // idempotent
  });

  it('restart kickstarts (a sweep runs now); stop boots out; status parses launchctl print', () => {
    const c = ctx();
    installSweep(c);
    calls = [];
    refreshSweep(c);
    expect(calls[0]!.args.slice(0, 2)).toEqual(['kickstart', '-k']);

    calls = [];
    stopSweep(c);
    expect(calls[0]!.args[0]).toBe('bootout');
    expect(existsSync(c.plistPath)).toBe(true); // stop keeps the plist

    const s = statusSweep({
      ...c,
      run: () => ({ status: 0, stdout: 'state = waiting\npid = 0\n', stderr: '' }),
    });
    expect(s.loaded).toBe(true);
    expect(s.state).toBe('waiting');
  });
});
