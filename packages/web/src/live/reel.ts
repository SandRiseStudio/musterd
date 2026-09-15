/**
 * How long each ask holds the broadcast rail, ms.
 *
 * A stream viewer cannot click "see all", so the rail earns its single line by rotating instead:
 * over a minute, ten dwells show everything that is waiting. Long enough to read a name, a verb and
 * a gist out loud; short enough that thirteen asks cycle inside a viewer's attention span.
 */
export const REEL_DWELL_MS = 6_000;

/**
 * Which item the reel is showing. Pure, so the cycling is testable without a timer or a DOM — the
 * component only supplies `Date.now() - mountedAt` and re-renders.
 *
 * Clamped rather than trusted: the ask list shrinks under the reel whenever somebody answers one,
 * and an index computed against the old length must never read past the new one.
 */
export function reelIndex(count: number, elapsedMs: number, dwellMs = REEL_DWELL_MS): number {
  if (count <= 1) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  return Math.floor(elapsedMs / dwellMs) % count;
}

/**
 * Whether the reel needs a clock this frame — the guard on a 1 Hz interval that a stream leaves
 * running for hours. Pure and here, rather than inline in the effect, because it was the one part of
 * the reel with no test at all: `AsksReel` renders through `react-dom/server` (no jsdom in this
 * package by choice), effects never run there, and so nothing held the condition. Deleting the
 * `cardCount > 1` half left all 867 web tests green (dolly's #1158 review; confirmed by mutation
 * 2026-09-02).
 *
 * Two independent reasons to tick, and the second is the one that keeps getting dropped:
 *
 * - a **countdown** is on screen — any loud ask renders a clock that must move every second;
 * - the reel **rotates** — more than one card, so the shown item changes with elapsed time.
 *
 * The second is not implied by the first. Since `applyTierClock`, a stale ask is no longer loud, so
 * a stage can hold nothing but lanes in review — `loudCount === 0` with several cards — and gating
 * on loudness alone freezes the rail on whichever card it first drew, for the length of the
 * broadcast. That is the bug this predicate exists to prevent, and the case a test must name.
 *
 * Idle cost is paid by every viewer, forever (packages/web/AGENTS.md), so the false case matters as
 * much as the true one: one settled ask and nothing to turn must NOT start an interval.
 */
export function reelTicks(loudCount: number, cardCount: number): boolean {
  return loudCount > 0 || cardCount > 1;
}
