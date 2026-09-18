import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GUIDANCE_CONTENT_VERSION, parseContentStamp, renderContentStamp } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_ORIENT_PATH,
  CANONICAL_SKILL_PATH,
  contentHash,
  guidanceTargets,
  installedGuidanceEpoch,
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

  it('gives Codex the canonical team skill and the canonical orient skill (no native mechanism)', () => {
    const dir = tmp();
    const res = writeGuidance(dir, [codex], { team: 'dawn' });
    expect(res.files).toEqual([CANONICAL_SKILL_PATH, CANONICAL_ORIENT_PATH]);
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
    expect(targets).toContain(CANONICAL_ORIENT_PATH);
    expect(targets).toContain('.claude/skills/musterd/SKILL.md');
    expect(targets).toContain('.claude/skills/musterd-orient/SKILL.md');
    expect(targets).toContain('.cursor/rules/musterd.mdc');
    expect(targets).toContain('.cursor/rules/musterd-orient.mdc');
    expect(targets).toContain('.claude/commands/musterd-standup.md');
  });
});

describe('label-sessions guidance unit (ADR 160)', () => {
  it('writes the label-sessions skill for Claude Code and the self-label rule for Cursor (ADR 186)', () => {
    const dir = tmp();
    const res = writeGuidance(dir, [claudeCode, cursor, codex], { team: 'dawn' });
    const cross = '.claude/skills/musterd-label-sessions/SKILL.md';
    const self = '.cursor/rules/musterd-label-session.mdc';
    expect(res.files).toContain(cross);
    expect(res.files).toContain(self);
    const crossText = readFileSync(join(dir, cross), 'utf8');
    expect(parseContentStamp(crossText)?.version).toBe(GUIDANCE_CONTENT_VERSION);
    expect(crossText).toContain('name: musterd-label-sessions');
    expect(crossText).toContain('resolve-labels --stdin');
    expect(crossText).toContain('never proposed');
    const selfText = readFileSync(join(dir, self), 'utf8');
    expect(parseContentStamp(selfText)?.version).toBe(GUIDANCE_CONTENT_VERSION);
    expect(selfText).toContain('rename_chat');
    expect(selfText).toContain('current chat only');
    // Codex declares neither — no sibling unit.
    expect(res.files.filter((f) => f.includes('label-session'))).toEqual([cross, self]);
  });

  it('is enumerated by guidanceTargets and removed by removeGuidance (dir pruned)', () => {
    const dir = tmp();
    writeGuidance(dir, [claudeCode], { team: 'dawn' });
    const rel = '.claude/skills/musterd-label-sessions/SKILL.md';
    expect(guidanceTargets([claudeCode])).toContain(rel);
    const { removed } = removeGuidance(dir, [claudeCode]);
    expect(removed).toContain(rel);
    expect(existsSync(join(dir, '.claude/skills/musterd-label-sessions'))).toBe(false);
  });

  it('never clobbers a stampless user-authored file at the label-sessions path', () => {
    const dir = tmp();
    const rel = '.claude/skills/musterd-label-sessions/SKILL.md';
    write(dir, rel, '# my own sweep\n');
    const res = writeGuidance(dir, [claudeCode], { team: 'dawn' });
    expect(res.skipped).toContain(rel);
    expect(readFileSync(join(dir, rel), 'utf8')).toBe('# my own sweep\n');
  });
});

describe('nudge-relay guidance unit (ADR 167)', () => {
  it('writes the nudge-relay skill for Claude Code (the only nudgeSkillPath declarer), stamped', () => {
    const dir = tmp();
    const res = writeGuidance(dir, [claudeCode, cursor, codex], { team: 'dawn' });
    const rel = '.claude/skills/musterd-nudge-relay/SKILL.md';
    expect(res.files).toContain(rel);
    const text = readFileSync(join(dir, rel), 'utf8');
    expect(parseContentStamp(text)?.version).toBe(GUIDANCE_CONTENT_VERSION);
    expect(text).toContain('name: musterd-nudge-relay');
    expect(text).toContain('VERBATIM');
    expect(text).toContain('delivery_hint');
    // Cursor/Codex declare no nudgeSkillPath — no sibling unit appears for them.
    expect(res.files.filter((f) => f.includes('nudge-relay'))).toEqual([rel]);
  });

  it('is enumerated by guidanceTargets and removed by removeGuidance (dir pruned)', () => {
    const dir = tmp();
    writeGuidance(dir, [claudeCode], { team: 'dawn' });
    const rel = '.claude/skills/musterd-nudge-relay/SKILL.md';
    expect(guidanceTargets([claudeCode])).toContain(rel);
    const { removed } = removeGuidance(dir, [claudeCode]);
    expect(removed).toContain(rel);
    expect(existsSync(join(dir, '.claude/skills/musterd-nudge-relay'))).toBe(false);
  });
});

