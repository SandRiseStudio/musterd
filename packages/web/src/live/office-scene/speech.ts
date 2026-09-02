/**
 * Pure helpers for the ephemeral office speech bubbles — an act's body types out over the sender's head,
 * then fades. Kept separate from the DOM wiring in `index.ts` so the text-shaping logic is unit-testable.
 */
import type { Recipient } from '@musterd/protocol';
import { richTokens, type RichToken } from '../format';

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

/** Lane/goal acts arrive as a machine envelope — `[lane] resolved "Title"` — which reads like a log
 * line floating over someone's head. Unwrap it into a speakable clause (`resolved: Title`): drop the
 * bracket tag and turn the verb's quoted argument into a colon phrase. Anything trailing the quote
 * (e.g. `(owner miley): globs…`) is preserved. */
const ENVELOPE_TAG = /^\[(?:lane|goal)\]\s+/i;
const ENVELOPE_VERB = /^(resolved|opened|claimed|declared|handed|surface overlaps)\s+"([^"]+)"/i;
/** `[lane] "Title" → state` — the transition form the verb regex can't see. */
const ENVELOPE_STATE = /^"([^"]+)"\s+→\s+([a-z_]+)$/i;

/**
 * One vocabulary (first-five-seconds §3): the single place wire verbs and lane states become plain
 * language. Bubbles and the caption rail both read through here, so the room never contradicts its
 * own narrator. Unknown tokens pass through unchanged — honest beats pretty.
 */
export const PLAIN_VERBS: Record<string, string> = {
  resolved: 'finished',
  claimed: 'took on',
  handed: 'handing over',
  'surface overlaps': 'overlaps with',
  opened: 'opened',
  declared: 'declared',
};
export const PLAIN_STATES: Record<string, string> = {
  active: 'working on',
  claimed: 'took on',
  awaiting_acceptance: 'ready for review',
  ready_for_review: 'ready for review',
  done: 'finished',
  open: 'opened',
  blocked: 'blocked on',
  abandoned: 'set aside',
};

/** Flatten an act body into speakable prose: markdown chrome off, code fences and URLs collapsed to
 * compact tokens, the lane/goal envelope unwrapped, whitespace collapsed. A bubble is a spoken line,
 * not a document. Note: `#refs`, file paths, arrows, and short hashes are left intact — they read as
 * intentional content, not chrome, and the stream is the place to style them richly. */
export function stripNoise(raw: string): string {
  let t = raw;
  // fenced code blocks → a compact token (the stream shows the real thing)
  t = t.replace(/```[\s\S]*?```/g, ' ⟨code⟩ ').replace(/```[\s\S]*$/g, ' ⟨code⟩ ');
  // bare URLs → an arrow + hostname; markdown links keep their label
  t = t.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');
  t = t.replace(/https?:\/\/([^\s/)>\]]+)[^\s)>\]]*/g, (_, host: string) => `↗ ${host}`);
  // lane/goal envelope: `[lane] resolved "Title"` → `resolved: Title` (do this before emphasis-strip
  // so the surrounding quotes are still balanced). The tag comes off even when no known verb follows.
  t = t.replace(ENVELOPE_TAG, '');
  t = t.replace(ENVELOPE_VERB, (_, verb: string, title: string) => {
    return `${PLAIN_VERBS[verb.toLowerCase()] ?? verb.toLowerCase()}: ${title}`;
  });
  t = t.replace(ENVELOPE_STATE, (m, title: string, state: string) => {
    const plain = PLAIN_STATES[state.toLowerCase()];
    return plain ? `${plain}: ${title}` : m;
  });
  // markdown chrome: headers, single-char emphasis, blockquotes, list bullets. `**strong**` and
  // `` `code` `` markers are deliberately KEPT — the bubble's token renderer (speechTokens) turns
  // them into styled spans, matching the stream's rich-text vocabulary.
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/(^|\s)[*_]([^*_`]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2');
  t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  // a whole line still wrapped in balanced quotes (a bare quoted title with no verb) → unwrap it
  t = t.replace(/^"([^"]+)"$/, '$1');
  return t;
}

