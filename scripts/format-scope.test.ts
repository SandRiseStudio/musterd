import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FORMAT_GLOBS } from './format-scope.ts';

/**
 * The invariant (ADR 284): **Prettier's writer scope equals its checker scope.**
 *
 * `scripts/format.ts` makes that true by construction — one list, two modes. These tests exist to
 * stop the construction being quietly dismantled, which is the only way the defect can return: a
 * seat in a hurry puts a raw `prettier --write <glob>` back into package.json, and 207 files start
 * moving again with nothing to report it.
 *
 * The original defect, for the record: `format` wrote `**\/*.{ts,js,mjs,json,md}` while
 * `format:check` verified `packages/**\/*.ts`, `tests/**\/*.ts` and `*.{ts,json}`.
 */

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('the format scripts share one scope (ADR 284)', () => {
  it('both go through the single runner, so neither can carry a glob of its own', () => {
    // The substantive assertion: no glob literal in either script. A glob here is a second list.
    expect(pkg.scripts['format']).toBe('node scripts/format.ts --write');
    expect(pkg.scripts['format:check']).toMatch(/^node scripts\/format\.ts --check(?: &&|$)/);
  });

  it('neither script invokes prettier directly', () => {
    // `prettier --write` in package.json is exactly how the writer outgrew the checker before.
    expect(pkg.scripts['format']).not.toContain('prettier');
    expect(pkg.scripts['format:check']).not.toContain('prettier');
  });

  it('governs the source trees, and NOT the prose corpus', () => {
    expect(FORMAT_GLOBS).toContain('packages/**/*.ts');
    expect(FORMAT_GLOBS).toContain('scripts/**/*.{ts,mjs}');
    // docs/ is the decision spine: ADRs freeze on acceptance and wiki claims carry dates and
    // falsifiers. A reflow rewrites blame for arguments nobody was editing.
    for (const g of FORMAT_GLOBS) {
      expect(g.startsWith('docs/')).toBe(false);
      expect(g).not.toBe('**/*.{ts,js,mjs,json,md}');
      // No glob may reach markdown at all — that is the class of file this scope excludes.
      expect(g).not.toContain('md');
    }
  });

  it('keeps .prettierignore as the backstop for invocations this list cannot see', () => {
    // A bare `npx prettier --write .` or an editor's format-on-save never reads FORMAT_GLOBS.
    const ignore = readFileSync(new URL('../.prettierignore', import.meta.url), 'utf8');
    const lines = ignore.split('\n').map((l) => l.trim());
    for (const entry of ['docs/', 'README.md', 'ROADMAP.md', 'npm-reserve/', 'packaging/']) {
      expect(lines).toContain(entry);
    }
  });
});
