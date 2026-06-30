import type { Request, RequestKind, RequestStatus } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';

/**
 * The request/approval-lane store (ADR 076, P3.1 of ADR 069). A request is a session asking to claim a
 * seat/role or join as a teammate, awaiting an admin decide. The store + dedup live here (P3.1); the WS
 * push, the decide endpoint, and the reaper wiring are P3.2 (ADR 077). Requests dedup by
 * `(team, from_session, target)` while open (ADR 069 decision 3).
 */

/** Default request lifetime before the reaper expires it (ADR 069 decision 2). */
export const REQUEST_TTL_MS = 60 * 60 * 1000;

export interface RequestRow {
  id: string;
  team_id: string;
  kind: string;
  from_session: string;
  target: string | null;
  status: string;
  decided_by: string | null;
  created_at: number;
}

export function toRequest(row: RequestRow): Request {
  return {
    id: row.id,
    team: row.team_id,
    kind: row.kind as RequestKind,
    from_session: row.from_session,
    target: row.target,
    status: row.status as RequestStatus,
    decided_by: row.decided_by,
    ts: row.created_at,
  };
}

/**
 * Create a request, **deduped** by `(team, from_session, target)`: if an open (`pending`) request
 * already exists for that triple, it is returned unchanged rather than stacking a duplicate (a session
 * that re-claims after a dropped socket reuses its pending request). `target` is matched with NULL
 * equality so a bare teammate-join request dedups too.
 */
export function createRequest(
  db: Database,
  teamId: string,
  input: { kind: RequestKind; from_session: string; target: string | null },
): Request {
  const existing = db
    .prepare<[string, string, string | null, string | null], RequestRow>(
      `SELECT * FROM requests
       WHERE team_id = ? AND status = 'pending' AND from_session = ?
         AND ((target IS NULL AND ? IS NULL) OR target = ?)`,
    )
    .get(teamId, input.from_session, input.target, input.target);
  if (existing) return toRequest(existing);

  const row: RequestRow = {
    id: ulid(),
    team_id: teamId,
    kind: input.kind,
    from_session: input.from_session,
    target: input.target,
    status: 'pending',
    decided_by: null,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO requests (id, team_id, kind, from_session, target, status, decided_by, created_at)
     VALUES (@id, @team_id, @kind, @from_session, @target, @status, @decided_by, @created_at)`,
  ).run(row);
  return toRequest(row);
}

export function getRequest(db: Database, teamId: string, id: string): Request | null {
  const row = db
    .prepare<[string, string], RequestRow>('SELECT * FROM requests WHERE team_id = ? AND id = ?')
    .get(teamId, id);
  return row ? toRequest(row) : null;
}

/**
 * Decide a pending request. Only a `pending` request transitions; returns the updated request, or null
 * if it was missing or already settled (so the caller can 404/409 appropriately).
 */
export function decideRequest(
  db: Database,
  teamId: string,
  id: string,
  decision: 'approved' | 'denied',
  decidedBy: string,
): Request | null {
  const res = db
    .prepare(
      `UPDATE requests SET status = ?, decided_by = ?
       WHERE team_id = ? AND id = ? AND status = 'pending'`,
    )
    .run(decision, decidedBy, teamId, id);
  if (res.changes === 0) return null;
  return getRequest(db, teamId, id);
}

/** List a team's requests (public shape), newest-first; optionally only the open (`pending`) ones. */
export function listRequests(
  db: Database,
  teamId: string,
  opts: { pendingOnly?: boolean } = {},
): Request[] {
  const sql = opts.pendingOnly
    ? "SELECT * FROM requests WHERE team_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC"
    : 'SELECT * FROM requests WHERE team_id = ? ORDER BY created_at DESC, id DESC';
  return db.prepare<[string], RequestRow>(sql).all(teamId).map(toRequest);
}

/**
 * Expire pending requests older than `ttlMs` (the reaper, ADR 069 decision 2). Returns the count
 * expired. Wired to a timer by ADR 077; pure + idempotent so it is safe to call on any cadence.
 */
export function expireRequests(db: Database, now = Date.now(), ttlMs = REQUEST_TTL_MS): number {
  const res = db
    .prepare("UPDATE requests SET status = 'expired' WHERE status = 'pending' AND created_at < ?")
    .run(now - ttlMs);
  return res.changes;
}
