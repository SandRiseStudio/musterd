import {
  DELIVERY_HINT_ACTS,
  textFingerprint,
  type DeliveryHint,
  type DeliveryHintAct,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { getMemberById } from '../store/members.js';
import { hasLivePresence } from '../store/presence.js';
import type { MessageRow } from '../store/rows.js';

/** At most one nudge per recipient per window — derived from the messages table (below), never from
 *  stored hint state, because issued hints are deliberately not stored (ADR 167 §confirmation). */
export const NUDGE_SUPPRESS_WINDOW_MS = 10 * 60_000;

/**
 * The one-line nudge a sender relays into the recipient's live session (ADR 167 increment 2).
 * **Daemon-composed from structured fields only** (ADR 128, the `composeInterruptLine` discipline):
 * sender name, act, message id, and — for a to-human ask — the tier. NEVER the act body: the rail
 * carries a doorbell, not a payload, so a teammate's message text cannot ride it into another
 * agent's context.
 *
 * Determinism is load-bearing: this line is a pure function of the message row, which is what lets
 * the confirmation loop recompose it later and compare fingerprints instead of storing issued
 * nudges. Change the wording only knowing that an in-flight relay across the change reads as
 * `verbatim: false` (ADR 167 §rolling-upgrade caveat).
 */
export function composeNudgeLine(
  sender: string,
  act: string,
  msgId: string,
  recipientKind: string,
  tier?: string,
): string {
  if (recipientKind === 'human') {
    const what = act === 'ask' && tier ? `a ${tier} ask` : `a ${act}`;
    return (
      `musterd: ${sender} is waiting on ${what} (${msgId}) — ` +
      `surface this to the user, or run 'musterd inbox'.`
    );
  }
  return `musterd: ${sender} sent you a ${act} (${msgId}) — run team_inbox_check.`;
}

/** Is this act in the hint set? (Directedness and recipient liveness are checked separately.) */
function isHintAct(act: string): act is DeliveryHintAct {
  return (DELIVERY_HINT_ACTS as readonly string[]).includes(act);
}

/**
 * Was another hint-eligible directed act delivered to this recipient inside the suppression window?
 * The damping is derived, not stored: any such message would itself have carried a hint (same
 * predicate), so its existence stands in for "a nudge was already invited recently" — one indexed
 * query, no state, and the worst case of the approximation (the earlier sender never relayed) is one
 * suppressed doorbell, which the ADR 088/131 ladder already covers.
 */
function recentlyHinted(db: Database, msg: MessageRow, now: number): boolean {
  const row = db
    .prepare(
      `SELECT id FROM messages
        WHERE team_id = ? AND to_kind = 'member' AND to_member = ? AND id != ?
          AND act IN (${DELIVERY_HINT_ACTS.map(() => '?').join(',')})
          AND ts > ?
        LIMIT 1`,
    )
    .get(msg.team_id, msg.to_member, msg.id, ...DELIVERY_HINT_ACTS, now - NUDGE_SUPPRESS_WINDOW_MS);
  return row !== undefined;
}

/**
 * The hint predicate + assembly (ADR 167 §D6). Null — the overwhelmingly common answer — means the
 * ack is exactly what it was before this ADR. A hint is issued only when every leg holds:
 * a directed member-addressed act in the hint set, a recipient who is someone else, with fresh
 * presence (the same liveness test the reachability projections use), and no hint-eligible act
 * already delivered to them inside the window.
 */
export function deliveryHintFor(
  db: Database,
  msg: MessageRow,
  senderName: string,
  presenceTimeoutMs: number,
  now: number = Date.now(),
): DeliveryHint | null {
  if (msg.to_kind !== 'member' || msg.to_member === null) return null;
  if (!isHintAct(msg.act)) return null;
  if (msg.to_member === msg.from_member) return null;
  const recipient = getMemberById(db, msg.to_member);
  if (!recipient) return null;
  if (!hasLivePresence(db, recipient.id, presenceTimeoutMs)) return null;
  if (recentlyHinted(db, msg, now)) return null;
  const tier = tierFromMeta(msg.meta);
  const nudge_text = composeNudgeLine(senderName, msg.act, msg.id, recipient.kind, tier);
  return {
    recipient_live: true,
    rail: 'ccd_session',
    nudge_text,
    nudge_fingerprint: textFingerprint(nudge_text),
  };
}

/** The ask tier as stored on the row's meta JSON, if any — read leniently: composition must be a
 *  total function of the row (the confirmation loop replays it), so a malformed meta degrades to the
 *  tier-less phrasing rather than throwing. */
export function tierFromMeta(meta: string | null): string | undefined {
  if (!meta) return undefined;
  try {
    const parsed: unknown = JSON.parse(meta);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const tier = (parsed as Record<string, unknown>)['tier'];
    return typeof tier === 'string' && tier.length > 0 ? tier : undefined;
  } catch {
    return undefined;
  }
}
