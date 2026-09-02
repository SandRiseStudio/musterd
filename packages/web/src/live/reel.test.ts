import { describe, expect, it } from 'vitest';
import { reelIndex, reelTicks, REEL_DWELL_MS } from './reel';

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

/**
 * The reel's tick guard. Every case here was uncovered until 2026-09-02: the condition lived inline
 * in `AsksReel`'s effect, and this package renders components with `react-dom/server`, where effects
 * never run. Deleting half the condition kept all 867 web tests green — which is what dolly's #1158
 * review predicted and what a mutation run confirmed before these tests were written.
 */
describe('reelTicks — when the broadcast rail needs a clock', () => {
  it('ticks for a countdown even with nothing to rotate', () => {
    // One loud ask: no rotation, but its "4m left" has to move.
    expect(reelTicks(1, 1)).toBe(true);
  });

  it('ticks for a rotation even with NOTHING loud — the case a stream actually hits', () => {
    // The regression this guard exists for. Since `applyTierClock` a stale ask is no longer loud, so
    // a stage can hold only lanes in review: zero loud, several cards. Gating on loudness alone
    // freezes the rail on whichever card it first drew, for the length of the broadcast.
    expect(reelTicks(0, 2)).toBe(true);
    expect(reelTicks(0, 9)).toBe(true);
  });

  it('does NOT tick with one settled card and nothing to turn', () => {
    // The other half of the contract, and the reason the guard exists at all: idle cost is paid by
    // every viewer, for the length of a stream measured in hours.
    expect(reelTicks(0, 1)).toBe(false);
  });

  it('does NOT tick with an empty rail', () => {
    expect(reelTicks(0, 0)).toBe(false);
  });
});
