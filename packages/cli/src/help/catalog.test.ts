import { SKILL_CLI_COMMANDS } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { HELP } from '../help.js';
import { CATALOG, GROUPS } from './catalog.js';
import { renderPlainHelp } from './plain.js';

describe('command catalog', () => {
  it('mirrors the guidance drift check: every skill-named command is in HELP', () => {
    // This is the exact invariant scripts/check-guidance.ts enforces in CI — assert it locally too so
    // a rename fails fast in the unit run, not only at build time.
    for (const cmd of SKILL_CLI_COMMANDS) {
      expect(HELP).toContain(`musterd ${cmd}`);
    }
  });

  it('gives every entry a summary and a group that exists', () => {
    const groupIds = new Set(GROUPS.map((g) => g.id));
    for (const cmd of CATALOG) {
      expect(cmd.summary.length).toBeGreaterThan(0);
      expect(groupIds.has(cmd.group)).toBe(true);
    }
  });

  it('has no duplicate command names', () => {
    const names = CATALOG.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps `lanes` as its own entry (guidance:check anchors on it distinctly from `lane`)', () => {
    expect(CATALOG.some((c) => c.name === 'lanes')).toBe(true);
    expect(HELP).toContain('musterd lanes');
  });

  it('renderPlainHelp is stable and self-consistent with HELP', () => {
    expect(HELP).toBe(renderPlainHelp());
  });
});
