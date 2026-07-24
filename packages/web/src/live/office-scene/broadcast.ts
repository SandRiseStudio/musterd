/**
 * Broadcast-mode gates (ADR 157).
 *
 * The office is normally a *viewer's* scene: it parks its RAF loop the moment the tab is hidden, and
 * renders at the device's DPR. Both are load-bearing perf rules (packages/web/AGENTS.md — "loops stop
 * when unseen"), and both are exactly wrong for a stream source, where nobody is looking at the tab and
 * the frame has to be a deterministic 1920×1080.
 *
 * So the three decisions broadcast mode inverts live here, as pure predicates the scene consults —
 * small enough to be obvious, separate enough to be tested without a Canvas2D context (the scene itself
 * cannot mount under vitest's node environment; the end-to-end proof is the headless-CDP check in
 * ADR 157's Observability section).
 */

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
 * The ambient idle-FPS budget (ADR 086 Phase 2): a viewer's office coalesces ambient-only motion
 * toward ~20fps (visually identical, ~3× cheaper — a measured, standing win). But a *broadcast* is
 * resampled to an exact 30fps encode, and 20fps content on a 30fps timeline is textbook cadence
 * judder: every third frame duplicates, an evenly-paced stutter on every viewer's player (observed
 * on the first live Twitch stream). Broadcast renders ambient at full rate — the capture machine is
 * the one place that cost buys smoothness for everyone watching.
 */
export function ambientFrameBudgetMs(broadcast: boolean, capMs: number): number {
  return broadcast ? 0 : capMs;
}
