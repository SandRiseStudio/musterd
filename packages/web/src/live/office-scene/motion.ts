/**
 * The motion scale (spec 2026-08-25-motion-scale-design.md).
 *
 * ONE source of truth for durations and easing roles. `Live.css` mirrors these values as custom
 * properties and `pnpm tokens:check` fails if the two ever disagree — a mirror rather than a build
 * step or a runtime read, because both of those cost initial-JS bytes that Delight 0 (ADR 313)
 * bought, and this repo already holds every other invariant with a gate (`vocab:check`,
 * `tokens:check`, the guidance snapshot, `roadmap-truth:check`).
 *
 * WHY THE NUMBERS ARE THESE NUMBERS: /broadcast captures at 720p25, so one frame is 40ms. A duration
 * that is not a whole multiple lands mid-frame and its last rendered step is a partial one — the
 * judder the Delight C lane brief warns about. Every rung below is a whole frame count. This is what
 * makes the scale arithmetic rather than taste.
 */

/** One frame at the /broadcast capture rate (720p25). */
export const FRAME_MS = 40;

/** The five rungs. Frame counts at 25fps: 3, 5, 7, 10, 15. */
export const DUR = {
  /** hover, press, focus feedback */
  d1: 120,
  /** the default transition */
  d2: 200,
  /** enter/exit of small elements */
  d3: 280,
  /** panels, layout shifts */
  d4: 400,
  /** sweeps, traces, one-shot flourishes */
  d5: 600,
} as const;

export type DurKey = keyof typeof DUR;

/**
 * The three easing roles, as CSS bezier control points.
 *
 * `pop` is the overshoot role and the riskiest at 25fps: an overshoot peak can fall between two
 * captured frames and simply not exist on the stream. Its control point is chosen against the
 * capture falsifier (spec §7), not by eye on a 120Hz laptop, which shows every overshoot.
 */
export const EASE_CSS = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.4, 0, 0.2, 1],
  pop: [0.34, 1.56, 0.64, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export type EaseKey = keyof typeof EASE_CSS;

/**
 * The canvas counterparts. These are QUADRATICS, not samples of the beziers above, and that is
 * deliberate: sampling a bezier per frame would ship a solver into the initial bundle for a
 * difference no viewer can name. The two engines share the DURATIONS — which is what actually reads
 * as consistency — and approximate the same three roles.
 */
export const CANVAS_EASE = {
  in: (t: number): number => t * t,
  out: (t: number): number => 1 - (1 - t) * (1 - t),
  inOut: (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  linear: (t: number): number => t,
} as const;

/** `DUR.d2` → `'200ms'`, for a CSS-shaped consumer. */
export function cssDuration(key: DurKey): string {
  return `${String(DUR[key])}ms`;
}

/** `EASE_CSS.out` → `'cubic-bezier(0.16, 1, 0.3, 1)'` — the exact text `Live.css` must mirror. */
export function cssEase(key: EaseKey): string {
  return `cubic-bezier(${EASE_CSS[key].join(', ')})`;
}
