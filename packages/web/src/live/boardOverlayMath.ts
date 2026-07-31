/**
 * The pure half of the board overlay — the zoom geometry and the dismissal rule, kept out of the
 * component so they can be unit-tested without a DOM (the house testing pattern: no jsdom rig).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The "walk up to the wall" transform: the CSS that shrinks the open panel back onto the wall
 * board's on-screen rect. The panel mounts wearing this (plus opacity 0), then flips to identity a
 * frame later — so opening reads as the wall object growing into your hands, and closing as putting
 * it back. Top-left origin: both rects are viewport-space, so the delta is a plain translate.
 */
export function zoomTransform(origin: Rect, panel: Rect): string {
  const sx = panel.width > 0 ? origin.width / panel.width : 1;
  const sy = panel.height > 0 ? origin.height / panel.height : 1;
  return `translate(${(origin.x - panel.x).toFixed(1)}px, ${(origin.y - panel.y).toFixed(1)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
}

/**
 * Board chrome that owns its own Escape — the compose card and the handoff seat picker close
 * *themselves* on Escape (Board.tsx) without preventDefault, so the overlay must yield by scope:
 * an Escape born inside one of these puts THAT away, not the whole board.
 */
export const ESCAPE_SCOPES = '.lc-card--compose, .lc-card__picker';

/** Whether an Escape keydown should close the overlay. */
export function shouldDismiss(
  e: { key: string; defaultPrevented: boolean },
  insideEscapeScope: boolean,
): boolean {
  return e.key === 'Escape' && !e.defaultPrevented && !insideEscapeScope;
}
