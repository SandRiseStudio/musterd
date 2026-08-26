/**
 * The seat statusline chip — the user-facing half of session orientation.
 *
 * ADR 326 shipped the orientation block on the `SessionStart` hook and claimed it would greet the
 * human on open. It cannot, and no amount of formatting fixes that: the Claude Code hooks contract
 * gives `SessionStart` no user-facing seam at exit 0. Its own spec is explicit —
 *
 *   > `SessionStart` doesn't use the standard decision model. Exit code 2 shows stderr to the user
 *   > only; it doesn't block anything. JSON output is discarded entirely.
 *   > | `systemMessage` | **Discarded.** Use `additionalContext` instead |
 *
 * — so stdout and `additionalContext` both land in MODEL context, and `systemMessage`, the field
 * that would surface a line to the human on every other event, is dropped on this one. The block
 * works exactly as designed; it was simply always addressed to the agent. Verified live in the
 * dolly seat: the block generated, the agent oriented and cleared five stale asks unprompted, and
 * the human saw a blank terminal and asked why nothing had happened.
 *
 * The statusline is the honest seam for the other audience. It is visible with zero typing, it
 * persists for the session instead of scrolling away, and it redraws as the inbox changes — and it
 * leaves the never-failing hook contract alone, which the exit-2 stderr alternative would have
 * inverted.
 *
 * Composition-only, and STRICTER than {@link composeSessionOrientation}: that block fences one
 * free-text field (the seat's own memory headline, ADR 093); this one carries no free text at all.
 * A surface that redraws every turn is a worse host for attacker-controlled bytes than a one-shot
 * block, and a chip has no room for prose regardless. Counts and validated slugs, or nothing.
 *
 * Emission lives in `session.ts`; this module holds only the composition, so the injection surface
 * is testable without a daemon.
 */

import { SEAT_CHIP } from '@musterd/protocol';

export type SessionStatuslineInput = {
  seat: string;
  team: string;
  waiting: number;
  incidents: number;
  carrying: number;
};

const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Counts are rendered, not trusted: a daemon returning nonsense must not stretch the chip. */
const MAX_COUNT = 999;

function count(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const c = Math.floor(n);
  return c > MAX_COUNT ? `${String(MAX_COUNT)}+` : String(c);
}

/**
 * Render the chip, or `null` when the seat identity itself fails its shape gate.
 *
 * Note the deliberate inversion of the orientation's empty rule: the block returns `null` with
 * nothing to say, because an empty block is pure token cost in a context window. The chip returns
 * a line anyway. Its first job is answering "which seat is this terminal?", and that question
 * matters most precisely when the inbox is quiet.
 */
export function composeSessionStatusline(d: SessionStatuslineInput): string | null {
  if (!SLUG.test(d.seat) || !SLUG.test(d.team)) return null;

  // SEAT_CHIP, not a literal 🔶: the session-label chip (ADR 286) already owns that glyph, and two
  // definitions of one seat marker drift the moment either moves.
  const segments: string[] = [`${SEAT_CHIP} ${d.seat}`, d.team];
  // Incidents lead: a shared red outranks a personal inbox, same precedence the orient skill uses.
  if (d.incidents > 0) segments.push(`🔴${count(d.incidents)} incidents`);
  if (d.waiting > 0) segments.push(`⚑${count(d.waiting)} waiting`);
  segments.push(d.carrying > 0 ? `lane: ${count(d.carrying)} in flight` : 'lane: none');

  return segments.join(' · ');
}
