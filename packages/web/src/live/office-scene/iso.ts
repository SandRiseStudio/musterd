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

/** Back-wall height in screen px at scale 1. Owned here (not in render) because the fit has to know how
 * far the scene rises above the floor's back corner — see `fitFloor`. `render.ts` imports it to draw. */
export const WALL_H = 188;
/** Screen px (at scale 1) the scene rises above the floor's back corner: the back walls, plus a little
 * headroom for the string lights and anything perched on top of them. The fit reserves this above the
 * diamond so the back corner and wall tops never clip off the top of the panel. */
export const SCENE_RISE = WALL_H + 14;
/** Screen px (at scale 1) the scene drops below the floor's front corner: the slab thickness plus the
 * soft contact shadow pooled under it (see `drawGroundShadow`). Reserved below the diamond by the fit. */
export const SCENE_DROP = THICK + 28;

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
 * Fit the *whole scene* into a panel: centre it and pick the largest scale that leaves a small margin.
 * The projected box is width 2·FLOOR·KX; its height is the full vertical extent — the back walls rising
 * above the diamond (`SCENE_RISE`), the diamond itself (2·FLOOR·KY), and the slab + contact shadow below
 * it (`SCENE_DROP`). Fitting only the floor diamond (the old behaviour) let the wall tops clip off the
 * top of the panel at wide/short aspect ratios, which is why the back corner was getting cut off.
 */
export function fitFloor(panelW: number, panelH: number): Fit {
  const projW = FLOOR * KX * 2;
  const projH = SCENE_RISE + FLOOR * KY * 2 + SCENE_DROP;
  // 0.94 → 0.96 (nick, 2026-08-03): the scene is height-bound at every aspect the product uses, so this
  // number is the room's size on screen, and 6% of unused height on a 720p stream is a wasted 43 pixels.
  // It stays under 1 because the margin is what keeps the wall tops and the contact shadow off the panel
  // edge — the scene is drawn to its box, not inset within it.
  const margin = 0.96;
  const scale = Math.max(
    0.05,
    Math.min((panelW * margin) / projW, (panelH * margin) / projH),
  );
  const ox = panelW / 2;
  // Centre the full box vertically. Its top (the wall tops) sits `SCENE_RISE·scale` above the floor's
  // back corner, so place the back corner that far below the box top → symmetric margins top and bottom.
  const boxTop = (panelH - projH * scale) / 2;
  const oy = boxTop + SCENE_RISE * scale;
  return { ox, oy, scale };
}
