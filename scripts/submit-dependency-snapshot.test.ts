import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, npmPurl, parsePnpmLock } from './submit-dependency-snapshot.js';

const FIXTURE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.7.0
        version: 5.7.3

packages:

  '@babel/code-frame@7.26.2':
    resolution: {integrity: sha512-x}

  postcss@8.5.26:
    resolution: {integrity: sha512-y}

  'vite@5.4.11(@types/node@22.10.0)':
    resolution: {integrity: sha512-z}

  vite@5.4.11(postcss@8.5.26):
    resolution: {integrity: sha512-z}

snapshots:

  postcss@8.5.26: {}
`;

describe('parsePnpmLock', () => {
  it('reads every packages: key — scoped, quoted, peer-suffixed — and dedupes peer variants', () => {
    const pkgs = parsePnpmLock(FIXTURE);
    expect(pkgs).toEqual([
      { name: '@babel/code-frame', version: '7.26.2' },
      { name: 'postcss', version: '8.5.26' },
      { name: 'vite', version: '5.4.11' },
    ]);
  });

  it('never reads importers or snapshots sections as packages', () => {
    const names = parsePnpmLock(FIXTURE).map((p) => p.name);
    expect(names).not.toContain('typescript');
    expect(names.filter((n) => n === 'postcss')).toHaveLength(1);
  });

  it('parses the real lockfile to hundreds of packages, postcss among them', () => {
    const real = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
    const pkgs = parsePnpmLock(real);
    expect(pkgs.length).toBeGreaterThan(100);
    expect(pkgs.some((p) => p.name === 'postcss')).toBe(true);
    // Every parse must yield purl-able pairs — no empty names or versions, ever.
    for (const p of pkgs) {
      expect(p.name).toBeTruthy();
      expect(p.version).toMatch(/^\d/);
    }
  });
});

describe('npmPurl', () => {
  it('percent-encodes the scope @ per the purl spec', () => {
    expect(npmPurl({ name: '@babel/code-frame', version: '7.26.2' })).toBe(
      'pkg:npm/%40babel/code-frame@7.26.2',
    );
    expect(npmPurl({ name: 'postcss', version: '8.5.26' })).toBe('pkg:npm/postcss@8.5.26');
  });
});

describe('buildSnapshot', () => {
  it('shapes the dependency-submission body with one pnpm-lock.yaml manifest', () => {
    const snap = buildSnapshot(parsePnpmLock(FIXTURE), {
      sha: 'a'.repeat(40),
      ref: 'refs/heads/main',
      runId: 'run-1',
      scanned: '2026-08-20T00:00:00.000Z',
    }) as {
      version: number;
      sha: string;
      manifests: Record<string, { resolved: Record<string, { package_url: string }> }>;
    };
    expect(snap.version).toBe(0);
    expect(snap.sha).toBe('a'.repeat(40));
    const resolved = snap.manifests['pnpm-lock.yaml']!.resolved;
    expect(resolved['postcss@8.5.26']).toEqual({ package_url: 'pkg:npm/postcss@8.5.26' });
    expect(Object.keys(resolved)).toHaveLength(3);
  });
});
