import type { Database } from 'better-sqlite3';

export interface Cursor {
  member_id: string;
  last_read_message_id: string | null;
  last_read_ts: number;
  updated_at: number;
}

export function getCursor(db: Database, memberId: string): Cursor {
  const row = db
    .prepare<[string], Cursor>('SELECT * FROM inbox_cursors WHERE member_id = ?')
    .get(memberId);
  return (
    row ?? { member_id: memberId, last_read_message_id: null, last_read_ts: 0, updated_at: 0 }
  );
}

export function setCursor(db: Database, memberId: string, lastReadMessageId: string, lastReadTs: number): Cursor {
  const now = Date.now();
  db.prepare(
    `INSERT INTO inbox_cursors (member_id, last_read_message_id, last_read_ts, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       last_read_message_id = excluded.last_read_message_id,
       last_read_ts = excluded.last_read_ts,
       updated_at = excluded.updated_at`,
  ).run(memberId, lastReadMessageId, lastReadTs, now);
  return { member_id: memberId, last_read_message_id: lastReadMessageId, last_read_ts: lastReadTs, updated_at: now };
}
