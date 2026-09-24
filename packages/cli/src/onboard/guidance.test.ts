import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  GUIDANCE_CONTENT_VERSION,
  GUIDANCE_INSTALL_PATHS,
  parseContentStamp,
} from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_ORIENT_PATH,
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
import { HARNESSES } from './harnesses/index.js';

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

describe('self-label guidance unit (ADR 186)', () => {
  it('writes the Cursor self-label rule, stamped — the one labeling unit the wall keeps', () => {
    const dir = tmp();
    const res = writeGuidance(dir, [claudeCode, cursor, codex], { team: 'dawn' });
    const self = '.cursor/rules/musterd-label-session.mdc';
    expect(res.files).toContain(self);
    const selfText = readFileSync(join(dir, self), 'utf8');
    expect(parseContentStamp(selfText)?.version).toBe(GUIDANCE_CONTENT_VERSION);
    expect(selfText).toContain('rename_chat');
    expect(selfText).toContain('current chat only');
    expect(res.files.filter((f) => f.includes('label-session'))).toEqual([self]);
  });
});

/**
 * ADR 442 (the wall): the relay skill and the Claude Code peer label sweep leave. Both reached into
 * sessions outside the seat — `send_message` to a teammate's session, `list_sessions` +
 * `set_session_title` across every session on the machine. A seat never writes either again, a
 * refresh removes the copy a seat already carries, and a user's own file at the path is left alone.
 */
describe('retired guidance units (ADR 442)', () => {
  const RETIRED = [
    '.claude/skills/musterd-nudge-relay/SKILL.md',
    '.claude/skills/musterd-label-sessions/SKILL.md',
  ];

  it('writeGuidance writes neither, on any harness', () => {
    const dir = tmp();
    const res = writeGuidance(dir, [claudeCode, cursor, codex], { team: 'dawn' });
    for (const rel of RETIRED) {
      expect(res.files).not.toContain(rel);
      expect(existsSync(join(dir, rel))).toBe(false);
    }
    expect(guidanceTargets(HARNESSES)).not.toEqual(expect.arrayContaining([RETIRED[0]]));
    expect(guidanceTargets(HARNESSES)).not.toEqual(expect.arrayContaining([RETIRED[1]]));
  });

  it('a refresh removes a stamped copy a seat already carries, and prunes the empty dir', () => {
    const dir = tmp();
    writeGuidance(dir, [claudeCode], { team: 'dawn' });
    for (const rel of RETIRED)
      write(dir, rel, `old skill\n\n<!-- musterd:content v29 sha256:0123456789abcdef -->\n`);
    const res = writeGuidance(dir, [claudeCode], { team: 'dawn' });
    expect(res.removed).toEqual(expect.arrayContaining(RETIRED));
    for (const rel of RETIRED) expect(existsSync(dirname(join(dir, rel)))).toBe(false);
  });

  it('never removes a stampless user-authored file at a retired path', () => {
    const dir = tmp();
    write(dir, RETIRED[1]!, '# my own sweep\n');
    const res = writeGuidance(dir, [claudeCode], { team: 'dawn' });
    expect(res.removed).not.toContain(RETIRED[1]);
    expect(readFileSync(join(dir, RETIRED[1]!), 'utf8')).toBe('# my own sweep\n');
  });

  it('uninstall sweeps a stamped retired copy too', () => {
    const dir = tmp();
    write(dir, RETIRED[0]!, `x\n\n<!-- musterd:content v29 sha256:0123456789abcdef -->\n`);
    const { removed } = removeGuidance(dir, [claudeCode]);
    expect(removed).toContain(RETIRED[0]);
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

describe('GUIDANCE_INSTALL_PATHS drift guard (ADR 417)', () => {
  // The CLI's harness definitions decide what gets WRITTEN; `@musterd/protocol` owns the list the
  // epoch reader VISITS, because `@musterd/mcp` claims seats too and cannot import the CLI. Two
  // lists, one meaning — so a path added to a harness here and forgotten there would make the
  // reader silently blind to it, and a census would read high. This is the guard against that.
  it('covers every path guidanceTargets produces for every harness', () => {
    const declared = new Set(GUIDANCE_INSTALL_PATHS);
    const written = guidanceTargets(HARNESSES);
    const missing = written.filter((rel) => !declared.has(rel));
    expect(missing).toEqual([]);
  });

  it('declares no path no harness would ever write', () => {
    const written = new Set(guidanceTargets(HARNESSES));
    const orphans = GUIDANCE_INSTALL_PATHS.filter((rel) => !written.has(rel));
    expect(orphans).toEqual([]);
  });
});
