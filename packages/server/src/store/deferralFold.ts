import type { Envelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { rowsToEnvelopes } from './hydrate.js';
import { type Deferral, deferrals, listTeamMessages, raisedDeferrals } from './messages.js';
import type { MemberRow } from './rows.js';

/** Matches the inbox/wake reads' bound (ADR 211 §3). A deferral older than this stops being tracked,
 *  which degrades to today's behaviour (the act is simply unread) rather than to a wrong answer. */
export const DEFERRAL_SCAN_LIMIT = 2000;

/**
 * The deferral fold (ADR 211): what this seat has postponed, and which of those have been raised.
 *
 * The window is the PARTY-SCOPED TEAM TIMELINE, not the inbox — `listInbox` excludes the member's own
 * sends and a deferring `wait` IS the member's own send, so folding over the inbox would find no
 * deferrals at all.
 *
 * WHY THE TWO-STEP. `deferrals` reads exactly one shape: the seat's own `wait` acts. `raisedDeferrals`
 * is the one that needs the whole window (every act on the deferred subjects, and their threads) — and
 * it is dead weight unless something is actually held. Hydrating 2000 rows into Envelopes to discover
 * that nothing was deferred cost 26ms on every inbox read, on the request path of a single-threaded
 * daemon whose `/health` probe the guardian reads as liveness. So the narrow question is asked first,
 * against the same window, and the full hydration happens only on the rare path that needs it.
 *
 * Both steps read the same rows in the same order under the same limit, so the answer is identical to
 * hydrating unconditionally — only the cost of reaching it changes.
 *
 * `own` — the seat's own sends within the window — is returned rather than recomputed because the
 * inbox read folds a second answer off exactly that subset (which asks it has already replied to, by
 * `meta.in_reply_to`). One narrow hydration, two folds; the caller never has to reach for the window.
 */
export function deferralFold(
  db: Database,
  teamSlug: string,
  member: MemberRow,
  limit: number = DEFERRAL_SCAN_LIMIT,
): { held: Map<string, Deferral>; raised: Set<string>; own: Envelope[] } {
  const window = listTeamMessages(db, member.team_id, { forMemberId: member.id, limit });
  const own = rowsToEnvelopes(
    db,
    teamSlug,
    window.filter((r) => r.from_member === member.id),
  );
  const held = deferrals(own, member.name);
  if (held.size === 0) return { held, raised: new Set<string>(), own };
  return {
    held,
    raised: raisedDeferrals(rowsToEnvelopes(db, teamSlug, window), member.name),
    own,
  };
}
