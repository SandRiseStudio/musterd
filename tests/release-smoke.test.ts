import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PUBLISH_ORDER, type PublishPackageName } from '../scripts/release/helpers.ts';
import {
  probesFor,
  resolutionFailure,
  smokeConsumerInstall,
  smokeManifest,
} from '../scripts/release/smoke.ts';

/** The real thing 0.4.0 printed, kept verbatim — a paraphrase would not prove the matcher works. */
const REAL_0_4_0_OUTPUT = `
node:internal/modules/package_json_reader:314
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
        ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@modelcontextprotocol/client' imported from /private/tmp/smoke2/node_modules/@musterd/mcp/dist/surfaceMeasure.js
`;

/** What a HEALTHY adapter prints with no binding: it started, then refused for a real reason. */
const HEALTHY_NO_BINDING =
  'musterd MCP failed to start: musterd MCP: no team — set MUSTERD_TEAM or provide a .musterd/binding.json';

const tarballs = Object.fromEntries(
  PUBLISH_ORDER.map((n) => [n, `/tmp/pack/${n.replace('@musterd/', 'musterd-')}-0.4.1.tgz`]),
) as Record<PublishPackageName, string>;

describe('resolutionFailure', () => {
  it('catches the exact output 0.4.0 produced', () => {
    expect(resolutionFailure(REAL_0_4_0_OUTPUT)).toContain('@modelcontextprotocol/client');
  });

  it('does not fire on a healthy adapter refusing for want of a binding', () => {
    // The distinction the whole gate rests on: "started and declined" is success, and a probe that
    // confused the two would either block every release or pass a broken one.
    expect(resolutionFailure(HEALTHY_NO_BINDING)).toBeNull();
  });

  it('catches CJS and bare-module phrasings too, not just the ESM code', () => {
    expect(resolutionFailure("Error: Cannot find module 'ws'")).toContain('ws');
    expect(resolutionFailure("Cannot find package 'zod' imported from x.js")).toContain('zod');
  });

  it('is quiet on ordinary output', () => {
    expect(resolutionFailure('0.4.1')).toBeNull();
    expect(resolutionFailure('')).toBeNull();
  });
});

describe('smokeManifest', () => {
  const manifest = smokeManifest(tarballs) as {
    dependencies: Record<string, string>;
    overrides: Record<string, string>;
    private: boolean;
  };

  it('pins EVERY @musterd package to a local tarball', () => {
    // The load-bearing property: cli depends on mcp@<new version>, which does not exist on the
    // registry yet. Without a complete override map npm would fail — or worse, resolve the PREVIOUS
    // release and smoke the wrong code green.
    for (const name of PUBLISH_ORDER) {
      expect(manifest.overrides[name], `${name} unpinned`).toMatch(/^file:\/.*\.tgz$/);
    }
  });

  it('installs the two packages a user actually runs', () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['@musterd/cli', '@musterd/mcp']);
  });

  it('is private, so a stray publish from the temp dir is impossible', () => {
    expect(manifest.private).toBe(true);
  });
});

describe('probesFor', () => {
  it('asserts the CLI prints the version being released — the formula’s own test', () => {
    const cli = probesFor('9.9.9').find((p) => p.entry.includes('cli'))!;
    expect(cli.args).toEqual(['--version']);
    expect(cli.expect).toBe('9.9.9');
  });

  it('judges the adapter on loading, not on exiting cleanly', () => {
    const mcp = probesFor('9.9.9').find((p) => p.entry.includes('mcp'))!;
    expect(mcp.expect).toBeUndefined();
  });
});

describe('smokeConsumerInstall', () => {
  /** A fake shell: records commands, and returns whatever the probes are told to print. */
  function harness(probeOutput: (entry: string) => string) {
    const commands: string[][] = [];
    const logs: string[] = [];
    const run = vi.fn((cmd: string, args: string[]) => {
      commands.push([cmd, ...args]);
      if (cmd === 'pnpm' && args[0] === 'pack') return 'musterd-pkg-0.4.1.tgz\n';
      if (cmd === 'npm') return '';
      const entry = args[0] ?? '';
      const out = probeOutput(entry);
      if (out.startsWith('THROW:')) {
        const err = new Error('exit 1') as Error & { stdout: string; stderr: string };
        err.stdout = '';
        err.stderr = out.slice('THROW:'.length);
        throw err;
      }
      return out;
    });
    return { deps: { run, log: (l: string) => logs.push(l) }, commands, logs };
  }

  /** A throwaway repo root carrying just the one file the smoke reads: the CLI's version. */
  function fakeRoot(version: string): string {
    const root = mkdtempSync(join(tmpdir(), 'musterd-smoke-root-'));
    const dir = join(root, 'packages', 'cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
    return root;
  }

  it('packs with pnpm, never npm — npm leaves workspace:* in the tarball', () => {
    const h = harness((e) => (e.includes('cli') ? '0.4.1' : `THROW:${HEALTHY_NO_BINDING}`));
    smokeConsumerInstall(fakeRoot('0.4.1'), h.deps);
    const packs = h.commands.filter((c) => c[1] === 'pack');
    expect(packs).toHaveLength(PUBLISH_ORDER.length);
    for (const p of packs) expect(p[0]).toBe('pnpm');
  });

  it('passes when the adapter merely lacks a binding', () => {
    const h = harness((e) => (e.includes('cli') ? '0.4.1' : `THROW:${HEALTHY_NO_BINDING}`));
    expect(() => smokeConsumerInstall(fakeRoot('0.4.1'), h.deps)).not.toThrow();
    expect(h.logs.at(-1)).toContain('consumer smoke passed');
  });

  it('THROWS on the 0.4.0 defect — even though the process also exits non-zero', () => {
    const h = harness((e) => (e.includes('cli') ? '0.4.1' : `THROW:${REAL_0_4_0_OUTPUT}`));
    expect(() => smokeConsumerInstall(fakeRoot('0.4.1'), h.deps)).toThrow(
      /consumer smoke FAILED[\s\S]*@modelcontextprotocol\/client/,
    );
  });

  it('THROWS when the CLI runs but reports the wrong version', () => {
    const h = harness((e) => (e.includes('cli') ? '0.3.1' : `THROW:${HEALTHY_NO_BINDING}`));
    expect(() => smokeConsumerInstall(fakeRoot('0.4.1'), h.deps)).toThrow(
      /did not print "0\.4\.1"/,
    );
  });
});
