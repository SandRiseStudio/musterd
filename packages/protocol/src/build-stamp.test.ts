import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBuildStamp } from './build-stamp.js';

// All fixtures are temp dirs shaped like a package (package.json + dist/build.json). Never read the
// repo's real ambient dist/build.json — a dev worktree has one, and asserting on it would couple the
// test to whatever was last built.
describe('readBuildStamp (ADR 135)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-stamp-'));
    writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'src', 'commands'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const at = (rel: string) => pathToFileURL(join(root, rel)).href;

  it('returns the stamped ref for a caller one level under the package root', () => {
    writeFileSync(join(root, 'dist', 'build.json'), JSON.stringify({ ref: 'a'.repeat(40) }));
    expect(readBuildStamp(at('src/build-stamp.ts'))).toBe('a'.repeat(40));
  });

  it('walks up from a nested caller (commands/serve.ts is two levels deep)', () => {
    writeFileSync(join(root, 'dist', 'build.json'), JSON.stringify({ ref: 'b'.repeat(40) }));
    expect(readBuildStamp(at('src/commands/serve.ts'))).toBe('b'.repeat(40));
  });

  it('keeps a -dirty suffix and caps at 64 chars', () => {
    writeFileSync(
      join(root, 'dist', 'build.json'),
      JSON.stringify({ ref: 'c'.repeat(40) + '-dirty' }),
    );
    expect(readBuildStamp(at('src/build-stamp.ts'))).toBe('c'.repeat(40) + '-dirty');
    writeFileSync(join(root, 'dist', 'build.json'), JSON.stringify({ ref: 'd'.repeat(100) }));
    expect(readBuildStamp(at('src/build-stamp.ts'))).toHaveLength(64);
  });

  it('returns undefined for ref:null (stamped outside a git checkout)', () => {
    writeFileSync(join(root, 'dist', 'build.json'), JSON.stringify({ ref: null }));
    expect(readBuildStamp(at('src/build-stamp.ts'))).toBeUndefined();
  });

  it('returns undefined when the stamp file is missing or malformed', () => {
    expect(readBuildStamp(at('src/build-stamp.ts'))).toBeUndefined(); // no build.json at all
    writeFileSync(join(root, 'dist', 'build.json'), 'not json{{');
    expect(readBuildStamp(at('src/build-stamp.ts'))).toBeUndefined();
  });
});
