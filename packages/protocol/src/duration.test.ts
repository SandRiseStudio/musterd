import { describe, expect, it } from 'vitest';
import { shortDuration } from './duration.js';

const s = 1000;
const m = 60 * s;
const h = 60 * m;
const d = 24 * h;

describe('shortDuration', () => {
  it('picks the largest whole unit that fits', () => {
    expect(shortDuration(0)).toBe('0s');
    expect(shortDuration(45 * s)).toBe('45s');
    expect(shortDuration(90 * s)).toBe('1m');
    expect(shortDuration(90 * m)).toBe('1h');
    expect(shortDuration(36 * h)).toBe('1d');
    expect(shortDuration(5 * d)).toBe('5d');
  });

  it('rounds to the nearest second before bucketing, so 59.6s is a minute', () => {
    expect(shortDuration(59_600)).toBe('1m');
    expect(shortDuration(59_400)).toBe('59s');
  });

  /**
   * The regression this function exists to end. `incidentBannerLines` shipped in #856 with a private
   * copy that had no day bucket, so the MCP incident banner silently went from "open 5d" to
   * "open 120h" — identical under 24h, which is why every fixture missed it. The day bucket is not
   * a nicety here: the incident you most need to read at a glance is the one that has been open
   * longest, and hours stop being legible about a day in.
   */
  it('keeps a DAY bucket — the regression that motivated one shared formatter', () => {
    expect(shortDuration(26 * h)).toBe('1d');
    expect(shortDuration(2 * d)).toBe('2d');
    expect(shortDuration(5 * d)).toBe('5d');
  });

  /**
   * A duration is derived by subtracting two clocks that need not agree — a daemon's `opened_at`
   * against a seat's `Date.now()`. `waitedFor` would render that skew as "-3s", which reads as a
   * bug in the thing being described rather than in the arithmetic. Clamping is the one behaviour
   * the newer copy had right, so it survives the merge.
   */
  it('clamps a backwards interval to zero rather than printing a negative age', () => {
    expect(shortDuration(-3 * s)).toBe('0s');
    expect(shortDuration(-5 * d)).toBe('0s');
  });
});
