import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GUIDANCE_CONTENT_VERSION, parseContentStamp } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SKILL_PATH,
  contentHash,
  guidanceTargets,
  removeGuidance,
  strippedBody,
  writeGuidance,
} from './guidance.js';
import { claudeCode } from './harnesses/claudeCode.js';
import { codex } from './harnesses/codex.js';
import { cursor } from './harnesses/cursor.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'musterd-guidance-'));
}

function write(dir: string, rel: string, text: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

describe('writeGuidance', () => {
  it('writes the canonical skill always + the chosen harness native files, each stamped', () => {
    const dir = tmp();
    const res = writeGuidance(dir, [claudeCode], { team: 'dawn' });

    // canonical + claude skill + 3 slash commands
    expect(res.files).toContain(CANONICAL_SKILL_PATH);
    expect(res.files).toContain('.claude/skills/musterd/SKILL.md');
    expect(res.files).toContain('.claude/commands/musterd-standup.md');
    expect(res.files).toContain('.claude/commands/musterd-handoff.md');
    expect(res.files).toContain('.claude/commands/musterd-claim.md');
    expect(res.contentVersion).toBe(GUIDANCE_CONTENT_VERSION);

    for (const rel of res.files) {
      const text = readFileSync(join(dir, rel), 'utf8');
      expect(parseContentStamp(text)?.version).toBe(GUIDANCE_CONTENT_VERSION);
    }
    // The claude skill carries native frontmatter; the canonical file does not.
    expect(readFileSync(join(dir, '.claude/skills/musterd/SKILL.md'), 'utf8')).toContain(
      'name: musterd',
    );
    expect(readFileSync(join(dir, CANONICAL_SKILL_PATH), 'utf8')).not.toContain('name: musterd');
  });

  it('gives Codex only the canonical skill (no native mechanism)', () => {
    const dir = tmp();
    const res = writeGuidance(dir, [codex], { team: 'dawn' });
    expect(res.files).toEqual([CANONICAL_SKILL_PATH]);
  });

  it('renders the Cursor rule with .mdc frontmatter', () => {
    const dir = tmp();
    writeGuidance(dir, [cursor], { team: 'dawn' });
    const mdc = readFileSync(join(dir, '.cursor/rules/musterd.mdc'), 'utf8');
    expect(mdc).toContain('alwaysApply: false');
    expect(parseContentStamp(mdc)).not.toBeNull();
  });

  it('is idempotent — re-running overwrites its own stamped files without appending', () => {
    const dir = tmp();
    writeGuidance(dir, [claudeCode], { team: 'dawn' });
    const first = readFileSync(join(dir, CANONICAL_SKILL_PATH), 'utf8');
    const res2 = writeGuidance(dir, [claudeCode], { team: 'dawn' });
    const second = readFileSync(join(dir, CANONICAL_SKILL_PATH), 'utf8');
    expect(second).toBe(first);
    expect(res2.skipped).toHaveLength(0);
  });

  it('skips a stampless user-authored file, unless --force', () => {
    const dir = tmp();
    write(dir, CANONICAL_SKILL_PATH, '# my own skill, do not touch\n');

    const res = writeGuidance(dir, [claudeCode], { team: 'dawn' });
    expect(res.skipped).toContain(CANONICAL_SKILL_PATH);
    expect(readFileSync(join(dir, CANONICAL_SKILL_PATH), 'utf8')).toBe(
      '# my own skill, do not touch\n',
    );

    const forced = writeGuidance(dir, [claudeCode], { team: 'dawn', force: true });
    expect(forced.files).toContain(CANONICAL_SKILL_PATH);
    expect(readFileSync(join(dir, CANONICAL_SKILL_PATH), 'utf8')).toContain('Using musterd');
  });
});

describe('strippedBody', () => {
  it('recovers the renderable content the stamp was computed over', () => {
    const dir = tmp();
    writeGuidance(dir, [codex], { team: 'dawn' });
    const text = readFileSync(join(dir, CANONICAL_SKILL_PATH), 'utf8');
    const stamp = parseContentStamp(text)!;
    // re-hashing the stripped body must match the recorded hash (self-consistent, unedited)
    // (hash algorithm lives in guidance.ts contentHash; here we just assert the stamp round-trips)
    expect(strippedBody(text)).not.toContain('musterd:content');
    expect(stamp.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stamp round-trips exactly, so an untouched file is never flagged as edited', () => {
    // The renderers `join('\n')` with no trailing newline; the stamp must hash the *normalized* body
    // (what gets written) so `contentHash(strippedBody(text))` — the doctor's drift check — matches.
    const dir = tmp();
    const res = writeGuidance(dir, [claudeCode, cursor], { team: 'dawn' });
    for (const rel of res.files) {
      const text = readFileSync(join(dir, rel), 'utf8');
      const stamp = parseContentStamp(text)!;
      expect(contentHash(strippedBody(text))).toBe(stamp.hash); // no false "local edits"
    }
  });
});

describe('removeGuidance', () => {
  it('removes exactly the stamped files it wrote and prunes empty dirs', () => {
    const dir = tmp();
    writeGuidance(dir, [claudeCode], { team: 'dawn' });
    const { removed } = removeGuidance(dir, [claudeCode]);
    expect(removed).toContain(CANONICAL_SKILL_PATH);
    expect(removed).toContain('.claude/skills/musterd/SKILL.md');
    expect(existsSync(join(dir, '.claude/skills/musterd'))).toBe(false);
    expect(existsSync(join(dir, '.musterd/skill'))).toBe(false);
  });

  it('never deletes a stampless user-authored file at a guidance path', () => {
    const dir = tmp();
    write(dir, CANONICAL_SKILL_PATH, '# mine\n');
    const { removed } = removeGuidance(dir, [claudeCode]);
    expect(removed).not.toContain(CANONICAL_SKILL_PATH);
    expect(existsSync(join(dir, CANONICAL_SKILL_PATH))).toBe(true);
  });
});

describe('guidanceTargets', () => {
  it('enumerates the canonical path plus each harness placement', () => {
    const targets = guidanceTargets([claudeCode, cursor, codex]);
    expect(targets).toContain(CANONICAL_SKILL_PATH);
    expect(targets).toContain('.claude/skills/musterd/SKILL.md');
    expect(targets).toContain('.cursor/rules/musterd.mdc');
    expect(targets).toContain('.claude/commands/musterd-standup.md');
  });
});
