import { normalizeSeatName, type ActDelivery, type DeliveryRecipient } from '@musterd/protocol';
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

function recipientLedger(
  db: Database,
  msg: MessageRow,
  recipient: RecipientRow,
  resolve: { act: string; id: string; ts: number } | null,
): DeliveryRecipient {
  const answered = answerBy(db, msg, recipient.id) ?? resolve;
  const cursor = getCursor(db, recipient.id);
  const seen = cursor.last_read_ts >= msg.ts;
  return {
    seat: recipient.name,
    seat_id: normalizeSeatName(recipient.name),
    state: answered ? 'answered' : seen ? 'seen' : 'logged',
    seen_by: seen ? cursor.updated_at : null,
    answered,
    interrupt_raises: interruptRaises(db, msg, recipient.name),
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
