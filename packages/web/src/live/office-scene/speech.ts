/**
 * Pure helpers for the ephemeral office speech bubbles — an act's body types out over the sender's head,
 * then fades. Kept separate from the DOM wiring in `index.ts` so the text-shaping logic is unit-testable.
 */

/** Short-truncate an act body for a speech bubble — collapse whitespace, cut on a word boundary, ellipsis. */
export function truncateSpeech(text: string, max = 72): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // keep whole words when the break is reasonably far in; otherwise hard-cut mid-word
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return base.replace(/[\s.,;:!?—-]+$/, '') + '…';
}

/** Per-character typewriter cadence in ms — quicker for longer text, clamped comfortable. Mirrors the
 * Stream panel's `Typewriter` so the office and the console read at the same pace. */
export function typeCadence(len: number): number {
  return Math.min(55, Math.max(18, Math.round(1600 / Math.max(len, 1))));
}
