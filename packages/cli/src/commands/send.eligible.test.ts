import { describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import { parseRecipients } from './send.js';

/**
 * ADR 254: `--to a,b` names an eligible set. Mirrors the MCP surface's arity rules deliberately —
 * same behaviour, each package keeping its own error convention (CliError + exit code here).
 */
describe('parseRecipients (ADR 254)', () => {
  it('a single name is a directed act', () => {
    expect(parseRecipients('stanley')).toEqual({
      to: { kind: 'member', name: 'stanley' },
      eligible: null,
    });
  });

  it('@team and @broadcast are unchanged', () => {
    expect(parseRecipients('@team')).toEqual({ to: { kind: 'team' }, eligible: null });
    expect(parseRecipients('@broadcast')).toEqual({ to: { kind: 'broadcast' }, eligible: null });
  });

  it('regression: an unknown @alias still errors with the same guidance', () => {
    expect(() => parseRecipients('@nobody')).toThrow(/use @team or @broadcast/);
  });

  it('two names become a team act carrying the eligible set', () => {
    expect(parseRecipients('stanley,izzo')).toEqual({
      to: { kind: 'team' },
      eligible: ['stanley', 'izzo'],
    });
  });

  it('tolerates spaces around the commas a human will type', () => {
    expect(parseRecipients('stanley, izzo , wanderer').eligible).toEqual([
      'stanley',
      'izzo',
      'wanderer',
    ]);
  });

  it('accepts the cap exactly', () => {
    expect(parseRecipients('a,b,c,d').eligible).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects five names with exit code 2 and points at @team', () => {
    expect(() => parseRecipients('a,b,c,d,e')).toThrow(CliError);
    expect(() => parseRecipients('a,b,c,d,e')).toThrow(/@team/);
  });

  it('rejects an alias inside a list — a set is named seats or it is not a set', () => {
    expect(() => parseRecipients('stanley,@team')).toThrow(/on its own/);
  });

  it('a list that collapses to one name is a directed act, not a one-seat set', () => {
    expect(parseRecipients('stanley,')).toEqual({
      to: { kind: 'member', name: 'stanley' },
      eligible: null,
    });
    expect(parseRecipients('stanley, ,')).toEqual({
      to: { kind: 'member', name: 'stanley' },
      eligible: null,
    });
  });

  it('an empty or all-blank value falls back to @team', () => {
    expect(parseRecipients('')).toEqual({ to: { kind: 'team' }, eligible: null });
    expect(parseRecipients(' , ')).toEqual({ to: { kind: 'team' }, eligible: null });
  });
});
