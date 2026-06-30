import type { Database } from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { ClaimTarget } from '@musterd/protocol';

/**
 * P3.2 claim-handshake store layer (ADR 077). These functions are the seam between the WS claim
 * handler + HTTP request lane and the P3.1 DB substrate (ADR 076: migration v10, grants/requests
 * tables, teams.agent_key_hash). They will be wired to June's real tables in the atomic P3 merge;
 * until then they operate against the schema-9 DB and return sensible fallbacks so the rest of the
 * server compiles and the claim handler degrades gracefully on the live daemon.
 */

export interface GrantRow {
  id: string;
  team_id: string;
  target_seat: string | null;
  target_role: string | null;
  issued_by: string;
  lifetime: 'once' | 'ttl' | 'standing';
  expires_at: number | null;
  single_use: 0 | 1;
  used_at: number | null;
  revoked: 0 | 1;
}

export interface RequestRow {
  id: string;
  team_id: string;
  kind: 'claim' | 'teammate';
  from_conn_id: string;
  target_seat: string | null;
  target_role: string | null;
  surface: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decided_by: string | null;
  ts: number;
  expires_at: number;
}

export type GrantLifetime = 'once' | { ttl_hours: number } | 'standing';

/** Hash a raw token/key with sha256 for at-rest storage. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Resolve the team's agent_key_hash from the DB (P3.1 adds `agent_key_hash` column to `teams`).
 *  Returns null if the column doesn't exist yet (pre-v10 schema — live daemon compatibility). */
export function getTeamAgentKeyHash(db: Database, teamId: string): string | null {
  try {
    const row = db
      .prepare<[string], { agent_key_hash: string | null }>(
        'SELECT agent_key_hash FROM teams WHERE id = ?',
      )
      .get(teamId);
    return row?.agent_key_hash ?? null;
  } catch {
    return null; // column not yet added (pre-v10)
  }
}

/** Verify a raw agent key against the team's stored hash. Returns false on any failure. */
export function verifyAgentKey(db: Database, teamId: string, rawKey: string): boolean {
  const stored = getTeamAgentKeyHash(db, teamId);
  if (!stored) return false;
  return stored === hashToken(rawKey);
}

/** Validate a raw grant token for the given team + target. Returns the grant row if valid
 *  (not expired, not revoked, not single-used, scoped to the target). Null otherwise. */
export function validateGrant(
  db: Database,
  teamId: string,
  rawGrant: string,
  target: ClaimTarget,
): GrantRow | null {
  try {
    const hash = hashToken(rawGrant);
    const row = db
      .prepare<[string, string], GrantRow>(
        'SELECT * FROM grants WHERE team_id = ? AND grant_hash = ? LIMIT 1',
      )
      .get(teamId, hash);
    if (!row) return null;
    if (row.revoked) return null;
    if (row.expires_at && row.expires_at < Date.now()) return null;
    if (row.single_use && row.used_at) return null;
    // scope check
    if ('seat' in target && row.target_seat && row.target_seat !== target.seat) return null;
    if ('role' in target && row.target_role && row.target_role !== target.role) return null;
    return row;
  } catch {
    return null; // grants table not yet added (pre-v10)
  }
}

/** Mark a single-use grant as consumed. No-op on any error. */
export function consumeGrant(db: Database, grantId: string): void {
  try {
    db.prepare('UPDATE grants SET used_at = ? WHERE id = ?').run(Date.now(), grantId);
  } catch {
    /* pre-v10 */
  }
}

