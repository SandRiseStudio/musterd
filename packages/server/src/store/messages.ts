import { PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
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

/** The `ts` of one message by id (loop-latency lookups, ADR 082 slice 3). Null when unknown. */
export function getMessageTs(db: Database, teamId: string, id: string): number | null {
  const row = db
    .prepare<
      [string, string],
      { ts: number }
    >('SELECT ts FROM messages WHERE team_id = ? AND id = ?')
    .get(teamId, id);
  return row?.ts ?? null;
}

/**
 * Directed acts (request_help/handoff) not yet answered by an accept/decline whose
 * `meta.in_reply_to` names them — the open-loops gauge (ADR 082 slice 3). Daemon-wide on purpose:
 * a health signal sampled only when telemetry is on.
 */
export function countOpenLoops(db: Database): number {
  const row = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM messages m
        WHERE m.act IN ('request_help','handoff')
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id
               AND r.act IN ('accept','decline')
               AND json_extract(r.meta, '$.in_reply_to') = m.id)`,
    )
    .get();
  return row?.n ?? 0;
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
export function listInbox(
  db: Database,
  member: { id: string; team_id: string },
  opts: InboxOpts = {},
): MessageRow[] {
  const params: unknown[] = [member.team_id, member.id, member.id];
  let sql = `SELECT * FROM messages
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

/**
 * The interrupt-class acts still waiting for `me` in `messages` (ADR 088 §3) — the predicate the
 * `inbox --interrupt-check` probe runs at every tool boundary. Interrupt-class = **directed at me
 * or a `request_help` anyone can answer**, **flagged urgent** (`meta.urgent === true`, which the send
 * path only ever leaves set when the sender's `can_flag_urgent` passed the ADR 071 gate — so the
 * capability check is already enforced upstream), and **not closed** by a `resolve` on its thread
 * (ADR 025). A terminal `resolve` never interrupts. Newest first, so the caller names the most recent
 * steer. Pure — reads envelopes, never the DB — so it is trivially testable and the "daemon-composed,
 * never the raw body" line (§4) is built from its structured fields, not from `env.body`.
 */
export function pendingInterrupts(messages: Envelope[], me: string): Envelope[] {
  const resolved = new Set<string>();
  for (const m of messages) if (m.act === 'resolve' && m.thread) resolved.add(m.thread);
  const isUrgent = (m: Envelope) =>
    (m.meta as { urgent?: unknown } | null | undefined)?.['urgent'] === true;
  const actionNeeded = (m: Envelope) =>
    m.act !== 'resolve' &&
    (m.act === 'request_help' || (m.to.kind === 'member' && m.to.name === me));
  return messages
    .filter(
      (m) => m.from !== me && actionNeeded(m) && isUrgent(m) && !resolved.has(m.thread ?? m.id),
    )
    .sort((a, b) => b.ts - a.ts);
}

/**
 * The member's most recent `status_update` reduced to a roster label + when it was set.
 * The label is `meta.state` (the SPEC field) or, if absent, the message body. Returns null
 * if the member has never posted a status_update with any label text.
 */
export function latestStatusUpdate(
  db: Database,
  memberId: string,
): { state: string; ts: number } | null {
  const row = db
    .prepare<
      [string],
      { body: string; meta: string | null; ts: number }
    >("SELECT body, meta, ts FROM messages WHERE from_member = ? AND act = 'status_update' ORDER BY ts DESC, id DESC LIMIT 1")
    .get(memberId);
  if (!row) return null;
  const metaState = row.meta
    ? (JSON.parse(row.meta) as Record<string, unknown>)['state']
    : undefined;
  const state = (typeof metaState === 'string' && metaState.trim() ? metaState : row.body).trim();
  return state ? { state, ts: row.ts } : null;
}

export interface TeamMessagesOpts {
  since?: number;
  limit?: number;
}

/**
 * The whole team timeline — every persisted envelope, regardless of recipient — for the firehose's
 * history backfill (`GET /teams/:slug/messages`, ADR 061). `since` (exclusive, by ts) pages forward;
 * `limit` caps the page (default 200).
 */
export function listTeamMessages(
  db: Database,
  teamId: string,
  opts: TeamMessagesOpts = {},
): MessageRow[] {
  const params: unknown[] = [teamId];
  let sql = 'SELECT * FROM messages WHERE team_id = ?';
  if (typeof opts.since === 'number') {
    sql += ' AND ts > ?';
    params.push(opts.since);
  }
  sql += ' ORDER BY ts ASC, id ASC LIMIT ?';
  params.push(opts.limit ?? 200);
  return db.prepare<unknown[], MessageRow>(sql).all(...params);
}

/** Convert a stored row back to a protocol Envelope (for delivery/inbox responses). */
export function rowToEnvelope(
  row: MessageRow,
  teamSlug: string,
  fromName: string,
  toName: string | null,
): Envelope {
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
