import type { Database } from 'better-sqlite3';
import { appendReplicatedEvent } from './audit.js';

/**
 * A seat's read cursor: a `(last_read_ts, last_read_message_id)` point in the inbox's order.
 *
 * `last_read_ts` is the cursor row's **`created_at`** — this daemon's receipt clock — not the
 * envelope's `ts`. The column keeps its name (renaming it is a migration for no behavioural gain),
 * but every reader that compares against it compares `messages.created_at`. `ts` is the ORIGIN's
 * clock: the sender's process stamps it and ADR 335 has it travel unchanged through federation, so
 * an event can arrive after a seat last read while carrying a `ts` from before. Keyed on `ts`, that
 * event was never shown — the cursor only moves forward (the ts-cursor defect, lane
 * 01M1FAYTHQA881M35PDPXRTGM1). Keyed on receipt, it is simply the next unread.
 */
export interface Cursor {
  member_id: string;
  last_read_message_id: string | null;
  /** The cursor row's `created_at`. 0 when the seat has never read. */
  last_read_ts: number;
  updated_at: number;
}

export function getCursor(db: Database, memberId: string): Cursor {
  const row = db
    .prepare<[string], Cursor>('SELECT * FROM inbox_cursors WHERE member_id = ?')
    .get(memberId);
  return row ?? { member_id: memberId, last_read_message_id: null, last_read_ts: 0, updated_at: 0 };
}

/**
 * Point the cursor at a message. The position is read off the row itself — a cursor is a place in
 * the log, and the one thing a caller may say about it is which row — so no caller can hand this a
 * clock of its own choosing. Throws on an unknown id; the HTTP route turns that into a 404.
 */
export function setCursor(db: Database, memberId: string, lastReadMessageId: string): Cursor {
  const row = db
    .prepare<[string], { created_at: number }>('SELECT created_at FROM messages WHERE id = ?')
    .get(lastReadMessageId);
  if (!row) throw new Error(`setCursor: unknown message id ${lastReadMessageId}`);
  const now = Date.now();
  db.prepare(
    `INSERT INTO inbox_cursors (member_id, last_read_message_id, last_read_ts, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       last_read_message_id = excluded.last_read_message_id,
       last_read_ts = excluded.last_read_ts,
       updated_at = excluded.updated_at`,
  ).run(memberId, lastReadMessageId, row.created_at, now);
  return {
    member_id: memberId,
    last_read_message_id: lastReadMessageId,
    last_read_ts: row.created_at,
    updated_at: now,
  };
}

/**
 * Advance the cursor AND stamp it for replication (ADR 366, residence-2 census gap 2), so a human
 * on a second machine (ADR 358) does not re-read an inbox they have already read.
 *
 * The event carries the MESSAGE ID, never `last_read_ts`. This is the ts-cursor defect in its
 * federated form: `last_read_ts` is THIS daemon's `created_at` for that row, and the same message
 * has a different `created_at` on every machine that folded it. Max-merging the raw number across
 * machines would move a cursor to a clock no local row ever carried and silently swallow unread
 * acts. The receiver resolves the id against its OWN `messages.created_at` and takes the max there
 * — a place in the log, re-read locally, which is what a cursor has always been.
 */
export function applyCursorAdvance(
  db: Database,
  teamId: string,
  seat: { id: string; name: string },
  lastReadMessageId: string,
): Cursor {
  return db.transaction(() => {
    const cursor = setCursor(db, seat.id, lastReadMessageId);
    appendReplicatedEvent(db, teamId, {
      actor: seat.name,
      action: 'continuity.cursor_advanced',
      target: seat.name,
      result: 'allow',
      detail: { last_read_message_id: lastReadMessageId },
    });
    return cursor;
  })();
}
