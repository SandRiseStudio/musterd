/**
 * Isometric projection ported from the Figma "Live Office" spec: a fixed bird's-eye 2:1 iso, drawn in
 * screen space (no camera tilt). Logical floor is FLOOR×FLOOR; `project()` maps a logical point to the
 * panel given a fitted origin+scale; painter's order is ascending `depth()` (= lx+ly) so nearer things
 * draw last and overlap correctly.
 */

export const KX = 0.70710678;
export const KY = 0.35355339;
/** Logical floor extent (both axes). Desk/furniture anchors live in [0, FLOOR]. */
export const FLOOR = 900;
/** Floor slab thickness, in screen px at scale 1. */
export const THICK = 22;

export interface Pt {
  x: number;
  y: number;
}

export interface Fit {
  ox: number;
  oy: number;
  scale: number;
}

/** Project a logical floor point (lx,ly) to screen pixels under a fit. */
export function project(lx: number, ly: number, fit: Fit): Pt {
  return {
    x: fit.ox + (lx - ly) * KX * fit.scale,
    y: fit.oy + (lx + ly) * KY * fit.scale,
  };
}

/** Painter's depth key — larger is nearer the viewer (drawn later). */
export function depth(lx: number, ly: number): number {
  return lx + ly;
}

/**
 * Fit the floor diamond into a panel: centre it and pick the largest scale that leaves a small margin.
 * The diamond's projected box is width 2·FLOOR·KX, height 2·FLOOR·KY (+ slab thickness).
 */
export function fitFloor(panelW: number, panelH: number): Fit {
  const projW = FLOOR * KX * 2;
  const projH = FLOOR * KY * 2 + THICK;
  const margin = 0.92;
  const scale = Math.max(
    0.05,
    Math.min((panelW * margin) / projW, (panelH * margin) / projH),
  );
  const ox = panelW / 2;
  const oy = panelH / 2 - FLOOR * KY * scale;
  return { ox, oy, scale };
}
