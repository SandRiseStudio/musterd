import { describe, expect, test } from 'vitest';
import {
  HUE_MIN_SEPARATION,
  assignHue,
  defaultHue,
  hueConflict,
  hueSeparation,
  legacyHue,
} from './hue.js';

/** Every hue on the wheel, the way the roster would hold it. */
const WHEEL = Array.from({ length: 360 }, (_, h) => h);

describe('defaultHue', () => {
  test('is an integer on the wheel, stable per name, and spread across names', () => {
    const hues = ['miley', 'dolly', 'ryder', 'stanley', 'gptbot', 'nick'].map(defaultHue);
    for (const h of hues) {
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
    expect(defaultHue('miley')).toBe(defaultHue('miley'));
    expect(new Set(hues).size).toBe(hues.length);
  });

  test('uses the whole wheel — no band by kind', () => {
    // 200 names land in every one of the twelve 30° sectors; a banded hash could not.
    const sectors = new Set(
      Array.from({ length: 200 }, (_, i) => Math.floor(defaultHue(`seat-${i}`) / 30)),
    );
    expect(sectors.size).toBe(12);
  });
});

describe('legacyHue', () => {
  test('agents sit in the cool band and humans in the warm band, as the web painted them', () => {
    for (let i = 0; i < 50; i++) {
      const a = legacyHue(`agent-${i}`, 'agent');
      expect(a).toBeGreaterThanOrEqual(150);
      expect(a).toBeLessThanOrEqual(280);
      const h = legacyHue(`human-${i}`, 'human');
      expect(h >= 320 || h <= 70).toBe(true);
    }
  });
});

describe('hueSeparation', () => {
  test('is perceptual: fifteen HSL degrees of green are far closer than fifteen of cyan', () => {
    // Measured 2026-09-03: HSL 105→120 is ~5° of OKLCH hue, HSL 180→195 is ~27°.
    expect(hueSeparation(105, 120)).toBeLessThan(8);
    expect(hueSeparation(180, 195)).toBeGreaterThan(20);
  });

  test('is symmetric and wraps the wheel', () => {
    expect(hueSeparation(350, 10)).toBe(hueSeparation(10, 350));
    expect(hueSeparation(350, 10)).toBeLessThan(hueSeparation(350, 60));
    expect(hueSeparation(200, 200)).toBe(0);
  });
});

describe('hueConflict', () => {
  test('names the taken hue that sits too close, or null when the hue is clear', () => {
    expect(hueConflict(200, [205, 90])).toBe(205);
    expect(hueConflict(200, [90])).toBeNull();
    expect(hueConflict(200, [])).toBeNull();
  });

  test('sees across 359 → 0', () => {
    expect(hueConflict(2, [357])).toBe(357);
  });
});

describe('assignHue', () => {
  test('keeps the seed when nothing is near it', () => {
    expect(assignHue(200, [])).toBe(200);
    expect(assignHue(200, [60, 300])).toBe(200);
  });

  test('walks to the nearest clear hue when the seed collides', () => {
    const got = assignHue(200, [200]);
    expect(got).not.toBe(200);
    expect(hueSeparation(got, 200)).toBeGreaterThanOrEqual(HUE_MIN_SEPARATION);
    // Nearest, not merely clear: every hue between the seed and the pick is still too close.
    const between = got > 200 ? WHEEL.slice(201, got) : WHEEL.slice(got + 1, 200);
    for (const h of between) expect(hueSeparation(h, 200)).toBeLessThan(HUE_MIN_SEPARATION);
  });

  test('a team of twenty members assigned one after another is pairwise separated', () => {
    const taken: number[] = [];
    for (let i = 0; i < 20; i++) taken.push(assignHue(defaultHue(`seat-${i}`), taken));
    for (let i = 0; i < taken.length; i++)
      for (let j = i + 1; j < taken.length; j++)
        expect(hueSeparation(taken[i]!, taken[j]!)).toBeGreaterThanOrEqual(HUE_MIN_SEPARATION);
  });

  test('past a full wheel it still answers, with the most distinct hue left, and says so', () => {
    const taken: number[] = [];
    let crowded = 0;
    for (let i = 0; i < 40; i++) {
      const hue = assignHue(defaultHue(`seat-${i}`), taken);
      if (hueConflict(hue, taken) !== null) crowded++;
      taken.push(hue);
    }
    expect(crowded).toBeGreaterThan(0);
    // Never a duplicate, even when the separation cannot be honoured.
    expect(new Set(taken).size).toBe(taken.length);
  });
});
