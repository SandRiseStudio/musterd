import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSeatPermissions, STANDARD_FLOOR } from './permissions.js';
import { BUILTIN_ROLES } from './role.js';

/**
 * ADR 261 — role permission profiles. Three claims under test:
 *
 * 1. CANONICAL SYNTAX. Claude Code permission rules are exact tool names (`Read`, `Edit`,
 *    `Bash(git diff *)`); the seed library's historical lowercase entries (`'read'`, `'edit'`,
 *    `'bash(...)'`) matched nothing, so every entry ever provisioned from a builtin was inert —
 *    the reviewer role's quasi-ceiling never worked. Every profile entry must now be canonical.
 * 2. THE FLOOR IS ALLOW-ONLY. `standard` is what any seat needs to function non-interactively;
 *    it must merge under any ceiling, so it can never carry deny.
 * 3. THE CEILING IS DENY. `read-only` is real only because deny outranks allow; and installing a
 *    profile into a seat dir must be merge-never-clobber (hooks and user entries survive).
 */

/** A canonical Claude Code permission rule: exact tool name, optional `(specifier)` — a bare tool
 * name (`Bash`, `Read`) is the valid tool-wide form. */
const CANONICAL_RULE =
  /^(Read|Edit|Write|NotebookEdit|Glob|Grep|WebFetch|WebSearch|Bash(\(.+\))?|mcp__[a-zA-Z0-9_-]+(__[a-zA-Z0-9_-]+)?)$/;

describe('canonical rule syntax (ADR 261 decision 1)', () => {
  it('every builtin role permission entry is a canonical Claude Code rule', () => {
    for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
      const p = role.tools.permissions;
      for (const entry of [...p.allow, ...p.ask, ...p.deny]) {
        expect(entry, `${name}: '${entry}' is not a canonical Claude Code rule`).toMatch(
          CANONICAL_RULE,
        );
      }
    }
  });

  it('the standard floor is canonical too', () => {
    for (const entry of STANDARD_FLOOR.allow) {
      expect(entry, `floor: '${entry}'`).toMatch(CANONICAL_RULE);
    }
  });
});

describe('the standard floor (ADR 261 decision 2)', () => {
  it('is allow-only — a floor must merge under any ceiling', () => {
    expect(STANDARD_FLOOR.deny).toEqual([]);
    expect(STANDARD_FLOOR.ask).toEqual([]);
    expect(STANDARD_FLOOR.allow.length).toBeGreaterThan(0);
  });

  it('covers what the ryder incident was missing: file edits and the repo gates', () => {
    expect(STANDARD_FLOOR.allow).toContain('Edit');
    expect(STANDARD_FLOOR.allow).toContain('Write');
    expect(STANDARD_FLOOR.allow.some((e) => e.startsWith('Bash(pnpm '))).toBe(true);
    expect(STANDARD_FLOOR.allow.some((e) => e.startsWith('Bash(git '))).toBe(true);
  });
});

describe('the read-only ceiling (ADR 261 decision 3)', () => {
  it('read-only is a builtin whose ceiling is made of deny entries', () => {
    const ro = BUILTIN_ROLES['read-only'];
    expect(ro).toBeDefined();
    const deny = ro!.tools.permissions.deny;
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(deny, `read-only must deny ${tool}`).toContain(tool);
    }
    // ask is a slower fail-closed in a non-interactive session — a ceiling never relies on it.
    expect(ro!.tools.permissions.ask).toEqual([]);
  });
});

describe('installSeatPermissions (ADR 261 decision 4)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-perm-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readSettings(): {
    permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
    hooks?: Record<string, unknown>;
  } {
    return JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  }

  it('writes the floor into a seat dir that has no settings file at all (the ryder shape)', () => {
    const added = installSeatPermissions(dir);
    expect(readSettings().permissions?.allow).toEqual(expect.arrayContaining(STANDARD_FLOOR.allow));
    expect(added.allow.length).toBe(STANDARD_FLOOR.allow.length);
  });

  it('targets the given dir, never process.cwd() — musterd agent provisions a different folder', () => {
    // Snapshot the invoking checkout's settings (which may legitimately not exist) …
    const cwdPath = join(process.cwd(), '.claude', 'settings.local.json');
    const before = ((): string | null => {
      try {
        return readFileSync(cwdPath, 'utf8');
      } catch {
        return null;
      }
    })();
    installSeatPermissions(dir);
    // … and assert the install changed nothing there: absent stays absent, content stays byte-equal.
    const after = ((): string | null => {
      try {
        return readFileSync(cwdPath, 'utf8');
      } catch {
        return null;
      }
    })();
    expect(after).toBe(before);
    expect(readSettings().permissions?.allow?.length).toBeGreaterThan(0);
  });

  it('merges, never clobbers: existing hooks and user-approved entries survive', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(cargo test *)'] },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      }),
    );
    installSeatPermissions(dir);
    const s = readSettings();
    expect(s.permissions?.allow).toContain('Bash(cargo test *)'); // user entry kept
    expect(s.permissions?.allow).toEqual(expect.arrayContaining(STANDARD_FLOOR.allow));
    expect(s.hooks?.['SessionStart']).toBeDefined(); // hooks untouched
  });

  it('layers a role ceiling over the floor: read-only deny entries land alongside the floor allows', () => {
    const added = installSeatPermissions(dir, BUILTIN_ROLES['read-only']);
    const s = readSettings();
    expect(s.permissions?.deny).toEqual(expect.arrayContaining(['Edit', 'Write']));
    // Deny-wins-allows-kept (nick, 2026-08-13): the floor allows stay present and inert.
    expect(s.permissions?.allow).toEqual(expect.arrayContaining(['Read']));
    expect(added.deny).toContain('Edit');
  });

  it('is idempotent: a second install adds nothing and reports nothing added', () => {
    installSeatPermissions(dir);
    const second = installSeatPermissions(dir);
    expect(second.allow).toEqual([]);
    expect(second.deny).toEqual([]);
  });
});
