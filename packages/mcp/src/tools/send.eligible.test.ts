import { describe, expect, it } from 'vitest';
import { normalizeTo } from './send.js';

/**
 * ADR NNN: `to` normalised by ARITY. The 0- and 1-element rows are what `coerce.ts` already
 * repaired, so they are regression guards here, not new behaviour — the only thing that changes is
 * that 2+ stops bouncing.
 */
describe('normalizeTo (ADR NNN)', () => {
  it('a bare name is a directed act', () => {
    expect(normalizeTo('stanley')).toEqual({
      to: { kind: 'member', name: 'stanley' },
      eligible: null,
    });
  });

  it('@team and @broadcast are unchanged', () => {
    expect(normalizeTo('@team')).toEqual({ to: { kind: 'team' }, eligible: null });
    expect(normalizeTo('@broadcast')).toEqual({ to: { kind: 'broadcast' }, eligible: null });
  });

  it('regression: an empty array falls back to @team, as coerce.ts already did', () => {
    expect(normalizeTo([])).toEqual({ to: { kind: 'team' }, eligible: null });
  });

  it('regression: a one-element array is a directed act, as coerce.ts already did', () => {
    expect(normalizeTo(['stanley'])).toEqual({
      to: { kind: 'member', name: 'stanley' },
      eligible: null,
    });
  });

  it('two names become a team act carrying the eligible set', () => {
    expect(normalizeTo(['stanley', 'izzo'])).toEqual({
      to: { kind: 'team' },
      eligible: ['stanley', 'izzo'],
    });
  });

  it('accepts the cap exactly', () => {
    expect(normalizeTo(['a', 'b', 'c', 'd']).eligible).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects five, and the message names the way out', () => {
    expect(() => normalizeTo(['a', 'b', 'c', 'd', 'e'])).toThrow(/@team/);
  });

  it('rejects an alias inside a list — a set is named seats or it is not a set', () => {
    expect(() => normalizeTo(['stanley', '@team'])).toThrow(/@team/);
    expect(() => normalizeTo(['@broadcast', 'izzo'])).toThrow(/@broadcast/);
  });

  it('trims and drops blanks, so a hand-typed list survives stray whitespace', () => {
    expect(normalizeTo([' stanley ', 'izzo', '  ']).eligible).toEqual(['stanley', 'izzo']);
  });

  it('a list that collapses to one name is a directed act, not a one-seat set', () => {
    expect(normalizeTo(['stanley', '   '])).toEqual({
      to: { kind: 'member', name: 'stanley' },
      eligible: null,
    });
  });
});
