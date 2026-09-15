import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseContentStamp } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { claudeCode } from './harnesses/claudeCode.js';
import { codex } from './harnesses/codex.js';
import { cursor } from './harnesses/cursor.js';
import { committedRoleSkill, resolveSeatRole, roleBridgeMap, seatRoleFor } from './roleSkills.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'musterd-roleskills-'));
}

function write(dir: string, rel: string, text: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

const SECURITY_SKILL = [
  '---',
  'name: security',
  'description: Use when threat-modeling, running authorized scans, or preparing posture evidence.',
  '---',
  '',
  '# Security',
  '',
  'Own the security evidence.',
].join('\n');

describe('resolveSeatRole (ADR 272 — the role is a team fact, read-only here)', () => {
  it('reads the role from the file-backed seat file', () => {
    const home = tmp();
    write(home, '.musterd/seats/big-body.toml', 'kind = "agent"\nrole = "security"\n');
    expect(resolveSeatRole(home, 'big-body')).toBe('security');
  });

  it('returns null for a seat with an empty role, and for a missing seat file', () => {
    const home = tmp();
    write(home, '.musterd/seats/plain.toml', 'kind = "agent"\nrole = ""\n');
    expect(resolveSeatRole(home, 'plain')).toBeNull();
    expect(resolveSeatRole(home, 'nobody')).toBeNull();
  });
});

describe('seatRoleFor (resolution degrades to null, never throws)', () => {
  const home = tmp();
  write(home, '.musterd/seats/big-body.toml', 'kind = "agent"\nrole = "security"\n');
  const deps = {
    seatOf: () => ({ team: 'revive', seat: 'big-body' }),
    rosterHomeOf: () => home,
  };

  it('resolves worktree → seat → roster → role', () => {
    expect(seatRoleFor('/anywhere', deps)).toBe('security');
  });

  it('is null for an unbound folder and for a db-only team', () => {
    expect(seatRoleFor('/anywhere', { ...deps, seatOf: () => null })).toBeNull();
    expect(seatRoleFor('/anywhere', { ...deps, rosterHomeOf: () => null })).toBeNull();
  });
});

describe('committedRoleSkill (ADR 299 — one canonical body under .agents/skills)', () => {
  it('finds a committed skill and lifts its description', () => {
    const repo = tmp();
    write(repo, '.agents/skills/security/SKILL.md', SECURITY_SKILL);
    const found = committedRoleSkill(repo, 'security');
    expect(found?.canonicalPath).toBe('.agents/skills/security/SKILL.md');
    expect(found?.description).toContain('threat-modeling');
  });

  it('is null when the role has no committed skill', () => {
    expect(committedRoleSkill(tmp(), 'security')).toBeNull();
  });
});

describe('roleBridgeMap (ADR 299 §2 — thin pointers, never a copied body)', () => {
  it('writes a Claude Code bridge that points at the canonical body', () => {
    const repo = tmp();
    write(repo, '.agents/skills/security/SKILL.md', SECURITY_SKILL);
    const map = roleBridgeMap(repo, 'security', [claudeCode]);
    const rel = '.claude/skills/security/SKILL.md';
    expect(Object.keys(map)).toContain(rel);
    const text = map[rel] as string;
    expect(text).toContain('name: security');
    expect(text).toContain('.agents/skills/security/SKILL.md');
    // Thin pointer: the canonical body must NOT be duplicated into the bridge.
    expect(text).not.toContain('Own the security evidence.');
  });

  it('renders the Cursor flavor as an .mdc rule without Claude frontmatter', () => {
    const repo = tmp();
    write(repo, '.agents/skills/security/SKILL.md', SECURITY_SKILL);
    const map = roleBridgeMap(repo, 'security', [cursor]);
    const rel = '.cursor/rules/security.mdc';
    expect(Object.keys(map)).toContain(rel);
    expect(map[rel]).toContain('alwaysApply: false');
    expect(map[rel]).not.toContain('name: security');
  });

  it('stamps every bridge so it is managed, removable and drift-detectable', () => {
    const repo = tmp();
    write(repo, '.agents/skills/security/SKILL.md', SECURITY_SKILL);
    const map = roleBridgeMap(repo, 'security', [claudeCode, cursor]);
    for (const text of Object.values(map)) {
      expect(parseContentStamp(text)).not.toBeNull();
    }
  });

  it('is empty for a role with no committed skill, and for a null role', () => {
    const repo = tmp();
    expect(roleBridgeMap(repo, 'security', [claudeCode])).toEqual({});
    expect(roleBridgeMap(repo, null, [claudeCode])).toEqual({});
  });

  it('skips harnesses with no native skill catalog (Codex gets the canonical pointer instead)', () => {
    const repo = tmp();
    write(repo, '.agents/skills/security/SKILL.md', SECURITY_SKILL);
    expect(roleBridgeMap(repo, 'security', [codex])).toEqual({});
  });
});
