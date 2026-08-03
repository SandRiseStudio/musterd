import { describe, expect, it } from 'vitest';
import { shouldDismiss, zoomTransform } from './boardOverlayMath';

describe('zoomTransform — the panel folds onto the wall rect', () => {
  const panel = { x: 100, y: 50, width: 1000, height: 800 };

  it('translates by the rect delta and scales to the rect ratio', () => {
    const t = zoomTransform({ x: 700, y: 250, width: 100, height: 80 }, panel);
    expect(t).toBe('translate(600.0px, 200.0px) scale(0.1000, 0.1000)');
  });

  it('never divides by a degenerate panel', () => {
    const t = zoomTransform({ x: 0, y: 0, width: 100, height: 80 }, { x: 0, y: 0, width: 0, height: 0 });
    expect(t).toContain('scale(1.0000, 1.0000)');
  });

  it('appends a tilt when asked — the board comes off its tape at an angle', () => {
    const t = zoomTransform({ x: 700, y: 250, width: 100, height: 80 }, panel, -4);
    expect(t).toBe('translate(600.0px, 200.0px) scale(0.1000, 0.1000) rotate(-4deg)');
  });

  it('stays square at zero tilt — no rotate() to composite for nothing', () => {
    expect(zoomTransform({ x: 700, y: 250, width: 100, height: 80 }, panel)).not.toContain('rotate');
    expect(zoomTransform({ x: 700, y: 250, width: 100, height: 80 }, panel, 0)).not.toContain('rotate');
  });
});

describe('shouldDismiss — Escape closes the overlay, except where inner chrome owns it', () => {
  it('closes on a plain Escape', () => {
    expect(shouldDismiss({ key: 'Escape', defaultPrevented: false }, false)).toBe(true);
  });

  it('yields to a defaultPrevented Escape', () => {
    expect(shouldDismiss({ key: 'Escape', defaultPrevented: true }, false)).toBe(false);
  });

  it('yields when the keypress was born inside the compose card / seat picker', () => {
    expect(shouldDismiss({ key: 'Escape', defaultPrevented: false }, true)).toBe(false);
  });

  it('ignores every other key', () => {
    expect(shouldDismiss({ key: 'Enter', defaultPrevented: false }, false)).toBe(false);
  });
});
