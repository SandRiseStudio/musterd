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
    expect(empty.veilAlpha).toBeGreaterThan(0.6);
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
});
