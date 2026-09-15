import { describe, expect, it } from 'vitest';
import { isColour, isLength, valueKind } from './css-value-kind.ts';

/*
 * These predicates decide what `tokens:check` is willing to judge, so the interesting cases are the
 * boundaries — a value it misreads is either a false failure someone has to work around or a hole
 * like the one this module was written to close.
 */
describe('isColour', () => {
  it('accepts the literal colour forms the stylesheets actually use', () => {
    for (const v of [
      '#fff',
      '#f3e2c3',
      '#f3e2c380',
      'rgb(1, 2, 3)',
      'rgba(43, 31, 19, 0.72)',
      'hsl(210, 40%, 50%)',
      'oklch(0.7 0.1 200)',
      'color-mix(in srgb, var(--a) 20%, transparent)',
    ]) {
      expect(isColour(v), v).toBe(true);
    }
  });

  it('rejects lengths, so the two kinds cannot be confused', () => {
    for (const v of ['13px', '0.85em', '100%', '2.5rem']) expect(isColour(v), v).toBe(false);
  });
});

describe('isLength', () => {
  it('accepts the length units the office chrome is written in', () => {
    for (const v of ['13px', '7.5px', '0.86em', '1.5rem', '100%', '48vh', '20cqw', '-2px']) {
      expect(isLength(v), v).toBe(true);
    }
  });

  /*
   * The exemption this gate must not eat. A bare number (`--i`, a stagger index) and a duration
   * (`--lc-mote-delay`) are parametric by design and legitimately undefined-with-a-fallback — the
   * same idiom the colour arm exempts by scanning `setProperty`. Reading either as a length would
   * turn the correct idiom into a build failure, which is how a gate gets disabled instead of fixed.
   */
  it('rejects bare numbers and durations — those are the parametric idiom, not lengths', () => {
    for (const v of ['0', '3', '1.5', '200ms', '0.4s', '90deg']) {
      expect(isLength(v), v).toBe(false);
    }
  });

  it('rejects a var() chain — deferring to another token claims no value of its own', () => {
    expect(isLength('var(--lc-type-body)')).toBe(false);
    expect(isLength('var(--lc-type-body, 11.5px)')).toBe(false);
  });

  it('rejects a calc() — it may resolve to a length but claims nothing this gate can compare', () => {
    expect(isLength('calc(100% - 12px)')).toBe(false);
  });
});

describe('valueKind', () => {
  it('names the kind so a finding can say which arm caught it', () => {
    expect(valueKind('#f3e2c3')).toBe('colour');
    expect(valueKind('11.5px')).toBe('length');
    expect(valueKind('200ms')).toBe('other');
    expect(valueKind('3')).toBe('other');
  });

  /*
   * The whole point of the lane. Before this, `tokens:check` judged colour and skipped everything
   * else, so `color: var(--nope, #ff0000)` failed the build and `font-size: var(--nope, 13px)` —
   * the identical lie, one property over — passed it. Measured 2026-08-28; see
   * docs/wiki/constraint-outlives-its-premise.md.
   */
  it('treats a length fallback as judgeable, which is the hole this closes', () => {
    expect(valueKind('13px')).not.toBe('other');
  });
});
