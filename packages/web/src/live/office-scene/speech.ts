/**
 * Pure helpers for the ephemeral office speech bubbles — an act's body types out over the sender's head,
 * then fades. Kept separate from the DOM wiring in `index.ts` so the text-shaping logic is unit-testable.
 */

/** Glance budget: what a bubble shows unhovered. Wide enough to carry the actual point of a message
 * (~5 clamped lines at the bubble width), not just its opening clause. */
export const GLANCE_MAX = 180;
/** status_update chatter arrives constantly — it earns a tighter glance so routine pulses don't fill
 * the floor the way a real message should. */
export const GLANCE_MAX_STATUS = 120;
/** Hover shows the full shaped text, but capped — the stream stays the raw source for a 10KB dump. */
export const FULL_MAX = 700;

export interface ShapedSpeech {
  /** The unhovered bubble text (typewritten). */
  glance: string;
  /** The hover-expanded text. */
  full: string;
  /** True when `glance` hides content that hovering would reveal. */
  clamped: boolean;
}

/** Flatten an act body into speakable prose: markdown chrome off, code fences and URLs collapsed to
 * compact tokens, whitespace collapsed. A bubble is a spoken line, not a document. */
export function stripNoise(raw: string): string {
  let t = raw;
  // fenced code blocks → a compact token (the stream shows the real thing)
  t = t.replace(/```[\s\S]*?```/g, ' ⟨code⟩ ').replace(/```[\s\S]*$/g, ' ⟨code⟩ ');
  // bare URLs → an arrow + hostname; markdown links keep their label
  t = t.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');
  t = t.replace(/https?:\/\/([^\s/)>\]]+)[^\s)>\]]*/g, (_, host: string) => `↗ ${host}`);
  // markdown chrome: headers, emphasis, inline code, blockquotes, list bullets
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');
  t = t.replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** Short-truncate for a speech bubble — cut on a sentence boundary when one lands reasonably deep,
 * else a word boundary, ellipsis. (Assumes already-collapsed whitespace.) */
export function truncateSpeech(text: string, max = 72): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  // prefer ending on a complete sentence when the boundary is past half the window
  const sentence = cut.match(/^[\s\S]*[.!?](?=\s)/)?.[0];
  if (sentence && sentence.length > max * 0.5) return sentence.trim();
  const lastSpace = cut.lastIndexOf(' ');
  // keep whole words when the break is reasonably far in; otherwise hard-cut mid-word
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return base.replace(/[\s.,;:!?—-]+$/, '') + '…';
}

/** Shape an act body into its two disclosure tiers: the glance line the bubble types out, and the
 * full text hover reveals. Act-aware — routine status pulses get a tighter glance. */
export function shapeSpeech(raw: string, act?: string): ShapedSpeech {
  const cleaned = stripNoise(raw);
  const glanceMax = act === 'status_update' ? GLANCE_MAX_STATUS : GLANCE_MAX;
  const glance = truncateSpeech(cleaned, glanceMax);
  const full = cleaned.length <= FULL_MAX ? cleaned : truncateSpeech(cleaned, FULL_MAX);
  return { glance, full, clamped: glance !== full };
}

/** Per-character typewriter cadence in ms — quicker for longer text, clamped comfortable. Tuned so a
 * full glance (~180 chars) types out in ~3s. */
export function typeCadence(len: number): number {
  return Math.min(55, Math.max(16, Math.round(2600 / Math.max(len, 1))));
}
