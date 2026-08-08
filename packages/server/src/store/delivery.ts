import {
  isAwaitingAcceptance,
  LANE_TERMINAL_STATES,
  normalizeSeatName,
  type ActDelivery,
  type DeliveryRecipient,
  type LaneState,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { getCursor } from './cursors.js';
import type { MessageRow } from './rows.js';

/**
 * The per-recipient delivery ledger (ADR 090) — `logged → seen → answered`, **derived** from the
 * message log + inbox cursors + the interrupt audit, never stored. `logged` is implicit (the row
 * exists; durability IS delivery, so there is no local `failed`); `seen` is the recipient's cursor
 * watermark crossing the act (exact as a boolean, watermark-precise as a timestamp); `answered` is
 * the same predicate `countOpenLoops`/`recordLoopClosure` use (an accept/decline naming the act via
 * `meta.in_reply_to`, or a resolve on its thread). Pure reads, the `countOpenLoops` pattern.
 */

interface RecipientRow {
  id: string;
  name: string;
}

/** Whom a persisted act addresses. For team/broadcast this is the *current* non-observer roster
 * minus the sender — membership that changed since the send is approximated by the roster of now
 * (the log stores no fan-out list; ADR 090 accepts and labels this). */
function recipientsOf(db: Database, msg: MessageRow): RecipientRow[] {
  if (msg.to_kind === 'member') {
    if (!msg.to_member) return [];
    const row = db
      .prepare<[string], RecipientRow>('SELECT id, name FROM members WHERE id = ?')
      .get(msg.to_member);
    return row ? [row] : [];
  }
  return db
    .prepare<
      [string, string],
      RecipientRow
    >('SELECT id, name FROM members WHERE team_id = ? AND left_at IS NULL AND observer = 0 AND id != ?')
    .all(msg.team_id, msg.from_member);
}

function isUrgent(msg: MessageRow): boolean {
  if (!msg.meta) return false;
  try {
    return (JSON.parse(msg.meta) as Record<string, unknown>)['urgent'] === true;
  } catch {
    return false;
  }
}

/** The resolve that closed this act's thread (thread_key = thread_id ?? id), if any. */
function threadResolve(
  db: Database,
  msg: MessageRow,
): { act: string; id: string; ts: number } | null {
  const threadKey = msg.thread_id ?? msg.id;
  const row = db
    .prepare<
      [string, string],
      { id: string; ts: number }
    >(`SELECT id, ts FROM messages WHERE team_id = ? AND act = 'resolve' AND thread_id = ? ORDER BY ts ASC LIMIT 1`)
    .get(msg.team_id, threadKey);
  return row ? { act: 'resolve', id: row.id, ts: row.ts } : null;
}

/** This recipient's accept/decline naming the act via `meta.in_reply_to`, if any. */
function answerBy(
  db: Database,
  msg: MessageRow,
  recipientId: string,
): { act: string; id: string; ts: number } | null {
  const row = db
    .prepare<[string, string, string], { act: string; id: string; ts: number }>(
      `SELECT act, id, ts FROM messages
        WHERE team_id = ? AND from_member = ? AND act IN ('accept','decline')
          AND json_extract(meta, '$.in_reply_to') = ?
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(msg.team_id, recipientId, msg.id);
  return row ?? null;
}

/**
 * A handoff is discharged by DOING THE WORK, and that is invisible to the two reply-shaped clauses
 * above. This is the third clause: the lane a `lane_handoff` names has left the recipient's plate.
 *
 * WHY IT HAD TO EXIST, measured on the live ledger 2026-08-06. miley handed ryder lane
 * `01KZ9W0R29`; he diagnosed it, shipped ADR 246 (#716/#722) and submitted at 18:19:57. No `accept`
 * ever named the handoff and no `resolve` ever landed on its thread — because that is not how anyone
 * discharges a handoff. So the wake-candidate query never learned the work was done and kept
 * spawning sessions three hours later. Her ONE handoff was TWO envelopes and the attempt cap keys
 * per act, so it bought six wakes for already-merged work, entirely within policy.
 *
 * DERIVED, NEVER STORED — the same posture as the rest of this file, and here it buys a property a
 * stored flag could not: if acceptance REJECTS the lane it returns to an active state and the
 * handoff becomes owed again on the next read, with nothing to un-set.
 *
 * Deliberately narrow. Only a handoff that NAMES a lane, and only when that lane currently exists
 * and is out of play: submitted for acceptance (either ADR 169/192 spelling) or terminal. A bare
 * handoff, or one naming a lane that no longer exists, keeps its old behaviour rather than silently
 * going quiet — a wake that should not have fired is expensive, but a handoff that stops asking is
 * work dropped on the floor, and only one of those is recoverable.
 */
function laneHandoffDischarged(
  db: Database,
  msg: MessageRow,
): { act: string; id: string; ts: number } | null {
  if (msg.act !== 'handoff' || !msg.meta) return null;
  let laneId: unknown;
  try {
    const meta = JSON.parse(msg.meta) as { lane_handoff?: { lane?: unknown } };
    laneId = meta.lane_handoff?.lane;
  } catch {
    return null; // unparseable meta is not evidence of discharge
  }
  if (typeof laneId !== 'string' || laneId === '') return null;
  const lane = db
    .prepare<
      [string, string],
      { state: string; updated_at: number }
    >('SELECT state, updated_at FROM lanes WHERE team_id = ? AND id = ?')
    .get(msg.team_id, laneId);
  if (!lane) return null;
  const out = isAwaitingAcceptance(lane.state) || LANE_TERMINAL_STATES.has(lane.state as LaneState);
  // `id` names the LANE, not a message: this closure has no envelope of its own, and pointing at a
  // real lane is more useful to a reader of the ledger than a synthetic message id would be.
  return out ? { act: `lane:${lane.state}`, id: laneId, ts: lane.updated_at } : null;
}

/**
 * Has this recipient ANSWERED the act, by the ledger's own definition — an accept/decline naming
 * it via `meta.in_reply_to`, or a `resolve` closing its thread? Exported for the wake metrics
 * (ADR 131 O&E: "woken acts that reach `answered` in the ADR 090 ledger"), so the report reads
 * the LIVE ledger state rather than the host's report-time snapshot.
 */
export function actAnswered(
  db: Database,
  msg: MessageRow,
  recipientId: string,
): { act: string; id: string; ts: number } | null {
  return answerBy(db, msg, recipientId) ?? threadResolve(db, msg) ?? laneHandoffDischarged(db, msg);
}

/** ADR 088 interrupt raises recorded for this (act, recipient) — the attempt history. */
function interruptRaises(db: Database, msg: MessageRow, recipientName: string): number {
  const row = db
    .prepare<[string, string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action = 'interrupt.raised' AND target = ?
          AND json_extract(detail, '$.act') = ?`,
    )
    .get(msg.team_id, recipientName, msg.id);
  return row?.n ?? 0;
}

/** ADR 167 delivery-rail relays confirmed for this act — the exact `interruptRaises` pattern: an
 *  attempt is an audit row (`actor.session_message` whose `nudge_ref` names the act), the ledger
 *  projects it. The nudge row carries no recipient of its own (only the sender is authenticated),
 *  but a `nudge_ref` resolves through the act, whose recipient is fixed — so the count is per-act,
 *  landing on its one directed recipient. `verbatim` counts the fingerprint-matched subset. */
function ccdNudges(db: Database, msg: MessageRow): { total: number; verbatim: number } {
  const row = db
    .prepare<[string, string], { total: number; verbatim: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(json_extract(detail, '$.verbatim') = 1), 0) AS verbatim
         FROM audit
        WHERE team_id = ? AND action = 'actor.session_message'
          AND json_extract(detail, '$.nudge_ref') = ?`,
    )
    .get(msg.team_id, msg.id);
  return { total: row?.total ?? 0, verbatim: row?.verbatim ?? 0 };
}

function recipientLedger(
  db: Database,
  msg: MessageRow,
  recipient: RecipientRow,
  resolve: { act: string; id: string; ts: number } | null,
): DeliveryRecipient {
  const answered = answerBy(db, msg, recipient.id) ?? resolve ?? laneHandoffDischarged(db, msg);
  const cursor = getCursor(db, recipient.id);
  const seen = cursor.last_read_ts >= msg.ts;
  const nudges = ccdNudges(db, msg);
  return {
    seat: recipient.name,
    seat_id: normalizeSeatName(recipient.name),
    state: answered ? 'answered' : seen ? 'seen' : 'logged',
    seen_by: seen ? cursor.updated_at : null,
    answered,
    interrupt_raises: interruptRaises(db, msg, recipient.name),
    ccd_nudges: nudges.total,
    ccd_nudges_verbatim: nudges.verbatim,
  };
}

function actDeliveryOf(db: Database, msg: MessageRow, now: number): ActDelivery {
  const resolve = threadResolve(db, msg);
  const from = db
    .prepare<[string], { name: string }>('SELECT name FROM members WHERE id = ?')
    .get(msg.from_member);
  return {
    id: msg.id,
    act: msg.act,
    from: from?.name ?? '?',
    to_kind: msg.to_kind as ActDelivery['to_kind'],
    thread: msg.thread_id,
    ts: msg.ts,
    age_ms: Math.max(0, now - msg.ts),
    urgent: isUrgent(msg),
    recipients: recipientsOf(db, msg).map((r) => recipientLedger(db, msg, r, resolve)),
  };
}

/**
 * The acts a cursor advance from `fromTs` (exclusive) to `toTs` (inclusive) newly marks seen, for
 * the `musterd.coordination.seen_latency` emission (ADR 090). Scope matches the ledger, not the
 * whole team firehose: acts directed at me, plus team/broadcast **loop-opening** acts
 * (request_help/handoff — their `to_member` is NULL, so a `to_member = me` filter alone silently
 * skips them; bugbot on #114). Never my own sends.
 */
export function crossedBySeen(
  db: Database,
  teamId: string,
  memberId: string,
  fromTs: number,
  toTs: number,
): { act: string; urgent: boolean; ts: number }[] {
  const rows = db
    .prepare<[string, number, number, string, string], MessageRow>(
      `SELECT * FROM messages
        WHERE team_id = ? AND ts > ? AND ts <= ?
          AND (to_member = ?
               OR (to_kind IN ('team','broadcast') AND act IN ('request_help','handoff')))
          AND from_member != ?`,
    )
    .all(teamId, fromTs, toTs, memberId, memberId);
  return rows.map((m) => ({ act: m.act, urgent: isUrgent(m), ts: m.ts }));
}

/** The per-act ledger: one act's journey across every recipient. Null for an unknown id. */
export function actDelivery(
  db: Database,
  teamId: string,
  messageId: string,
  now: number = Date.now(),
): ActDelivery | null {
  const msg = db
    .prepare<[string, string], MessageRow>('SELECT * FROM messages WHERE team_id = ? AND id = ?')
    .get(teamId, messageId);
  return msg ? actDeliveryOf(db, msg, now) : null;
}

/**
 * The open directed ledger (ADR 090 §2): every loop-opening act — `request_help`/`handoff`, plus
 * urgent-flagged directed acts — not yet answered by an accept/decline naming it or a resolve on
 * its thread. This is the `open_loops` gauge made answerable (which act, whose inbox, seen or
 * ignored), and the two derivations must reconcile (the ADR's no-drift guard). Oldest first.
 */
export function openDirectedLedger(
  db: Database,
  teamId: string,
  now: number = Date.now(),
): ActDelivery[] {
  const rows = db
    .prepare<[string], MessageRow>(
      `SELECT m.* FROM messages m
        WHERE m.team_id = ?
          AND (m.act IN ('request_help','handoff')
               OR (m.to_kind = 'member' AND json_extract(m.meta, '$.urgent') = 1))
          AND m.act NOT IN ('accept','decline','resolve')
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id AND r.act IN ('accept','decline')
               AND json_extract(r.meta, '$.in_reply_to') = m.id)
          AND NOT EXISTS (
            SELECT 1 FROM messages v
             WHERE v.team_id = m.team_id AND v.act = 'resolve'
               AND v.thread_id = COALESCE(m.thread_id, m.id))
        ORDER BY m.ts ASC`,
    )
    .all(teamId);
  return rows.map((m) => actDeliveryOf(db, m, now));
}
