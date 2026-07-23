import { describe, expect, it } from 'vitest';
import { bumpBrewFormula, parseBumpArgs } from '../scripts/bump-brew-formula.ts';

describe('bump-brew-formula (ADR 156)', () => {
  it('rewrites the version line', () => {
    const raw = 'class Musterd < Formula\n  version "0.2.0"\nend\n';
    expect(bumpBrewFormula(raw, '0.3.0')).toContain('version "0.3.0"');
  });

  it('parseBumpArgs requires --version', () => {
    expect(parseBumpArgs(['--version', '0.3.1'])).toBe('0.3.1');
    expect(() => parseBumpArgs([])).toThrow(/Usage/);
  });
});