describe('orient guidance unit (ADR 333)', () => {
  it('writes Claude native, Cursor .mdc, and canonical orient.md', () => {
    const dir = tmp();
    const res = writeGuidance(dir, [claudeCode, cursor, codex], { team: 'dawn' });
    const claude = '.claude/skills/musterd-orient/SKILL.md';
    const cursorRule = '.cursor/rules/musterd-orient.mdc';
    expect(res.files).toContain(claude);
    expect(res.files).toContain(cursorRule);
    expect(res.files).toContain(CANONICAL_ORIENT_PATH);
    const claudeText = readFileSync(join(dir, claude), 'utf8');
    expect(claudeText).toContain('name: musterd-orient');
    const cursorText = readFileSync(join(dir, cursorRule), 'utf8');
    expect(cursorText).toContain('alwaysApply: false');
    expect(cursorText).not.toContain('name: musterd-orient');
    const canonical = readFileSync(join(dir, CANONICAL_ORIENT_PATH), 'utf8');
    expect(canonical).toContain('# Orient this seat session');
    expect(canonical).not.toContain('name: musterd-orient');
  });

  it('is enumerated by guidanceTargets and removed by removeGuidance (dir pruned)', () => {
    const dir = tmp();
    writeGuidance(dir, [claudeCode], { team: 'dawn' });
    const rel = '.claude/skills/musterd-orient/SKILL.md';
    expect(guidanceTargets([claudeCode])).toContain(rel);
    const { removed } = removeGuidance(dir, [claudeCode]);
    expect(removed).toContain(rel);
    expect(removed).toContain(CANONICAL_ORIENT_PATH);
    expect(existsSync(join(dir, '.claude/skills/musterd-orient'))).toBe(false);
  });
});

describe('installedGuidanceEpoch', () => {
  // A guidance file as it actually lands on disk: a body, then the stamp `renderContentStamp`
  // writes. The hash is irrelevant here — this function reads the VERSION, and drift detection
  // (which reads the hash) is a separate check that already has its own tests.
  function stamped(version: number): string {
    return `# skill\n\nbody text\n${renderContentStamp(version, contentHash('body text'))}\n`;
  }

  /** A workspace whose every claude-code guidance file carries `version`. */
  function workspaceAt(version: number): string {
    const dir = tmp();
    for (const rel of guidanceTargets([claudeCode])) write(dir, rel, stamped(version));
    return dir;
  }

  it('reads the version every installed file agrees on', () => {
    expect(installedGuidanceEpoch(workspaceAt(22), [claudeCode])).toBe(22);
  });

  it('takes the MINIMUM when installed files disagree — the seat ran the weakest rule', () => {
    const targets = guidanceTargets([claudeCode]);
    expect(targets.length).toBeGreaterThan(1); // the disagreement case needs two files
    const dir = workspaceAt(24);
    write(dir, targets[0], stamped(21));
    expect(installedGuidanceEpoch(dir, [claudeCode])).toBe(21);
  });

  it('skips an unstamped file rather than counting it as epoch 0', () => {
    const targets = guidanceTargets([claudeCode]);
    const dir = workspaceAt(23);
    write(dir, targets[0], '# skill\n\nhand-written, no stamp\n');
    expect(installedGuidanceEpoch(dir, [claudeCode])).toBe(23);
  });

  it('returns undefined for a workspace with no guidance files at all', () => {
    expect(installedGuidanceEpoch(tmp(), [claudeCode])).toBeUndefined();
  });

  it('returns undefined when every installed file is unstamped', () => {
    const dir = tmp();
    for (const rel of guidanceTargets([claudeCode])) write(dir, rel, 'no stamp here\n');
    expect(installedGuidanceEpoch(dir, [claudeCode])).toBeUndefined();
  });

  it('reads the FILES, not the build constant — a workspace one epoch behind says so', () => {
    const behind = GUIDANCE_CONTENT_VERSION - 1;
    const epoch = installedGuidanceEpoch(workspaceAt(behind), [claudeCode]);
    expect(epoch).toBe(behind);
    expect(epoch).not.toBe(GUIDANCE_CONTENT_VERSION);
  });

  it('reads what writeGuidance actually wrote, not a hand-built fixture', () => {
    const dir = tmp();
    writeGuidance(dir, [claudeCode], { team: 'dawn' });
    expect(installedGuidanceEpoch(dir, [claudeCode])).toBe(GUIDANCE_CONTENT_VERSION);
  });
});
