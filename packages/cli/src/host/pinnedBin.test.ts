import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePinnedMusterd, pinnedPath, wakeEnv } from './pinnedBin.js';

/**
 * A woken session's hooks call a BARE `musterd` (`command -v musterd && musterd …`), so PATH alone
 * decides which build runs. On the dogfood machine that resolved the Homebrew 0.3.1 tarball — 147
 * commits behind the live dist — because the host LaunchAgent's PATH carries `/opt/homebrew/bin` and
 * no pnpm entry. These tests pin the invariant that replaced PATH roulette: the wake exports the
 * binary the ACTUATOR is running, so a woken session's musterd is the same build by construction.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'musterd-pinned-'));
  process.env['MUSTERD_CONFIG'] = join(home, 'config.json');
});

afterEach(() => {
  delete process.env['MUSTERD_CONFIG'];
});

describe('ensurePinnedMusterd', () => {
  it('writes an executable shim that execs the actuator’s own node + entry', () => {
    const dir = ensurePinnedMusterd({ node: '/opt/node/bin/node', binJs: '/live/dist/bin.js' });

    expect(dir).toBe(join(home, 'bin'));
    const shim = readFileSync(pinnedPath(dir!), 'utf8');
    expect(shim).toContain('/opt/node/bin/node');
    expect(shim).toContain('/live/dist/bin.js');
    expect(shim).toContain('"$@"'); // args pass through untouched
    // Executable, or `command -v` never finds it.
    expect(statSync(pinnedPath(dir!)).mode & 0o111).toBeTruthy();
  });

  it('is idempotent: a second call with the same pair rewrites nothing', () => {
    const dir = ensurePinnedMusterd({ node: '/n/node', binJs: '/d/bin.js' })!;
    const first = statSync(pinnedPath(dir)).mtimeMs;
    const again = ensurePinnedMusterd({ node: '/n/node', binJs: '/d/bin.js' });
    expect(again).toBe(dir);
    expect(statSync(pinnedPath(dir)).mtimeMs).toBe(first);
  });

  it('rewrites when the actuator’s entry moves — the pin follows the running build', () => {
    const dir = ensurePinnedMusterd({ node: '/n/node', binJs: '/old/bin.js' })!;
    ensurePinnedMusterd({ node: '/n/node', binJs: '/new/bin.js' });
    const shim = readFileSync(pinnedPath(dir), 'utf8');
    expect(shim).toContain('/new/bin.js');
    expect(shim).not.toContain('/old/bin.js');
  });

  it('returns undefined rather than throwing when the dir cannot be created', () => {
    // A FILE where the bin dir must go: mkdir fails, and a wake must not die for it.
    writeFileSync(join(home, 'bin'), 'not a dir');
    expect(ensurePinnedMusterd({ node: '/n/node', binJs: '/d/bin.js' })).toBeUndefined();
  });

  it('refuses to pin a non-absolute entry — a relative argv[1] would resolve against the SEAT’s cwd', () => {
    expect(ensurePinnedMusterd({ node: 'node', binJs: 'dist/bin.js' })).toBeUndefined();
    expect(existsSync(join(home, 'bin', 'musterd'))).toBe(false);
  });
});

describe('wakeEnv', () => {
  const HOST_PATH = '/opt/homebrew/Cellar/node@22/22.23.1/bin:/opt/homebrew/bin:/usr/bin:/bin';

  it('PREPENDS the pin — appending would lose to the frozen tarball already on the host PATH', () => {
    const env = wakeEnv({ PATH: HOST_PATH }, '/home/.musterd/bin');
    expect(env['PATH']).toBe(`/home/.musterd/bin:${HOST_PATH}`);
    expect(env['PATH']!.indexOf('/home/.musterd/bin')).toBeLessThan(
      env['PATH']!.indexOf('/opt/homebrew/bin'),
    );
  });

  it('keeps wake provenance in the env, never argv (ADR 131 §6)', () => {
    expect(wakeEnv({ PATH: HOST_PATH }, '/pin')['MUSTERD_PROVENANCE']).toBe('wake');
    expect(wakeEnv({ PATH: HOST_PATH }, undefined)['MUSTERD_PROVENANCE']).toBe('wake');
  });

  it('leaves PATH untouched when the pin could not be written — degraded, never dead', () => {
    expect(wakeEnv({ PATH: HOST_PATH }, undefined)['PATH']).toBe(HOST_PATH);
  });

  it('survives an env with no PATH at all', () => {
    expect(wakeEnv({}, '/pin')['PATH']).toBe('/pin');
  });

  it('passes the rest of the inherited env through', () => {
    expect(wakeEnv({ PATH: HOST_PATH, HOME: '/h' }, '/pin')['HOME']).toBe('/h');
  });
});
