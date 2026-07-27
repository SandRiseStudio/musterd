import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { parsePlistEnvironment } from '../service/launchd.js';
import type { RunResult, ServiceCtx } from '../service/manage.js';
import { awaitDaemon, resolveDaemonEnv, serviceCommand, type DaemonHealth } from './service.js';

/**
 * `service install --allowed-hosts` (ADR 040) and the verified restart.
 *
 * The lane's headline bug is the second one: every bounce path used to report success off the
 * launchctl exit code, and on 2026-07-27 a bootout/bootstrap silently did not take, leaving the
 * daemon down ~2 minutes with a ✓ printed and the whole team offline.
 */

describe('resolveDaemonEnv', () => {
  const withHosts = `<plist><dict><key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/old/path</string>
    <key>MUSTERD_ALLOWED_HOSTS</key><string>old.ts.net</string>
  </dict></dict></plist>`;

  it('PRESERVES an allow-list nobody re-passed — a plain re-install must not break the overlay', () => {
    expect(resolveDaemonEnv(withHosts, undefined)).toEqual({
      MUSTERD_ALLOWED_HOSTS: 'old.ts.net',
    });
  });

  it('never carries PATH forward — it is recomputed from the running process each install', () => {
    expect(resolveDaemonEnv(withHosts, undefined)['PATH']).toBeUndefined();
  });

  it('the flag overrides, and normalises whitespace and empty entries', () => {
    expect(resolveDaemonEnv(withHosts, ' a.ts.net , ,100.64.0.1 ')).toEqual({
      MUSTERD_ALLOWED_HOSTS: 'a.ts.net,100.64.0.1',
    });
  });

  it('an empty value clears the list — the only way to undo one without editing the plist', () => {
    expect(resolveDaemonEnv(withHosts, '')).toEqual({});
  });

  it('is empty for a fresh machine with no installed plist', () => {
    expect(resolveDaemonEnv(null, undefined)).toEqual({});
  });
});

describe('awaitDaemon', () => {
  const sleep = (): Promise<void> => Promise.resolve();

  it('returns the health payload as soon as one poll succeeds', async () => {
    let calls = 0;
    const health = (): Promise<DaemonHealth> => {
      calls++;
      return calls < 3
        ? Promise.reject(new Error('refused'))
        : Promise.resolve({ build: 'abc123' });
    };
    expect(await awaitDaemon(health, { sleep, delayMs: 0 })).toEqual({ build: 'abc123' });
    expect(calls).toBe(3); // early polls failing is normal — launchd boots asynchronously
  });

  it('returns null when it never comes back, rather than throwing or hanging', async () => {
    const health = (): Promise<DaemonHealth> => Promise.reject(new Error('refused'));
    expect(await awaitDaemon(health, { sleep, delayMs: 0, tries: 3 })).toBeNull();
  });
});

describe('service install --allowed-hosts (end to end through the command)', () => {
  let dir: string;
  let ctx: ServiceCtx;
  const runner = (): RunResult => ({ status: 0, stdout: '', stderr: '' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-svc-hosts-'));
    ctx = {
      uid: 501,
      label: 'studio.sandrise.musterd',
      plistPath: join(dir, 'musterd.plist'),
      node: '/fake/node',
      binJs: '/fake/bin.js',
      serveArgs: ['serve'],
      workingDir: dir,
      stdoutPath: join(dir, 'daemon.log'),
      stderrPath: join(dir, 'daemon.err.log'),
      path: '/fake/bin',
      run: runner,
      sleep: () => undefined,
      readFile: (p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      },
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(argv: string[], health: () => Promise<DaemonHealth>): Promise<string> {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      await serviceCommand(parseArgs(argv), {
        platform: 'darwin',
        ctx,
        health,
        sleep: () => Promise.resolve(),
      });
      return chunks.join('');
    } finally {
      vi.restoreAllMocks();
    }
  }

  const up = (): Promise<DaemonHealth> => Promise.resolve({ build: 'deadbeefcafe' });
  /** Up for the baseline probe, then gone — the 2026-07-27 outage shape exactly. */
  const diesOnBounce = (): (() => Promise<DaemonHealth>) => {
    let first = true;
    return () => {
      if (first) {
        first = false;
        return Promise.resolve({ build: 'deadbeefcafe' });
      }
      return Promise.reject(new Error('connection refused'));
    };
  };
  /** Never reachable — cannot be distinguished from a daemon this CLI simply cannot see. */
  const unreachable = (): Promise<DaemonHealth> => Promise.reject(new Error('connection refused'));

  it('writes the allow-list into the plist beside PATH, and verifies the daemon came back', async () => {
    const out = await run(['install', '--allowed-hosts', 'a.ts.net,100.64.0.1'], up);
    const env = parsePlistEnvironment(readFileSync(ctx.plistPath, 'utf8'));
    expect(env?.['MUSTERD_ALLOWED_HOSTS']).toBe('a.ts.net,100.64.0.1');
    expect(env?.['PATH']).toBe('/fake/bin'); // merged, not clobbered
    expect(out).toContain('daemon answered /health');
  });

  it('a re-install without the flag KEEPS the allow-list', async () => {
    await run(['install', '--allowed-hosts', 'a.ts.net'], up);
    await run(['install'], up);
    expect(
      parsePlistEnvironment(readFileSync(ctx.plistPath, 'utf8'))?.['MUSTERD_ALLOWED_HOSTS'],
    ).toBe('a.ts.net');
  });

  it('FAILS LOUDLY with the restore command when a daemon that WAS up does not come back', async () => {
    // The 2026-07-27 outage: launchctl succeeds, daemon does not come back, ✓ printed anyway.
    await expect(run(['install'], diesOnBounce())).rejects.toThrow(/stopped answering \/health/);
    await expect(run(['install'], diesOnBounce())).rejects.toThrow(/launchctl bootstrap gui\/501/);
  });

  it('only WARNS when health was unreachable before the bounce too', async () => {
    // Cannot distinguish "down" from "this CLI cannot see it" (a daemon bound off-loopback — the
    // overlay case this lane is about), so it must not hard-fail a possibly-healthy system. This
    // preserves the pre-existing fail-open contract for an unreachable daemon.
    const out = await run(['install'], unreachable);
    expect(out).toContain('could not confirm the daemon');
    expect(out).not.toContain('daemon answered /health');
  });

  it('restart verifies too, not just install', async () => {
    await expect(run(['restart', '--force'], diesOnBounce())).rejects.toThrow(
      /stopped answering \/health/,
    );
    expect(await run(['restart', '--force'], up)).toContain('daemon answered /health');
  });

  it('status reports the effective allow-list, labelled as plist-derived', async () => {
    await run(['install', '--allowed-hosts', 'a.ts.net'], up);
    const out = await run(['status'], up);
    expect(out).toContain('a.ts.net');
    expect(out).toContain('plist-derived');
  });
});
