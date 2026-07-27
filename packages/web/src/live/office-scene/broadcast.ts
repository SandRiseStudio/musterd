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
 * Minimum milliseconds between painted frames right now — 0 meaning "paint every rAF".
 *
 * Two different budgets, for two different reasons:
 *
 * **A viewer** coalesces *ambient-only* motion toward ~20fps (ADR 086 Phase 2 — visually identical,
 * ~3× cheaper, a measured standing win) and paints at full rate whenever something real is moving.
 *
 * **A broadcast** paints at exactly the encode rate, always — moving or not. The earlier version
 * returned 0 here, i.e. full rAF forever, because 20fps content resampled onto a 30fps encode is
 * textbook cadence judder: every third frame duplicates, an evenly-paced stutter on every viewer's
 * player (observed on the first live Twitch stream). That reasoning was right about *20*, and it was
 * then applied to every rate. Measured 2026-07-26: the page painted 60fps, Chrome's screencast
 * delivered all 60, and the pump handed exactly 30 to ffmpeg — **half of every frame's render work
 * was discarded**, and Chrome was the most expensive process in the pipeline at ~140% of a core.
 *
 * Painting at the encode rate keeps the property that mattered: content and timeline are 1:1, so
 * there is no duplicated frame and no judder. On a 60Hz rAF a 30fps budget lands on every second
 * tick, which is phase-stable rather than a beat frequency.
 *
 * `streamFps` of 0 means the rate is unknown (an older CLI, or a hand-typed URL); the safe answer is
 * the old behaviour — paint everything — because judder is worse than cost.
 */
export function frameBudgetMs(opts: {
  broadcast: boolean;
  streamFps: number;
  ambientOnly: boolean;
  ambientCapMs: number;
}): number {
  if (opts.broadcast) return opts.streamFps > 0 ? 1000 / opts.streamFps : 0;
  return opts.ambientOnly ? opts.ambientCapMs : 0;
}
