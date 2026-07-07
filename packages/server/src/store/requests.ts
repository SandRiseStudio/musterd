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
  surface: string;
  status: string;
  decided_by: string | null;
  created_at: number;
  expires_at: number;
  /** The claimant's harness-attested model (ADR 101), carried across the approval gap. */
  model: string | null;
}

export function toRequest(row: RequestRow): Request {
  return {
    id: row.id,
    team: row.team_id,
    kind: row.kind as RequestKind,
    from_session: row.from_session,
    target: row.target,
    surface: row.surface,
    status: row.status as RequestStatus,
    decided_by: row.decided_by,
    ts: row.created_at,
    expires_at: row.expires_at,
    model: row.model ?? null,
  };
}

/**
 * Create a request, **deduped** while `pending`. Two dedup modes:
 *
 * - `collapseByTarget` (a **specific-seat** claim): collapse by `(team, target)` across *all* sessions.
 *   A named seat has exactly one holder, so at most one approval request should ever be open for it —
 *   otherwise a grant-less agent that reconnects (e.g. an MCP adapter autojoining on every launch/probe)
 *   stacks a fresh request every reconnect, since `from_session` (the connId) changes each time (the
 *   2026-07-01 dogfood pile-up: 9 duplicate `seat:Sonnet` requests). On a hit the waiter pointer
 *   (`from_session`/`surface`) is refreshed to the *latest* claimer so the admin's approve delivers to
 *   the session actually waiting (newest-wins, matching agent single-active).
 * - default (role claims, teammate joins): dedup by `(team, from_session, target)` — genuinely-distinct
 *   sessions stay distinct (e.g. two agents both waiting to join a role pool). `target` matches with
 *   NULL equality so a bare teammate-join request dedups too.
 */
export function createRequest(
  db: Database,
  teamId: string,
  input: {
    kind: RequestKind;
    from_session: string;
    target: string | null;
    surface?: string;
    collapseByTarget?: boolean;
    /** The claimant's attested model (ADR 101), stored so the approved occupancy is attested. */
    model?: string | null;
  },
): Request {
  if (input.collapseByTarget && input.target !== null) {
    const existing = db
      .prepare<
        [string, string],
        RequestRow
      >("SELECT * FROM requests WHERE team_id = ? AND status = 'pending' AND target = ?")
      .get(teamId, input.target);
    if (existing) {
      const surface = input.surface ?? existing.surface;
      // Refresh to the latest claimer's attestation too — the newest session's model is what occupies.
      const model = input.model ?? existing.model ?? null;
      db.prepare('UPDATE requests SET from_session = ?, surface = ?, model = ? WHERE id = ?').run(
        input.from_session,
        surface,
        model,
        existing.id,
      );
      return toRequest({ ...existing, from_session: input.from_session, surface, model });
    }
  } else {
    const existing = db
      .prepare<[string, string, string | null, string | null], RequestRow>(
        `SELECT * FROM requests
       WHERE team_id = ? AND status = 'pending' AND from_session = ?
         AND ((target IS NULL AND ? IS NULL) OR target = ?)`,
      )
      .get(teamId, input.from_session, input.target, input.target);
    if (existing) return toRequest(existing);
  }

  const now = Date.now();
  const row: RequestRow = {
    id: ulid(),
    team_id: teamId,
    kind: input.kind,
    from_session: input.from_session,
    target: input.target,
    surface: input.surface ?? 'cli',
    status: 'pending',
    decided_by: null,
    created_at: now,
    expires_at: now + REQUEST_TTL_MS,
    model: input.model ?? null,
  };
  db.prepare(
    `INSERT INTO requests (id, team_id, kind, from_session, target, surface, status, decided_by, created_at, expires_at, model)
     VALUES (@id, @team_id, @kind, @from_session, @target, @surface, @status, @decided_by, @created_at, @expires_at, @model)`,
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
 * Expire pending requests past their stored `expires_at` (the reaper, ADR 069 decision 2). Returns the
 * count expired. Wired to a timer by ADR 077; pure + idempotent so it is safe to call on any cadence.
 */
export function expireRequests(db: Database, now = Date.now()): number {
  const res = db
    .prepare("UPDATE requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?")
    .run(now);
  return res.changes;
}
