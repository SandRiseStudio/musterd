import { describe, expect, it } from 'vitest';
import { computeLightEnv } from './lighting';

/** The office lighting model: natural light follows the PST clock, overhead follows occupancy, desk lamps
 * follow the dark. These lock the behaviour the render/CSS wiring depends on. */
describe('computeLightEnv', () => {
  it('is bright at midday and dark at night', () => {
    const noon = computeLightEnv(12, true);
    const night = computeLightEnv(23, true);
    expect(noon.daylight).toBeGreaterThan(0.95);
    expect(night.daylight).toBe(0);
    // more daylight ⇒ more ambient ⇒ less veil
    expect(noon.veilAlpha).toBeLessThan(night.veilAlpha);
    expect(noon.veilAlpha).toBeLessThan(0.05);
  });

  it('ramps up through dawn and down through dusk (no hard switch)', () => {
    const preDawn = computeLightEnv(4, true).daylight; // before the dawn window
    const midDawn = computeLightEnv(6.25, true).daylight; // inside it
    const day = computeLightEnv(13, true).daylight;
    const midDusk = computeLightEnv(18.75, true).daylight; // inside the dusk window
    const postDusk = computeLightEnv(21, true).daylight;
    expect(preDawn).toBe(0);
    expect(midDawn).toBeGreaterThan(0.1);
    expect(midDawn).toBeLessThan(0.95);
    expect(day).toBeGreaterThan(0.95);
    expect(midDusk).toBeGreaterThan(0.05);
    expect(midDusk).toBeLessThan(0.95);
    expect(postDusk).toBe(0);
  });

  it('turns overhead lights on only when the office is occupied', () => {
    expect(computeLightEnv(14, true).overheadOn).toBe(true);
    expect(computeLightEnv(14, false).overheadOn).toBe(false);
  });

  it('an empty office after dark goes darker than an occupied one (lights off)', () => {
    const occupied = computeLightEnv(23, true);
    const empty = computeLightEnv(23, false);
    // With nobody in, the overhead fill drops out → the room falls to the floor level → a heavier veil.
    expect(empty.veilAlpha).toBeGreaterThan(occupied.veilAlpha);
    // An absolute floor as well as the comparison, so "darker than occupied" can't be satisfied by a
    // room that is barely veiled at all. 0.45, not the 0.6 this asserted before 2026-09-03: the veil's
    // ceiling came down (VEIL_MAX 0.82 → 0.62) when the flat wash was found to be flattening the room
    // rather than dimming it, and light was moved into the fixed fills and the warm sources instead.
    // The old number pinned the old ceiling, not the property — an empty office is still emphatically
    // the darkest state the model has, which is what this test is for.
    expect(empty.veilAlpha).toBeGreaterThan(0.45);
  });

  it('daytime keeps a bright empty office (natural light, no one needed)', () => {
    const emptyNoon = computeLightEnv(12, false);
    expect(emptyNoon.veilAlpha).toBeLessThan(0.15); // sun carries the room even with the overhead off
  });

  it('switches desk lamps on when it is dark, off in daylight', () => {
    expect(computeLightEnv(12, true).lampsOn).toBe(false); // bright noon — lamps off
    expect(computeLightEnv(21, true).lampsOn).toBe(true); // night — lamps on
    expect(computeLightEnv(6, true).lampsOn).toBe(true); // early dawn, still dim — lamps on
  });

  it('warms the sky tint at the horizon and cools it at high sun', () => {
    const dusk = computeLightEnv(19, true).skyTint;
    const noon = computeLightEnv(12.5, true).skyTint;
    const red = (rgb: string) => Number(/rgb\((\d+)/.exec(rgb)![1]);
    const blue = (rgb: string) => Number(/,\s*(\d+)\)/.exec(rgb)![1]);
    // golden-hour tint skews warm (more red than blue); midday skews cool (blue ≳ red)
    expect(red(dusk)).toBeGreaterThan(blue(dusk));
    expect(blue(noon)).toBeGreaterThanOrEqual(red(noon));
  });

  it('normalizes hours outside 0..24', () => {
    expect(computeLightEnv(36, true).daylight).toBe(computeLightEnv(12, true).daylight); // 36 → 12
    expect(computeLightEnv(-2, true).daylight).toBe(computeLightEnv(22, true).daylight); // -2 → 22
  });

  it('carries the (normalized) clock the daylight was computed from — the wall clock reads it', () => {
    // The hands and the daylight come from one number, so they can never tell different times.
    expect(computeLightEnv(13.5, true).hours).toBe(13.5);
    expect(computeLightEnv(36, true).hours).toBe(12);
    expect(computeLightEnv(-2, true).hours).toBe(22);
  });

  /** Off-shift lighting (presence spec §5.5): outside the team's declared working hours the ceiling
   * bank is off, leaving only a small after-hours spill — a late worker reads as a lamp pool in a
   * dark office, not a fully lit floor. No declared hours → the flavor never appears. */
  describe('off shift', () => {
    it('an occupied office off shift at night goes darker than in shift, but not as dark as empty', () => {
      const inShift = computeLightEnv(23, true, true);
      const offShift = computeLightEnv(23, true, false);
      const empty = computeLightEnv(23, false, false);
      expect(offShift.veilAlpha).toBeGreaterThan(inShift.veilAlpha);
      expect(offShift.veilAlpha).toBeLessThan(empty.veilAlpha); // the after-hours spill keeps bodies readable
    });

    it('turns the ceiling bank off outside working hours even when occupied', () => {
      expect(computeLightEnv(23, true, false).overheadOn).toBe(false);
      expect(computeLightEnv(23, true, true).overheadOn).toBe(true);
    });

    it('keeps desk lamps available off shift — the late worker works by lamp', () => {
      expect(computeLightEnv(23, true, false).lampsOn).toBe(true);
    });

    it('flags afterHours only when a schedule says so', () => {
      expect(computeLightEnv(23, true, false).afterHours).toBe(true);
      expect(computeLightEnv(23, true, true).afterHours).toBe(false);
      expect(computeLightEnv(23, true, null).afterHours).toBe(false);
      expect(computeLightEnv(23, true).afterHours).toBe(false);
    });

    it('no declared hours (null) behaves exactly as before', () => {
      const legacy = computeLightEnv(23, true);
      const nullShift = computeLightEnv(23, true, null);
      expect(nullShift).toEqual(legacy);
      expect(nullShift.overheadOn).toBe(true);
    });

    it('daylight still carries an off-shift office — the sun ignores the schedule', () => {
      expect(computeLightEnv(12, true, false).veilAlpha).toBeLessThan(0.15);
    });
  });
});
