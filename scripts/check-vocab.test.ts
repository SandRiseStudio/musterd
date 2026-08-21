import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GLOSSARY } from '../docs/glossary/terms.ts';
import { checkVocab } from './check-vocab.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-test-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'docs/decisions'), { recursive: true });
  mkdirSync(join(dir, 'docs/superpowers/plans'), { recursive: true });
  mkdirSync(join(dir, 'docs/design'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  return dir;
}

describe('ADR 098 work-item table (unchanged)', () => {
  it('fails a new ADR that uses "epic" in prose', () => {
    const root = repo({
      'docs/decisions/100-uses-epic.md': '# 100\n\nThis epic is structural.\n',
    });
    const r = checkVocab(root);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('epic') && e.includes('100-uses-epic'))).toBe(true);
  });

  it('allows a backticked mention of a banned work-item word', () => {
    const root = repo({
      'docs/decisions/100-mentions-epic.md': '# 100\n\nThe banned word is `epic`.\n',
    });
    expect(checkVocab(root).ok).toBe(true);
  });
});

describe('ADR 296 terminology table', () => {
  it('fails a post-gate ADR that uses "profile" in prose', () => {
    const root = repo({
      'docs/decisions/300-uses-profile.md': '# 300\n\nScaffold a profile for the workspace.\n',
    });
    const r = checkVocab(root);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /profile/.test(e) && e.includes('300-uses-profile'))).toBe(true);
  });

  it('does not apply the terminology table to ADRs below TERMINOLOGY_GATE_FROM', () => {
    const root = repo({
      'docs/decisions/200-old-profile.md': '# 200\n\nA workspace profile is fine here.\n',
    });
    expect(checkVocab(root).ok).toBe(true);
  });

  it('treats double-quoted and backticked words as mentions', () => {
    const root = repo({
      'docs/decisions/300-mentions.md':
        '# 300\n\nReplaces "profile"; the alias is `--profile` written as `--profile` in code: `profile`.\n',
    });
    expect(checkVocab(root).ok).toBe(true);
  });

  it('does not match "kit" inside "toolkit"', () => {
    const root = repo({
      'docs/decisions/300-toolkit.md': '# 300\n\nCreate a toolkit for the workspace.\n',
    });
    expect(checkVocab(root).ok).toBe(true);
  });

  it('fails unquoted "kit" and "worktree" in a post-gate ADR', () => {
    const root = repo({
      'docs/decisions/300-kit.md': '# 300\n\nHand them a kit.\n',
      'docs/decisions/300-worktree.md': '# 300\n\nBind the worktree.\n',
    });
    const r = checkVocab(root);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('"kit"'))).toBe(true);
    expect(r.errors.some((e) => e.includes('"worktree"'))).toBe(true);
  });

  it('gates a new user-facing help file, and skips one named on the grandfather list', () => {
    const root = repo({
      'packages/cli/src/help/new-help.ts': 'export const HELP = "create a profile";\n',
      'README.md': 'Hand them a kit.\n',
    });
    const r = checkVocab(root, { userFacingBaseline: ['README.md'] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('new-help.ts') && e.includes('profile'))).toBe(true);
    expect(r.errors.some((e) => e.includes('README.md'))).toBe(false);
  });
});

describe('glossary source (ADR 296)', () => {
  it('has the original five as core canonical terms', () => {
    const core = GLOSSARY.filter((t) => t.core).map((t) => t.term);
    expect(core).toEqual(['team', 'member', 'presence', 'surface', 'act']);
  });

  it('bans profile/kit/template/worktree', () => {
    const banned = GLOSSARY.filter((t) => t.status === 'banned').map((t) => t.term);
    expect(banned).toEqual(expect.arrayContaining(['profile', 'kit', 'template', 'worktree']));
  });

  it('fails when brand.md §5 drops a canonical term', () => {
    const root = repo({
      'docs/design/brand.md': '## 5. Terminology glossary\n\n| **Team** | a roster | not room |\n',
    });
    const r = checkVocab(root);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('brand.md') && e.includes('toolkit'))).toBe(true);
  });
});