/* ─── rich speech tokens ─────────────────────────────────────────────────────────────────────────
 * The bubble speaks the same rich-text vocabulary as the stream (format.ts richTokens: **strong**,
 * `code`, #refs, collapsed ULIDs, commit SHAs), plus one bubble-only kind: the `lead` verb that
 * stripNoise unwraps from the lane/goal envelope (`resolved: Title`). The DOM layer renders each
 * kind as a styled span and reveals across tokens, so the typewriter survives. */

export type SpeechToken = RichToken | { kind: 'lead'; text: string };

const LEAD_RE =
  /^(finished|opened|took on|declared|handing over|overlaps with|working on|ready for review|blocked on|set aside):\s+/i;

/** Tokenize a shaped (post-stripNoise) bubble line for rich rendering. */
export function speechTokens(text: string): SpeechToken[] {
  const m = text.match(LEAD_RE);
  if (!m) return richTokens(text);
  return [{ kind: 'lead', text: m[1]! }, ...richTokens(text.slice(m[0].length))];
}

/** Total visible length of a speech-token stream — what the typewriter counts against. */
export function speechLength(tokens: SpeechToken[]): number {
  return tokens.reduce((n, t) => n + t.text.length, 0);
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

/* ─── who a bubble is talking to ─────────────────────────────────────────────────────────────────
 * A directed act read as an unaddressed soliloquy: "You were right, I will take the handoff…" over
 * someone's head, with no way to know who "you" is. The envelope always carried `to`; only the
 * bubble was blind to it (the choreography layer has always used it — a handoff walks to the
 * recipient's desk). */

/** What the bubble should say about its recipient, or `null` when naming one would be noise. */
export interface Addressee {
  /**
   * Every seat this act is for, in the order the sender named them — one name for a `member` act,
   * 2–4 for an ADR 254 eligible set. Plural because the scene must not pick one: any of them
   * discharges the act, so the trace goes to all of them and the chip says so.
   */
  names: string[];
  /** What the chip reads: `ryder`, or `ryder or sloane`. */
  label: string;
  /** Whether to draw the light-trace toward those members' desks. False when there is no meaningful
   * arc to draw — the scene additionally drops it for anyone who isn't on the floor. */
  tether: boolean;
}

/** `ryder` · `ryder or sloane` · `ryder, sloane or dolly` — short enough for a 720p chip. */
function joinOr(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * Decide how a bubble names its recipient.
 *
 * Team and broadcast acts name nobody: the team IS the default audience, so a chip on every bubble
 * would be chrome rather than information. A member act always names them — that is the whole point
 * — but a seat addressing itself gets the chip without the tether, because an arc from a desk back
 * to the same desk is a smudge, not a signal.
 *
 * ── The eligible set (ADR 254) ──────────────────────────────────────────────────────────────────
 *
 * An act addressed to 2–4 named seats travels as `to: {kind:'team'}` with the names in
 * `meta.eligible` — the recipient field is deliberately unchanged, because routing still fans out
 * to the team. Read `to` alone and the act looks unaddressed, which is exactly what every web
 * surface did until 2026-09-02: 35 acts in the live corpus, 28 of them the review-routing
 * `request_help`s, drew as a megaphone to nobody while the CLI printed `ryder | sloane`.
 *
 * All of them are named, and none of them is THE recipient. Picking `eligible[0]` would draw a
 * single addressee the ledger does not have — a nicer-looking version of the same lie — so the
 * chip names the set and the scene traces to each desk. Nobody walks: a courier can only walk to
 * one desk, and there is no one desk.
 */
export function speechAddressee(
  to: Recipient,
  from: string,
  eligible?: string[] | null,
): Addressee | null {
  if (to.kind === 'member') {
    return { names: [to.name], label: to.name, tether: to.name !== from };
  }
  // A one-name "set" is not a set — it is a member act that took the wrong road, and the sender
  // addressing only themselves is a soliloquy with no arc to draw.
  const named = eligible?.filter((n) => n !== from) ?? [];
  if (!eligible || eligible.length < 2 || named.length === 0) return null;
  return { names: eligible, label: joinOr(eligible), tether: true };
}

/** Per-character typewriter cadence in ms — quicker for longer text, clamped comfortable. Tuned so a
 * full glance (~180 chars) types out in ~3s. */
export function typeCadence(len: number): number {
  return Math.min(55, Math.max(16, Math.round(2600 / Math.max(len, 1))));
}
