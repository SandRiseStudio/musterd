import { describe, expect, it } from 'vitest';
import { dailySeries, summarise, wilson, type PostureSample } from './roster-diversity.js';

/**
 * The instrument that asks the ROSTER whether a cross-family review was possible, instead of
 * inferring it from lanes that were already swept.
 *
 * Why it exists: ADR 277's Eval keys on swept closes, which arrive at ~0.6/day — n≈72 for a ±10pp
 * read, about 120 days. `family_posture` is already recorded on every `lane.ready_for_review` row
 * and has been since 2026-07-28, so the same question has n=84 available today. This file guards
 * the two ways that shortcut could go wrong: a denominator that quietly swallows rows which
 * recorded nothing, and a headline that reports `monoculture` alone as if it were the answer.
 */
const at = (day: number, state: PostureSample['state'], attesting = 2): PostureSample => ({
  ts: Date.UTC(2026, 7, day),
  state,
  attesting,
  families: state === 'diverse' ? { claude: 1, grok: 1 } : { claude: attesting },
});

describe('summarise', () => {
  it('counts the three postures the daemon actually records', () => {
    const s = summarise([at(1, 'diverse'), at(2, 'monoculture'), at(3, 'unknown', 1)]);
    expect(s.diverse).toBe(1);
    expect(s.monoculture).toBe(1);
    expect(s.unknown).toBe(1);
    expect(s.n).toBe(3);
  });

  // THE HEADLINE, and the thing most likely to be got wrong. `unknown` is <2 seats attesting, which
  // is not "we cannot tell whether a review was possible" — it is a roster too thin to hold two
  // seats, so a cross-family review was impossible for a *different* reason. Reporting monoculture
  // alone understates the condition; review.ts:231 is the definition this leans on.
  it('counts unknown as no-cross-family-possible, not as missing data', () => {
    const s = summarise([at(1, 'monoculture'), at(2, 'unknown', 1), at(3, 'diverse')]);
    expect(s.noCrossFamily).toBe(2);
    expect(s.noCrossFamilyShare).toBeCloseTo(2 / 3, 6);
  });

  it('is empty-safe and reports no share rather than dividing by zero', () => {
    const s = summarise([]);
    expect(s.n).toBe(0);
    expect(s.noCrossFamilyShare).toBeNull();
  });

  it('carries an interval, so a small n cannot be read as a precise number', () => {
    const wide = summarise(Array.from({ length: 6 }, (_, i) => at(i + 1, 'monoculture')));
    const tight = summarise(Array.from({ length: 200 }, (_, i) => at((i % 27) + 1, 'monoculture')));
    expect(wide.ci).not.toBeNull();
    expect(tight.ci).not.toBeNull();
    // Same point estimate (100%), but the small sample must not claim the same precision.
    expect(tight.ci!.hi - tight.ci!.lo).toBeLessThan(wide.ci!.hi - wide.ci!.lo);
  });
});

describe('wilson', () => {
  // Pinned against the published interval for p=0.25, n=18 — the figure ADR 277's amendment quotes
  // to show its own band was unreadable. If this drifts, that amendment is quoting a lie.
  it('reproduces the interval ADR 277 cites', () => {
    const { lo, hi } = wilson(0.25, 18)!;
    expect(lo * 100).toBeCloseTo(10.7, 1);
    expect(hi * 100).toBeCloseTo(48.1, 1);
  });

  it('abstains on an empty sample instead of returning 0-1', () => {
    expect(wilson(0, 0)).toBeNull();
  });

  it('narrows as n grows', () => {
    const a = wilson(0.5, 10)!;
    const b = wilson(0.5, 1000)!;
    expect(b.hi - b.lo).toBeLessThan(a.hi - a.lo);
  });
});

describe('dailySeries', () => {
  // The aggregate hides the shape. Measured 2026-08-17: 17/17 on 08-05 but 2/4 on 08-13 — diversity
  // appears when the non-claude seats are awake, so "how often does it clear" is a different and
  // arguably more actionable question than the headline share.
  it('groups by UTC day, newest last, with the bad count per day', () => {
    const s = dailySeries([
      at(5, 'monoculture'),
      at(5, 'monoculture'),
      at(6, 'diverse'),
      at(6, 'unknown', 1),
    ]);
    expect(s.map((d) => d.day)).toEqual(['2026-08-05', '2026-08-06']);
    expect(s[0]).toMatchObject({ n: 2, noCrossFamily: 2 });
    expect(s[1]).toMatchObject({ n: 2, noCrossFamily: 1 });
  });

  it('is empty-safe', () => {
    expect(dailySeries([])).toEqual([]);
  });
});
