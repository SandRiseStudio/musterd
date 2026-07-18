import { describe, expect, it } from 'vitest';
import {
  INITIAL_WINDOW,
  WINDOW_STEP,
  anchoredScrollTop,
  capNewest,
  expandedWindow,
  hiddenCount,
  windowCovering,
} from './window';

describe('stream windowing math', () => {
  it('hiddenCount: rows above the window, never negative', () => {
    expect(hiddenCount(200, 60)).toBe(140);
    expect(hiddenCount(60, 60)).toBe(0);
    expect(hiddenCount(10, 60)).toBe(0);
    expect(hiddenCount(0, 60)).toBe(0);
  });

  it('expandedWindow: grows by a step, clamped to total', () => {
    expect(expandedWindow(60, 200)).toBe(60 + WINDOW_STEP);
    expect(expandedWindow(180, 200)).toBe(200);
    expect(expandedWindow(200, 200)).toBe(200);
    // A short history never yields a window larger than itself.
    expect(expandedWindow(INITIAL_WINDOW, 10)).toBe(10);
  });

  describe('windowCovering', () => {
    it('returns the current size when the index is already rendered', () => {
      // total 200, window 60 → indices 140..199 visible.
      expect(windowCovering(140, 200, 60)).toBe(60);
      expect(windowCovering(199, 200, 60)).toBe(60);
    });

    it('expands in whole steps to reach an older index', () => {
      // index 100 needs 100 rows-from-end; one step past 60 covers it.
      expect(windowCovering(100, 200, 60)).toBe(120);
      // index 20 needs 180; two steps (60→180) exactly cover it.
      expect(windowCovering(20, 200, 60)).toBe(180);
      // index 0 needs everything.
      expect(windowCovering(0, 200, 60)).toBe(200);
    });

    it('clamps to total even when a whole step would overshoot', () => {
      expect(windowCovering(0, 130, 60)).toBe(130);
    });

    it('a revealed index is strictly inside the new window (context above the cut)', () => {
      const size = windowCovering(100, 200, 60);
      const firstVisible = 200 - size;
      expect(firstVisible).toBeLessThanOrEqual(100);
    });
  });

  it('capNewest: keeps the newest max, returns the same array under cap', () => {
    const small = [1, 2, 3];
    expect(capNewest(small, 5)).toBe(small); // referential no-op under cap
    const big = Array.from({ length: 10 }, (_, i) => i);
    expect(capNewest(big, 4)).toEqual([6, 7, 8, 9]); // newest tail survives
  });

  it('anchoredScrollTop: viewport stays glued to the same content after a prepend', () => {
    // 600px of rows added above → scrollTop moves down by exactly 600.
    expect(anchoredScrollTop(0, 2000, 2600)).toBe(600);
    expect(anchoredScrollTop(150, 2000, 2600)).toBe(750);
    // No growth → unchanged.
    expect(anchoredScrollTop(150, 2000, 2000)).toBe(150);
  });
});
