/**
 * Broadcast-mode gates (ADR 157 + capture-perf draw-rate cap).
 *
 * The office is normally a *viewer's* scene: it parks its RAF loop the moment the tab is hidden, and
 * renders at the device's DPR. Both are load-bearing perf rules (packages/web/AGENTS.md — "loops stop
 * when unseen"), and both are exactly wrong for a stream source, where nobody is looking at the tab and
 * the frame has to be a deterministic 1920×1080.
 *
 * So the decisions broadcast mode inverts live here, as pure predicates the scene consults — small
 * enough to be obvious, separate enough to be tested without a Canvas2D context (the scene itself
 * cannot mount under vitest's node environment; the end-to-end proof is the headless-CDP check in
 * ADR 157's Observability section).
 */

/** ADR 157 / CLI default encode rate — used when `?fps=` is absent on `/broadcast`. */
export const DEFAULT_CAPTURE_FPS = 30;

/**
 * Should the render loop run? Broadcast mode is *always* visible — the whole point is that a headless
 * or backgrounded page keeps animating. Every other surface keeps the tab-visibility rule.
 */
export function officeVisible(broadcast: boolean): boolean {
  if (broadcast) return true;
  return document.visibilityState === 'visible';
}

/**
 * The canvas backing-store scale. Broadcast pins DPR to 1 so the render size *is* the CSS size — a
 * capture at 1920×1080 gets exactly 1920×1080 pixels of scene, on any monitor. Viewers keep the
 * capped-retina path.
 */
export function officeDpr(broadcast: boolean, cap: number): number {
  if (broadcast) return 1;
  return Math.min(window.devicePixelRatio || 1, cap);
}

/**
 * Should a `setSuspended(true)` be ignored? Suspend exists for a collapsed panel; a stream has no
 * panels to collapse. Belt-and-brace — the broadcast route never asks — so no host surface can park
 * the loop mid-stream and freeze the frame going out to viewers.
 */
export function suspendIgnored(broadcast: boolean, on: boolean): boolean {
  return broadcast && on;
}

/**
 * Minimum wall-ms between drawn frames when the loop is coalescing.
 *
 * A viewer coalesces ambient-only motion toward ~20fps (`viewerCapMs`, typically 50) — a measured,
 * standing win. A *broadcast* used to return `0` (full rAF) because a 20fps content rate on a 30fps
 * encode is cadence judder (#368). That fixed judder by overshooting: the page painted ~60 while the
 * encoder consumed 25–30. The principled rate is **the capture fps** — content and encode match, so
 * there is no duplicate-frame judder and the compositor stops painting frames nobody encodes.
 */
export function ambientFrameBudgetMs(
  broadcast: boolean,
  viewerCapMs: number,
  captureFps: number = DEFAULT_CAPTURE_FPS,
): number {
  if (!broadcast) return viewerCapMs;
  const fps =
    Number.isFinite(captureFps) && captureFps > 0 ? captureFps : DEFAULT_CAPTURE_FPS;
  return 1000 / fps;
}

/**
 * Should this tick consult the frame budget and possibly skip the draw?
 *
 * Viewers only coalesce when the room is ambient-only (no walks, cues, or afterglow). Broadcast
 * always coalesces — including during walks, which is when the office is most expensive to paint.
 * Without this, `ambientFrameBudgetMs` alone only fires on idle stretches and the cap buys almost
 * nothing on a live team (docs/perf/broadcast-baseline.md "Known gap").
 */
export function shouldCoalesceDraw(broadcast: boolean, ambientOnly: boolean): boolean {
  return broadcast || ambientOnly;
}
