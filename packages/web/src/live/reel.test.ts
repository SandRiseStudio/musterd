import { describe, expect, it } from 'vitest';
import { reelIndex, REEL_DWELL_MS } from './reel';

describe('reelIndex', () => {
  it('is 0 for an empty or single-item reel — nothing to cycle', () => {
    expect(reelIndex(0, 999_999)).toBe(0);
    expect(reelIndex(1, 999_999)).toBe(0);
  });

  it('advances one item per dwell and wraps', () => {
    expect(reelIndex(3, 0)).toBe(0);
    expect(reelIndex(3, REEL_DWELL_MS - 1)).toBe(0);
    expect(reelIndex(3, REEL_DWELL_MS)).toBe(1);
    expect(reelIndex(3, REEL_DWELL_MS * 2)).toBe(2);
    expect(reelIndex(3, REEL_DWELL_MS * 3)).toBe(0);
  });

  it('never indexes past the list — a shrinking reel must not read undefined', () => {
    for (const elapsed of [0, 5_000, 60_000, 3_600_000]) {
      for (const count of [1, 2, 7, 13]) {
        const i = reelIndex(count, elapsed);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(count);
      }
    }
  });

  it('treats nonsense elapsed time as the start rather than NaN', () => {
    expect(reelIndex(3, Number.NaN)).toBe(0);
    expect(reelIndex(3, -1)).toBe(0);
  });
});