/** Create a pending claim request. Returns the new row. Throws if the requests table is absent. */
export function createClaimRequest(
  db: Database,
  teamId: string,
  fromConnId: string,
  target: ClaimTarget,
  surface: string,
): RequestRow {
  const id = ulid();
  const now = Date.now();
  const HOUR_MS = 3_600_000;
  const seat = 'seat' in target ? target.seat : null;
  const role = 'role' in target ? target.role : null;
  db.prepare(
    `INSERT INTO requests (id, team_id, kind, from_conn_id, target_seat, target_role, surface,
     status, decided_by, ts, expires_at)
     VALUES (?, ?, 'claim', ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
  ).run(id, teamId, fromConnId, seat, role, surface, now, now + HOUR_MS);
  return {
    id,
    team_id: teamId,
    kind: 'claim',
    from_conn_id: fromConnId,
    target_seat: seat,
    target_role: role,
    surface,
    status: 'pending',
    decided_by: null,
    ts: now,
    expires_at: now + HOUR_MS,
  };
}

/** Dedup: if an identical pending request exists for (team, connId, target) return it.
 *  Prevents duplicate admin prompts on blip reconnects (spec-gap 3, ADR 069). */
export function findExistingRequest(
  db: Database,
  teamId: string,
  fromConnId: string,
  target: ClaimTarget,
): RequestRow | null {
  try {
    const seat = 'seat' in target ? target.seat : null;
    const role = 'role' in target ? target.role : null;
    return (
      db
        .prepare<[string, string, string | null, string | null], RequestRow>(
          `SELECT * FROM requests
           WHERE team_id = ? AND from_conn_id = ? AND target_seat IS ? AND target_role IS ?
             AND status = 'pending'
           LIMIT 1`,
        )
        .get(teamId, fromConnId, seat, role) ?? null
    );
  } catch {
    return null; // pre-v10
  }
}

/** List requests for a team, optionally filtered by status. Newest-first. */
export function listRequests(
  db: Database,
  teamId: string,
  opts: { status?: string; limit?: number; before?: number },
): RequestRow[] {
  try {
    const { status, limit = 100, before } = opts;
    const parts: string[] = ['WHERE team_id = ?'];
    const params: unknown[] = [teamId];
    if (status) {
      parts.push('AND status = ?');
      params.push(status);
    }
    if (before) {
      parts.push('AND ts < ?');
      params.push(before);
    }
    return db
      .prepare<unknown[], RequestRow>(
        `SELECT * FROM requests ${parts.join(' ')} ORDER BY ts DESC LIMIT ?`,
      )
      .all([...params, limit]);
  } catch {
    return []; // pre-v10
  }
}

/** Fetch a single request by id + team (guards against cross-team access). */
export function getRequest(
  db: Database,
  teamId: string,
  requestId: string,
): RequestRow | null {
  try {
    return (
      db
        .prepare<[string, string], RequestRow>(
          'SELECT * FROM requests WHERE id = ? AND team_id = ? LIMIT 1',
        )
        .get(requestId, teamId) ?? null
    );
  } catch {
    return null;
  }
}

/** Mark a request approved/denied and record who decided. */
export function settleRequest(
  db: Database,
  requestId: string,
  status: 'approved' | 'denied' | 'expired',
  decidedBy: string | null,
): void {
  try {
    db.prepare('UPDATE requests SET status = ?, decided_by = ? WHERE id = ?').run(
      status,
      decidedBy,
      requestId,
    );
  } catch {
    /* pre-v10 */
  }
}

/** Issue a grant for the given seat/role with the chosen lifetime. Returns the new grant id. */
export function issueGrant(
  db: Database,
  teamId: string,
  target: ClaimTarget,
  lifetime: GrantLifetime,
  issuedBy: string,
): string {
  const grantId = ulid();
  const { raw, hash } = mintToken('msgr_');
  const seat = 'seat' in target ? target.seat : null;
  const role = 'role' in target ? target.role : null;
  const now = Date.now();
  let expiresAt: number | null = null;
  let singleUse = 0;
  let lifetimeStr: 'once' | 'ttl' | 'standing';

  if (lifetime === 'once') {
    lifetimeStr = 'once';
    singleUse = 1;
  } else if (lifetime === 'standing') {
    lifetimeStr = 'standing';
  } else {
    lifetimeStr = 'ttl';
    expiresAt = now + lifetime.ttl_hours * 3_600_000;
  }

  db.prepare(
    `INSERT INTO grants (id, team_id, grant_hash, target_seat, target_role, issued_by,
     lifetime, expires_at, single_use, used_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
  ).run(grantId, teamId, hash, seat, role, issuedBy, lifetimeStr, expiresAt, singleUse, now);

  // The raw token is returned to the caller only for pre-issued grants (stored in harness config).
  // For live-approval grants we don't return the raw value — the seat is occupied directly.
  void raw;
  return grantId;
}

/** Mint a new token with the given prefix. Returns both raw (for delivery) and hash (for storage).
 *  Never logs or serialises the raw value. */
function mintToken(prefix: string): { raw: string; hash: string } {
  const raw = prefix + randomBytes(24).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

/** Sweep requests that have passed their expiry window and are still pending. Returns the expired
 *  request rows (callers push `refused {expired_grant}` to their waiting WS connections). */
export function sweepExpiredRequests(db: Database): RequestRow[] {
  try {
    const now = Date.now();
    const expired = db
      .prepare<[number], RequestRow>(
        "SELECT * FROM requests WHERE status = 'pending' AND expires_at < ?",
      )
      .all(now);
    if (expired.length > 0) {
      db.prepare(
        "UPDATE requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
      ).run(now);
    }
    return expired;
  } catch {
    return []; // pre-v10
  }
}

/** Fetch all seats on a team that are currently unoccupied (for the `claimable` hint on refused). */
export function getClaimableSeats(db: Database, teamId: string): string[] {
  try {
    const rows = db
      .prepare<[string], { name: string }>(
        `SELECT m.name FROM members m
         WHERE m.team_id = ? AND m.kind != 'observer'
           AND NOT EXISTS (
             SELECT 1 FROM presences p
             WHERE p.member_id = m.id AND p.released_at IS NULL
           )`,
      )
      .all(teamId);
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}
