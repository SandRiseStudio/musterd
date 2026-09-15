/**
 * A member's colour is one number: a hue, 0–359, an HSL degree.
 *
 * Why a hue and not a hex: every surface that paints a member derives the rest of the colour from
 * this number — the fill on the floor, the avatar deepened until white initials clear AA, the name
 * as ink on paper. Those derivations solve for lightness *from the hue*, which is what keeps every
 * member colour readable without a contrast gate on the human who chose it. Store a hex and that
 * contract is gone. Design: docs/superpowers/specs/2026-09-03-member-hue-design.md.
 *
 * Why the distance between two hues is measured in OKLCH and not in HSL degrees: HSL hue is not
 * perceptually uniform. Measured on 2026-09-03 at the web's fill (`hsl(h, 68%, 62%)`), fifteen HSL
 * degrees between 105° and 120° is about five degrees of OKLCH hue (ΔE 0.026 — two greens), while
 * the same fifteen between 180° and 195° is twenty-seven (ΔE 0.09 — cyan against blue). A wheel
 * divided by HSL degrees would seat a third of the team in greens that read as one. So the stored
 * number stays an HSL degree (it is what CSS and the canvas consume) and `hueSeparation` converts
 * both ends to OKLCH before it measures.
 */

export type HueKind = 'agent' | 'human';

/**
 * Two hues closer than this, in OKLCH degrees, are one colour to a glance.
 *
 * Twelve, not fifteen, and the reason is measured: `assignHue` places seats greedily from hashed
 * seeds, and a greedy walk fits fewer than the 360/separation the arithmetic promises — at fifteen
 * it seated 17–20 members over fifty trials (median 18) before the wheel was full, and the dogfood
 * team holds eighteen. At twelve it seats 22–26 (median 24), with a fill-to-fill ΔE of about 0.035
 * at the closest — still two colours. 2026-09-03.
 */
export const HUE_MIN_SEPARATION = 12;

/** The saturation and lightness the web paints a member's fill at — the point at which separation
 *  is measured, so "far enough apart" means far enough apart where people actually look. */
const FILL_SAT = 68;
const FILL_LIGHT = 62;

/** The golden-ratio hash the web has always used, as a unit interval. */
function unit(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (h * 0.618033988749895) % 1;
}

/**
 * The hue a new member starts from: the name hashed over the whole wheel. A seed, not an answer —
 * `assignHue` walks it clear of the teammates already seated.
 */
export function defaultHue(name: string): number {
  return Math.floor(unit(name) * 360) % 360;
}

/**
 * The hue the web painted a member with before hues were stored: agents in a cool band
 * (150°–280°), humans in a warm one (320°–70°). Kept so `team hue --assign-missing` can seed an
 * existing seat with the colour people already know it by and move only the ones that collide.
 * The web's `memberHue` fallback computes the same number; the web test pins them equal.
 */
export function legacyHue(name: string, kind: HueKind): number {
  const t = unit(name);
  return kind === 'human' ? Math.round((320 + t * 110) % 360) : Math.round(150 + t * 130);
}

/* ─── OKLCH hue of an HSL fill ───────────────────────────────────────────────────────────────── */

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** OKLCH hue angle (degrees) of an sRGB triple — Björn Ottosson's OKLab, standard matrices. */
function oklchHue([r, g, b]: [number, number, number]): number {
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}

const OKLCH_HUE: number[] = Array.from({ length: 360 }, (_, h) =>
  oklchHue(hslToRgb(h, FILL_SAT, FILL_LIGHT)),
);

function wrap(h: number): number {
  return ((Math.round(h) % 360) + 360) % 360;
}

/** Perceptual distance between two stored hues, in OKLCH degrees around the wheel. */
export function hueSeparation(a: number, b: number): number {
  const d = Math.abs(OKLCH_HUE[wrap(a)]! - OKLCH_HUE[wrap(b)]!);
  return d > 180 ? 360 - d : d;
}

/** The first taken hue within `HUE_MIN_SEPARATION` of `hue`, or null when the hue is clear. */
export function hueConflict(hue: number, taken: readonly number[]): number | null {
  for (const t of taken) if (hueSeparation(hue, t) < HUE_MIN_SEPARATION) return t;
  return null;
}

/**
 * The hue a new member gets: `seed` if it is clear of every taken hue, else the nearest hue that
 * is, walking outward from the seed one degree at a time on both sides. Past a full wheel — no
 * clear hue anywhere — the answer is the hue that sits farthest from its nearest neighbour, which
 * is not fully separated and is never a duplicate; the caller says so out loud (`hueConflict` on
 * the result is how it knows). Creation is never refused for want of a colour.
 */
export function assignHue(seed: number, taken: readonly number[]): number {
  const start = wrap(seed);
  for (let step = 0; step < 180; step++) {
    for (const h of step === 0 ? [start] : [wrap(start + step), wrap(start - step)]) {
      if (hueConflict(h, taken) === null) return h;
    }
  }
  let best = start;
  let bestGap = -1;
  for (let h = 0; h < 360; h++) {
    if (taken.includes(h)) continue;
    const gap = Math.min(...taken.map((t) => hueSeparation(h, t)));
    if (gap > bestGap) {
      bestGap = gap;
      best = h;
    }
  }
  return best;
}
