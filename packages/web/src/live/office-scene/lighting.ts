/**
 * The office lighting model — one source of truth for how the room is lit, derived from real-world PST
 * time-of-day and whether anyone's in. The scene had three *decoupled* notions of light (baked per-face
 * shading, hand-placed contact shadows, and a CSS "day-cycle" wash on a fake 210s loop); this replaces the
 * loop with an honest clock and gives every light surface one place to read from.
 *
 * Three physical lights, all keyed off `computeLightEnv`:
 *  - **Natural light** — a sky wash whose strength + warmth follow the PST sun: amber at dawn/dusk, bright
 *    and cool at noon, gone at night. Rendered as the `.lc-amb-daylight` CSS overlay (see index.ts).
 *  - **Overhead lights** — the ceiling fill. On whenever the office is occupied, off when everyone's gone
 *    home; raises the interior `ambient` level so an occupied room reads lit even after dark.
 *  - **Desk lamps** — switch on when it's dark out (like a person would), only at an occupied desk. Warm
 *    floor pools that punch through the night veil (see render.ts).
 *
 * The interior `ambient` (natural + overhead + a never-black floor) becomes a canvas "night veil": the
 * darker the room, the more we paint over it. So an empty office at 9pm goes properly dark, the same office
 * with someone working glows from the overhead + their lamp, and midday is bright whether or not anyone's in.
 */

/** Time-of-day → lighting boundaries (PST hours, 0..24). Dawn/dusk are ramps, not switches. */
const DAWN_START = 5.0;
const DAWN_END = 7.5;
const DUSK_START = 17.5;
const DUSK_END = 20.0;

/** Below this daylight level, people flick their desk lamp (and the overhead) on. */
const LAMP_THRESHOLD = 0.42;

/** Interior light budget: a small never-black floor, the sun through the windows, and the ceiling fill. */
const FLOOR_LIGHT = 0.08;
const NATURAL_GAIN = 0.9;
const OVERHEAD_FILL = 0.52;
/** How opaque the darkest possible night veil gets — kept under 1 so a dark room still reads. */
const VEIL_MAX = 0.82;

/** Cool deep-blue the room falls toward at night (the veil colour). */
const VEIL_COLOR = 'rgb(15, 21, 38)';

export interface LightEnv {
  /** The office clock this envelope was computed from: hour-of-day 0..24 in PST, normalised. The wall
   * clock reads it, so the hands and the daylight always agree — including under the `?light=HH` override. */
  hours: number;
  /** 0 (deep night) … 1 (bright midday) — how much natural light is entering. */
  daylight: number;
  /** Overall interior light level 0..1 (natural + overhead + floor). Drives the night veil. */
  ambient: number;
  /** Overhead ceiling lights — on whenever the office is occupied. */
  overheadOn: boolean;
  /** Desk lamps want to be on (dark enough outside). Still gated per-desk on occupancy in render. */
  lampsOn: boolean;
  /** Alpha of the night veil painted over the interior — `(1 - ambient)`, capped. */
  veilAlpha: number;
  /** The veil colour (cool near-black). */
  veilColor: string;
  /** Warm→cool sky tint for the natural-light wash (CSS overlay), as an `rgb()` string. */
  skyTint: string;
  /** Strength 0..1 of the natural-light wash overlay. */
  skyStrength: number;
}

/** Smoothstep between edges a→b, clamped to [0,1]. */
function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Blend two `[r,g,b]` triples. */
function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
}

const SKY_COOL: [number, number, number] = [206, 226, 244]; // bright blue-white midday
const SKY_WARM: [number, number, number] = [255, 178, 96]; // amber golden-hour

/**
 * Compute the office lighting for a given PST time-of-day and occupancy.
 * @param pstHours  hour-of-day in America/Los_Angeles, 0..24 (e.g. 13.5 = 1:30pm).
 * @param occupied  is anyone currently in the office? (drives the overhead lights)
 */
export function computeLightEnv(pstHours: number, occupied: boolean): LightEnv {
  const h = ((pstHours % 24) + 24) % 24;
  // Daylight: 0 before dawn, ramps to 1 across the dawn window, holds at midday, ramps back down at dusk.
  const rise = smooth(DAWN_START, DAWN_END, h);
  const fall = 1 - smooth(DUSK_START, DUSK_END, h);
  const daylight = Math.min(rise, fall);

  // Warmth peaks at the horizon (dawn/dusk) and is lowest at high sun — a golden-hour parabola.
  const warmth = Math.max(0, Math.min(1, daylight * (1 - daylight) * 4));
  const [r, g, b] = mix(SKY_COOL, SKY_WARM, warmth);

  const overheadOn = occupied;
  const natural = daylight * NATURAL_GAIN;
  const overhead = overheadOn ? OVERHEAD_FILL : 0;
  const ambient = Math.min(1, FLOOR_LIGHT + natural + overhead);

  return {
    hours: h,
    daylight,
    ambient,
    overheadOn,
    lampsOn: daylight < LAMP_THRESHOLD,
    veilAlpha: (1 - ambient) * VEIL_MAX,
    veilColor: VEIL_COLOR,
    skyTint: `rgb(${r}, ${g}, ${b})`,
    // The wash is strongest mid-morning/afternoon and eased off at flat noon (where face-shading carries
    // it) and at night (where the veil takes over) — so it reads as *entering* light, not a flat filter.
    skyStrength: daylight * 0.5,
  };
}

/** A fully-lit daytime env — the safe default for any renderer that hasn't wired the clock yet. */
export const DAY_ENV: LightEnv = computeLightEnv(12, true);
