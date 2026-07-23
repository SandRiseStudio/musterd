/**
 * Runtime install boundary (ADR 156) — Node gate + packaged-vs-checkout detection.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIN_NODE_MAJOR,
  isPackagedCliInstall,
  nodeUpgradeHint,
  nodeVersionTooOld,
  packagedInstallNotes,
} from './runtime.js';

describe('runtime Node gate (ADR 156)', () => {
  it(`refuses Node major below ${MIN_NODE_MAJOR}`, () => {
    const msg = nodeVersionTooOld('v20.11.0');
    expect(msg).toContain(`Node >=${MIN_NODE_MAJOR}`);
    expect(msg).toContain('v20.11.0');
    expect(msg).toContain(nodeUpgradeHint());
  });

  it(`allows Node ${MIN_NODE_MAJOR}+`, () => {
    expect(nodeVersionTooOld('v22.0.0')).toBeNull();
    expect(nodeVersionTooOld('v24.1.0')).toBeNull();
  });
});

describe('packaged install detection (ADR 156)', () => {
  it('treats a monorepo checkout bin path as not packaged', () => {
    const root = mkdtempSync(join(tmpdir(), 'musterd-checkout-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const bin = join(root, 'packages', 'cli', 'dist', 'bin.js');
    mkdirSync(join(root, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(bin, '');
    expect(isPackagedCliInstall(bin)).toBe(false);
    expect(packagedInstallNotes(bin)).toEqual([]);
  });

  it('treats a global-style node_modules path as packaged', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'musterd-global-'));
    const bin = join(prefix, 'lib', 'node_modules', '@musterd', 'cli', 'dist', 'bin.js');
    mkdirSync(join(prefix, 'lib', 'node_modules', '@musterd', 'cli', 'dist'), { recursive: true });
    writeFileSync(bin, '');
    expect(isPackagedCliInstall(bin)).toBe(true);
    const notes = packagedInstallNotes(bin);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('npm i -g @musterd/cli@latest');
    expect(notes[0]).toContain('brew upgrade musterd');
    expect(notes[0]).toContain('service refresh');
  });
});
