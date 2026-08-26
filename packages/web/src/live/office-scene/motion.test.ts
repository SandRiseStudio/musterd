import { describe, expect, it } from 'vitest';
import { CANVAS_EASE, DUR, EASE_CSS, FRAME_MS, cssDuration, cssEase } from './motion';

describe('the motion scale', () => {
  it('every rung is a whole number of frames at 25fps', () => {
    for (const [name, ms] of Object.entries(DUR)) {
      expect(ms % FRAME_MS, `${name}=${String(ms)}ms is not a whole frame`).toBe(0);
    }
  });

  it('rungs ascend and are distinct', () => {
    const values = Object.values(DUR);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
  });

  it('the fastest rung is at least 3 frames — below that it reads as a snap on the stream', () => {
    expect(Math.min(...Object.values(DUR))).toBeGreaterThanOrEqual(3 * FRAME_MS);
  });

  it('renders CSS-ready strings', () => {
    expect(cssDuration('d2')).toBe('200ms');
    expect(cssEase('out')).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
  });

  it('canvas easings are normalised: f(0)=0, f(1)=1, monotonic', () => {
    for (const [name, f] of Object.entries(CANVAS_EASE)) {
      expect(f(0), name).toBeCloseTo(0, 6);
      expect(f(1), name).toBeCloseTo(1, 6);
      for (let t = 0; t < 1; t += 0.05) {
        expect(f(t + 0.05), `${name} monotonic at ${String(t)}`).toBeGreaterThanOrEqual(f(t) - 1e-9);
      }
    }
  });

  it('every CSS easing is a unit-interval bezier (x control points in [0,1])', () => {
    for (const [name, cp] of Object.entries(EASE_CSS)) {
      const [x1, , x2] = cp;
      expect(x1, name).toBeGreaterThanOrEqual(0);
      expect(x1, name).toBeLessThanOrEqual(1);
      expect(x2, name).toBeGreaterThanOrEqual(0);
      expect(x2, name).toBeLessThanOrEqual(1);
    }
  });
});
