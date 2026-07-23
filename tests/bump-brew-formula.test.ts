import { describe, expect, it } from 'vitest';
import {
  bumpBrewFormula,
  parseBumpArgs,
  tarballUrl,
} from '../scripts/bump-brew-formula.ts';

describe('bump-brew-formula (ADR 156)', () => {
  it('rewrites url + sha256 for the version', () => {
    const raw = `class Musterd < Formula
  url "https://registry.npmjs.org/@musterd/cli/-/cli-0.2.0.tgz"
  sha256 "aaa"
end
`;
    const next = bumpBrewFormula(raw, '0.3.1', 'bbb');
    expect(next).toContain(tarballUrl('0.3.1'));
    expect(next).toContain('sha256 "bbb"');
  });

  it('parseBumpArgs requires --version', () => {
    expect(parseBumpArgs(['--version', '0.3.1'])).toBe('0.3.1');
    expect(() => parseBumpArgs([])).toThrow(/Usage/);
  });
});
