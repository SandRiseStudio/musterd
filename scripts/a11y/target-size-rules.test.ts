import { describe, expect, it } from 'vitest';
import { MIN, distToBox, judge, overlappingPairs, overlaps } from './target-size-rules.mjs';

/**
 * The spacing exception is the reason this file exists.
 *
 * WCAG 2.5.8 is not "every target is 24×24" — an undersized target CONFORMS when nothing else is
 * within reach of it. A gate that implements the size half and skips the spacing half fails
 * conforming markup, and a gate that fails conforming markup gets switched off; that is the
 * failure mode the lane (01M32HG5GJ) named before a line of this was written. So the clause is
 * unit-tested against worked shapes here, where it costs no browser, and the browser half only has
 * to be right about geometry it reads rather than geometry it judges.
 */

/** A target with the fields the in-page walker returns. Sizes are CSS px, viewport-relative. */
const t = (x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => ({
  x,
  y,
  w,
  h,
  name: `${w}x${h}@${x},${y}`,
  sel: 'a',
  inline: false,
  essential: null,
  ...extra,
});

describe('judge — the 2.5.8 clauses, in the spec’s own order', () => {
  it('a target at or above 24x24 passes on SIZE', () => {
    expect(judge(t(0, 0, 24, 24), []).verdict).toBe('size');
    expect(judge(t(0, 0, 200, 48), []).verdict).toBe('size');
  });

  it('one pixel under on EITHER axis is no longer a size pass', () => {
    // The audited nav links were 21-22px TALL and comfortably wide; a gate that checks area, or
    // only width, reports them green. Both axes, independently.
    expect(judge(t(0, 0, 45, 22), []).verdict).not.toBe('size');
    expect(judge(t(0, 0, 23, 40), []).verdict).not.toBe('size');
  });

  it('an undersized target with nothing near it passes on SPACING, not as a failure', () => {
    const lone = t(0, 0, 20, 20);
    const faraway = t(500, 500, 40, 40);
    expect(judge(lone, [lone, faraway]).verdict).toBe('spacing');
  });

  it('an undersized target fails when its 24px circle reaches another target', () => {
    const small = t(0, 0, 20, 20); // centre (10,10)
    const neighbour = t(16, 0, 40, 40); // 6px from that centre — inside the 12px radius
    const v = judge(small, [small, neighbour]);
    expect(v.verdict).toBe('fail');
    expect(v.why).toContain('circle reaches');
  });

  it('two undersized targets fail when their centres are under 24px apart', () => {
    // Neither circle reaches the OTHER'S BOX (both boxes are 8px wide and 15px apart edge to
    // edge... they are not), so this is the clause the box test alone would miss: the spec also
    // forbids two undersized targets' circles intersecting.
    const a = t(0, 0, 8, 8); // centre (4,4)
    const b = t(0, 20, 8, 8); // centre (4,24) — 20px apart, under 24
    expect(distToBox({ x: 4, y: 4 }, b)).toBeGreaterThanOrEqual(MIN / 2);
    expect(judge(a, [a, b]).verdict).toBe('fail');
    expect(judge(a, [a, b]).why).toContain('another undersized');
  });

  it('INLINE beats size — a 17px link in a sentence is exempt, not a defect', () => {
    // /watch's closing repo URL is the worked example. Getting this wrong in the strict direction
    // is how the gate becomes noise someone deletes.
    const v = judge(t(0, 0, 180, 17, { inline: true }), []);
    expect(v.verdict).toBe('inline');
  });

  it('ESSENTIAL is read before everything and carries its reason into the report', () => {
    const v = judge(t(0, 0, 8, 8, { essential: 'a map pin at a coordinate' }), []);
    expect(v.verdict).toBe('essential');
    expect(v.why).toBe('a map pin at a coordinate');
  });

  it('an EMPTY reason still counts as declared — an attribute with no value is a real exemption', () => {
    // `data-a11y-target-essential` with no value parses as ''. Treating '' as "not exempt" would
    // silently fail markup an author believed they had exempted, which is the confusing direction.
    expect(judge(t(0, 0, 8, 8, { essential: '' }), []).verdict).toBe('essential');
  });
});

/**
 * The house floor is a SECOND standard, and the tests that matter are the ones about the boundary
 * between it and the spec. Measured 2026-09-21 (lane 01M32HG5GJ): the 2026-09-21 audit's 21-22px
 * nav links CONFORM to 2.5.8 via the spacing exception — shrinking the built nav back to 20px and
 * re-sweeping passed. The audit was wrong about the spec and the team is still right to want 24px.
 * Both of those stay true only while the gate keeps them apart.
 */
describe('the house floor — stricter than the spec, and never confused with it', () => {
  it('fails an undersized target in the shared chrome that the SPEC would pass on spacing', () => {
    const navLink = t(0, 0, 33, 22, { chrome: true });
    expect(judge(navLink, [navLink]).verdict).toBe('house');
    // The same box outside the chrome conforms, and the gate must say so.
    const proseLink = t(0, 0, 33, 22);
    expect(judge(proseLink, [proseLink]).verdict).toBe('spacing');
  });

  it('says in the row itself that this is NOT a WCAG failure', () => {
    // The gate prints this line in CI. If it ever reads as a standards violation, we are making a
    // false accessibility claim about our own site, in our own logs.
    const v = judge(t(0, 0, 33, 22, { chrome: true }), []);
    expect(v.why).toContain('CONFORMS to 2.5.8');
    expect(v.why).toContain('not a WCAG failure');
  });

  it('does not fire on a chrome target that is already 24x24', () => {
    expect(judge(t(0, 0, 44, 44, { chrome: true }), []).verdict).toBe('size');
  });

  it('yields to an explicit essential declaration, which is the only way to opt out', () => {
    expect(judge(t(0, 0, 8, 8, { chrome: true, essential: 'a drag handle' }), []).verdict).toBe(
      'essential',
    );
  });
});

describe('overlappingPairs', () => {
  it('reports a partial overlap', () => {
    const a = t(0, 0, 40, 40);
    const b = t(30, 30, 40, 40);
    expect(overlappingPairs([a, b])).toHaveLength(1);
  });

  it('does NOT report containment — a button inside a card-link is a nesting, not a collision', () => {
    const card = t(0, 0, 300, 200);
    const button = t(10, 10, 60, 40);
    expect(overlappingPairs([card, button])).toHaveLength(0);
  });

  it('touching edges do not overlap', () => {
    expect(overlaps(t(0, 0, 40, 40), t(40, 0, 40, 40))).toBe(false);
  });

  it('catches an overlap between two targets that are BOTH comfortably 24x24', () => {
    // The case the 01M32GF49Z fix produced: padding grown to satisfy the size clause until the two
    // boxes collided. A size-only gate goes green on exactly this.
    const a = t(0, 0, 44, 44);
    const b = t(0, 40, 44, 44);
    expect(overlappingPairs([a, b])).toHaveLength(1);
  });
});

describe('distToBox', () => {
  it('is zero inside the box and the euclidean gap outside it', () => {
    expect(distToBox({ x: 10, y: 10 }, t(0, 0, 40, 40))).toBe(0);
    expect(distToBox({ x: 0, y: 0 }, t(3, 4, 10, 10))).toBe(5);
  });
});
