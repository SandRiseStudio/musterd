import { describe, expect, it } from 'vitest';
import { decisionSection } from './adr-sections.ts';

/*
 * Extracted from `check-change-adr.ts` so a second gate can share it — the same move, for the same
 * stated reason, as `adr-status.ts`: that file reads git and calls `process.exit` at the top level,
 * so importing it runs the gate instead of using it.
 *
 * These tests did not exist while the function was private. They exist now because two gates depend
 * on its exact boundaries: `check-change-adr` freezes what it returns, and `check-watches` scans it
 * for frequency claims. If those two ever disagreed about where a Decision starts and stops, one of
 * them would be silently wrong.
 */

const ADR = `# 301 — A thing

- Status: draft — 2026-08-21.

## Context

The reconnect is flaky under load, historically.

## Decision

We retry three times.

## Consequences

None.
`;

describe('decisionSection', () => {
  it('returns the Decision body', () => {
    expect(decisionSection(ADR)).toBe('We retry three times.');
  });

  it('stops at the next heading, so Consequences is not swept in', () => {
    expect(decisionSection(ADR)).not.toContain('None.');
  });

  it('excludes Context, where history is quoted rather than asserted', () => {
    expect(decisionSection(ADR)).not.toContain('flaky');
  });

  it('returns null when there is no Decision heading', () => {
    expect(decisionSection('# 301 — A thing\n\n## Context\n\nWords.\n')).toBeNull();
  });

  it('runs to the end of the file when Decision is the last section', () => {
    expect(decisionSection('# 301\n\n## Decision\n\nThe last word.\n')).toBe('The last word.');
  });

  it('matches the heading case-insensitively, as the corpus is not uniform', () => {
    expect(decisionSection('# 301\n\n## decision\n\nLowercase heading.\n')).toBe('Lowercase heading.');
  });
});
