import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensurePinnedMusterd,
  inspectWakeMusterd,
  owningPackageName,
  pinnedPath,
  wakeEnv,
} from './pinnedBin.js';

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

describe('owningPackageName', () => {
  it('names the package a file belongs to, and is undefined when it cannot tell', () => {
    const pkg = join(home, 'node_modules', 'thing');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'thing' }));
    writeFileSync(join(pkg, 'dist', 'entry.js'), '');
    expect(owningPackageName(join(pkg, 'dist', 'entry.js'))).toBe('thing');
    // Nothing above it — "cannot tell", which callers must not read as "wrong".
    expect(owningPackageName('/nonexistent-root-xyz/dist/bin.js')).toBeUndefined();
  });
});

describe('ensurePinnedMusterd — refuses an entry that belongs to something else', () => {
  /**
   * The regression guard for the live incident of 2026-07-30: the shared shim was left exec'ing
   * tinypool's worker entry, because `process.argv[1]` under a test runner is the WORKER's entry and
   * the only check was `isAbsolute`. Every woken session then had a `musterd` on PATH that crashed.
   */
  const pkgEntry = (name: string): string => {
    const root = join(home, 'pkgs', name.replace(/[^a-z]/g, ''));
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name }));
    const entry = join(root, 'dist', 'bin.js');
    writeFileSync(entry, '');
    return entry;
  };

  it('refuses a foreign package’s entry — the tinypool case', () => {
    expect(ensurePinnedMusterd({ node: '/n/node', binJs: pkgEntry('tinypool') })).toBeUndefined();
    expect(existsSync(pinnedPath(join(home, 'bin')))).toBe(false);
  });

  it('still pins musterd’s own entry', () => {
    expect(ensurePinnedMusterd({ node: '/n/node', binJs: pkgEntry('@musterd/cli') })).toBe(
      join(home, 'bin'),
    );
  });

  it('still pins an UNIDENTIFIABLE entry — a stripped tarball must not lose the pin', () => {
    // #516 exists partly for installs with no package.json above the entry. Failing closed there
    // would silently restore PATH roulette for exactly those users, which is worse than the risk.
    expect(ensurePinnedMusterd({ node: '/n/node', binJs: '/opt/strays/bin.js' })).toBe(
      join(home, 'bin'),
    );
  });
});

describe('inspectWakeMusterd — what a woken session’s `musterd` would actually be', () => {
  const shimBody = (node: string, bin: string) => `#!/bin/sh\nexec "${node}" "${bin}" "$@"\n`;

  it('is silent when there is no shim — that is the un-pinned fallback, not a fault', () => {
    const w = inspectWakeMusterd({ dir: '/pin', exists: () => false });
    expect(w.problem).toBeUndefined();
    expect(w.shim).toBe('/pin/musterd');
  });

  it('is silent when the shim execs a real musterd', () => {
    const w = inspectWakeMusterd({
      dir: '/pin',
      exists: () => true,
      read: () => shimBody('/n/node', '/live/dist/bin.js'),
      owner: () => '@musterd/cli',
    });
    expect(w.problem).toBeUndefined();
    expect(w.binJs).toBe('/live/dist/bin.js');
  });

  it('names the foreign package when the shim was poisoned', () => {
    const w = inspectWakeMusterd({
      dir: '/pin',
      exists: () => true,
      read: () => shimBody('/n/node', '/x/tinypool/dist/entry/process.js'),
      owner: () => 'tinypool',
    });
    expect(w.problem).toContain('tinypool');
    expect(w.problem).toContain('not musterd');
  });

  it('reports a missing entry and a missing interpreter distinctly', () => {
    const gone = inspectWakeMusterd({
      dir: '/pin',
      exists: (p) => p !== '/live/dist/bin.js',
      read: () => shimBody('/n/node', '/live/dist/bin.js'),
      owner: () => '@musterd/cli',
    });
    expect(gone.problem).toContain('/live/dist/bin.js) is missing');

    const noNode = inspectWakeMusterd({
      dir: '/pin',
      exists: (p) => p !== '/n/node',
      read: () => shimBody('/n/node', '/live/dist/bin.js'),
      owner: () => '@musterd/cli',
    });
    expect(noNode.problem).toContain('interpreter /n/node is missing');
  });

  it('reports a shim that is not ours rather than guessing', () => {
    const w = inspectWakeMusterd({
      dir: '/pin',
      exists: () => true,
      read: () => '#!/bin/sh\necho hello\n',
      owner: () => '@musterd/cli',
    });
    expect(w.problem).toContain('not in the expected exec form');
  });
});
