// Windowing math for the stream's bounded DOM (perf lever #3, docs/perf/web-live-baseline.md).
//
// The firehose renders newest-last and the reader lives at the bottom edge, so the DOM only ever
// needs the newest `windowSize` rows; older history stays in state (the full array keeps feeding
// quotes, the asks strip, and the office bubbles) and is revealed upward in steps as the reader
// scrolls back. Pure functions so the geometry is unit-testable without a DOM.

/** Rows in the DOM at rest — a full tall viewport (~30 rows) plus a scrollback buffer. */
export const INITIAL_WINDOW = 60;

/** Rows revealed per expansion step (one "show earlier" click / top-sentinel hit). */
export const WINDOW_STEP = 60;

/**
 * Envelopes kept in memory. The backfill is 200; live arrivals accrete forever on a wall-mounted
 * dashboard, so an unbounded array is a slow leak. 1,000 keeps a full day of busy-team traffic
 * scrollable while bounding both memory and the worst-case fully-expanded DOM.
 */
export const MAX_ENVELOPES = 1000;

/** How many envelopes sit above the rendered window (the "N earlier" count). */
export function hiddenCount(total: number, windowSize: number): number {
  return Math.max(0, total - windowSize);
}

/** One step larger, clamped to the total (expanding past everything just shows everything). */
export function expandedWindow(windowSize: number, total: number, step = WINDOW_STEP): number {
  return Math.min(total, windowSize + step);
}

/**
 * The window size needed to bring `index` (0-based, oldest-first) into the DOM, expanded in whole
 * steps past the minimum so a reveal lands mid-window rather than exactly at the cut (the revealed
 * row gets context above it). Returns the current size unchanged when the index is already visible.
 */
export function windowCovering(
  index: number,
  total: number,
  windowSize: number,
  step = WINDOW_STEP,
): number {
  const needed = total - index; // rows from the end that include `index`
  if (needed <= windowSize) return windowSize;
  const steps = Math.ceil((needed - windowSize) / step);
  return Math.min(total, windowSize + steps * step);
}

/** Keep the newest `max` envelopes (input is oldest-first). Returns the input array when under cap
 *  so React state updates stay referentially cheap. */
export function capNewest<T>(list: T[], max = MAX_ENVELOPES): T[] {
  return list.length <= max ? list : list.slice(list.length - max);
}

/**
 * The scrollTop that keeps the reader's viewport glued to the same content after rows are prepended
 * above it (expansion grows scrollHeight; the delta is exactly the added content's height). Chrome's
 * native overflow-anchor would fight this correction, so the scroller sets `overflow-anchor: none`
 * and this is the single source of anchoring truth cross-browser.
 */
export function anchoredScrollTop(
  prevScrollTop: number,
  prevScrollHeight: number,
  newScrollHeight: number,
): number {
  return prevScrollTop + (newScrollHeight - prevScrollHeight);
}
