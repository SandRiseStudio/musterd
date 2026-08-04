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
