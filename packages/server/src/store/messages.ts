import type { Database } from 'better-sqlite3';
import { PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import type { MessageRow } from './rows.js';

/** Insert an envelope into the append-only log. `toMemberId` set iff to.kind==='member'. */
export function insertMessage(
  db: Database,
  teamId: string,
  fromMemberId: string,
  toMemberId: string | null,
  env: Envelope,
): MessageRow {
  const row: MessageRow = {
    id: env.id,
    team_id: teamId,
    from_member: fromMemberId,
    to_kind: env.to.kind,
    to_member: toMemberId,
    act: env.act,
    body: env.body,
    thread_id: env.thread ?? null,
    meta: env.meta ? JSON.stringify(env.meta) : null,
    ts: env.ts,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO messages
       (id, team_id, from_member, to_kind, to_member, act, body, thread_id, meta, ts, created_at)
     VALUES
       (@id, @team_id, @from_member, @to_kind, @to_member, @act, @body, @thread_id, @meta, @ts, @created_at)`,
  ).run(row);
  return row;
}

export interface InboxOpts {
  since?: number;
  unreadOnly?: boolean;
  cursorTs?: number;
  limit?: number;
}

/**
 * A member's inbox: messages in their team addressed to them or to team/broadcast,
 * excluding their own sends. unreadOnly filters by the caller-supplied cursor ts.
 */
export function listInbox(db: Database, member: { id: string; team_id: string }, opts: InboxOpts = {}): MessageRow[] {
  const params: unknown[] = [member.team_id, member.id, member.id];
  let sql =
    `SELECT * FROM messages
     WHERE team_id = ?
       AND (to_member = ? OR to_kind IN ('team','broadcast'))
       AND from_member != ?`;
  if (opts.unreadOnly) {
    sql += ' AND ts > ?';
    params.push(opts.cursorTs ?? 0);
  } else if (typeof opts.since === 'number') {
    sql += ' AND ts > ?';
    params.push(opts.since);
  }
  sql += ' ORDER BY ts ASC, id ASC';
  if (opts.limit) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }
  return db.prepare<unknown[], MessageRow>(sql).all(...params);
}

export function listTeamMessages(db: Database, teamId: string, limit = 200): MessageRow[] {
  return db
    .prepare<[string, number], MessageRow>('SELECT * FROM messages WHERE team_id = ? ORDER BY ts ASC, id ASC LIMIT ?')
    .all(teamId, limit);
}

/** Convert a stored row back to a protocol Envelope (for delivery/inbox responses). */
export function rowToEnvelope(row: MessageRow, teamSlug: string, fromName: string, toName: string | null): Envelope {
  const to =
    row.to_kind === 'member'
      ? { kind: 'member' as const, name: toName ?? '' }
      : row.to_kind === 'team'
        ? { kind: 'team' as const }
        : { kind: 'broadcast' as const };
  return {
    id: row.id,
    v: PROTOCOL_VERSION,
    team: teamSlug,
    from: fromName,
    to,
    act: row.act as Envelope['act'],
    body: row.body,
    thread: row.thread_id,
    meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null,
    ts: row.ts,
  };
}
