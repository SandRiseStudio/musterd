import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDANCE_INSTALL_PATHS, installedGuidanceEpoch } from './guidance-epoch.js';
import { renderContentStamp } from './guidance.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'musterd-gepoch-'));
}

function put(dir: string, rel: string, text: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

function stamped(version: number): string {
  return `# skill\n\nbody\n${renderContentStamp(version, 'a'.repeat(16))}\n`;
}

describe('GUIDANCE_INSTALL_PATHS', () => {
  it('names the canonical skill, which every harness gets', () => {
    expect(GUIDANCE_INSTALL_PATHS).toContain('.musterd/skill/SKILL.md');
    expect(GUIDANCE_INSTALL_PATHS).toContain('.musterd/skill/orient.md');
  });

  it('covers the Claude Code placements a seat here actually carries', () => {
    expect(GUIDANCE_INSTALL_PATHS).toContain('.claude/skills/musterd/SKILL.md');
    expect(GUIDANCE_INSTALL_PATHS).toContain('.claude/skills/musterd-orient/SKILL.md');
    expect(GUIDANCE_INSTALL_PATHS).toContain('.claude/commands/musterd-standup.md');
  });

  it('has no duplicates — the reader visits each path once', () => {
    expect(new Set(GUIDANCE_INSTALL_PATHS).size).toBe(GUIDANCE_INSTALL_PATHS.length);
  });
});

describe('installedGuidanceEpoch (ADR 417)', () => {
  it('reads the version the installed files agree on', () => {
    const dir = tmp();
    put(dir, '.musterd/skill/SKILL.md', stamped(22));
    put(dir, '.claude/skills/musterd/SKILL.md', stamped(22));
    expect(installedGuidanceEpoch(dir)).toBe(22);
  });

  it('takes the MINIMUM when installed files disagree — the seat ran the weakest rule', () => {
    const dir = tmp();
    put(dir, '.musterd/skill/SKILL.md', stamped(24));
    put(dir, '.claude/skills/musterd/SKILL.md', stamped(21));
    expect(installedGuidanceEpoch(dir)).toBe(21);
  });

  it('skips an unstamped file rather than counting it as epoch 0', () => {
    const dir = tmp();
    put(dir, '.musterd/skill/SKILL.md', stamped(23));
    put(dir, '.claude/skills/musterd/SKILL.md', '# hand-written, no stamp\n');
    expect(installedGuidanceEpoch(dir)).toBe(23);
  });

  it('returns undefined for a folder carrying no guidance at all', () => {
    expect(installedGuidanceEpoch(tmp())).toBeUndefined();
  });

  it('returns undefined when every installed file is unstamped', () => {
    const dir = tmp();
    put(dir, '.musterd/skill/SKILL.md', 'no stamp\n');
    expect(installedGuidanceEpoch(dir)).toBeUndefined();
  });

  it('sees a rewrite without a restart — nothing is memoised', () => {
    const dir = tmp();
    put(dir, '.musterd/skill/SKILL.md', stamped(25));
    expect(installedGuidanceEpoch(dir)).toBe(25);
    put(dir, '.musterd/skill/SKILL.md', stamped(3));
    expect(installedGuidanceEpoch(dir)).toBe(3);
  });
});
