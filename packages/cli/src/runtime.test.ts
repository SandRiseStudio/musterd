/**
 * Runtime install boundary (ADR 156) — Node gate + packaged-vs-checkout detection.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GUIDANCE_CONTENT_VERSION } from '@musterd/protocol';
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
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('npm i -g @musterd/cli@latest');
    expect(notes[0]).toContain('brew upgrade musterd');
    expect(notes[0]).toContain('service refresh');
    // The third install kind. `isPackagedCliInstall` cannot tell a baked image from an npm global
    // — both are "no pnpm-workspace.yaml above the bin" — so a note that names only npm/brew tells
    // a cloud seat to run a command that is not how its machine gets a CLI at all (delta,
    // 2026-09-06). Naming one delivery path silently excludes every other.
    expect(notes[0]).toContain('redeploying the image');
  });

  // The doctor's guidance check compares each file's stamp against GUIDANCE_CONTENT_VERSION — the
  // constant compiled into the CLI doing the comparing — so it can never see a version that shipped
  // after this binary. On a checkout `buildSkewNotes` catches that via origin/main; a packaged
  // install has no checkout and (on a cloud VM) no differing daemon either, so nothing does. The
  // note has to say what the ✓ actually means, or a seat a version behind reads a green tick as
  // currency.
  it('names the guidance version as a ceiling on a packaged install', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'musterd-global-'));
    const bin = join(prefix, 'lib', 'node_modules', '@musterd', 'cli', 'dist', 'bin.js');
    mkdirSync(join(prefix, 'lib', 'node_modules', '@musterd', 'cli', 'dist'), { recursive: true });
    writeFileSync(bin, '');
    const ceiling = packagedInstallNotes(bin)[1]!;
    expect(ceiling).toContain(`guidance v${String(GUIDANCE_CONTENT_VERSION)}`);
    expect(ceiling).toContain('CEILING');
    // The ✓ must be disambiguated explicitly — this is the sentence the whole note exists for.
    expect(ceiling).toMatch(/matches this CLI.+NOT.+current with main/s);
    // ...and the repair named must be the one that works.
    expect(ceiling).toContain('the repair is a newer CLI, not a refresh');
  });

  // A checkout says none of this: there `buildSkewNotes` compares against origin/main and gives a
  // real answer, so a ceiling note would be noise.
  it('says nothing about the ceiling from a checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'musterd-checkout-'));
    const bin = join(root, 'packages', 'cli', 'dist', 'bin.js');
    mkdirSync(join(root, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), '');
    writeFileSync(bin, '');
    expect(packagedInstallNotes(bin)).toEqual([]);
  });
});
