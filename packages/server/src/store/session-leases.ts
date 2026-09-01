import { TOKEN_PREFIXES } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { newSecret, hashToken } from './members.js';

/** Five minutes limits replay exposure while avoiding renewal on every routine HTTP call (ADR 337). */
export const AGENT_SESSION_LEASE_TTL_MS = 5 * 60_000;
/**
 * How long before expiry a live WS connection is handed a renewed lease (ADR 347). Two minutes of a
 * five-minute lease: eight adapter heartbeats (15 s) fall inside the window, so one dropped
 * heartbeat never leaves an adapter without authority. Measured 2026-09-01: with no renewal at all,
 * every adapter's HTTP tools died five minutes after claim (lane 01M1FC77F2).
 */
export const AGENT_SESSION_LEASE_RENEW_AHEAD_MS = 2 * 60_000;

export interface SessionLeaseMint {
  id: string;
  session_lease: string;
  expires_at: number;
}

/** Mint an opaque, Presence-bound lease. Only its hash reaches durable storage. */
export function mintSessionLease(
  db: Database,
  input: { teamId: string; memberId: string; presenceId: string },
  now = Date.now(),
): SessionLeaseMint {
  const session_lease = newSecret(TOKEN_PREFIXES.session_lease);
  const lease: SessionLeaseMint = {
    id: ulid(),
    session_lease,
    expires_at: now + AGENT_SESSION_LEASE_TTL_MS,
  };
  db.prepare(
    `INSERT INTO session_leases (id, team_id, member_id, presence_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    lease.id,
    input.teamId,
    input.memberId,
    input.presenceId,
    hashToken(session_lease),
    lease.expires_at,
    now,
  );
  return lease;
}

/** Is this lease (by id) due for renewal — expiring within `aheadMs`, already expired, revoked, or
 *  gone? Read from the store, not from connection memory: revocation and expiry live here. */
export function sessionLeaseDueForRenewal(
  db: Database,
  leaseId: string,
  aheadMs: number,
  now = Date.now(),
): boolean {
  const row = db
    .prepare<
      [string],
      { expires_at: number; revoked_at: number | null }
    >('SELECT expires_at, revoked_at FROM session_leases WHERE id = ?')
    .get(leaseId);
  if (!row || row.revoked_at !== null) return true;
  return row.expires_at - now <= aheadMs;
}

/** A lease proves this exact agent still holds the Presence it received at claim time. */
export function hasValidSessionLease(
  db: Database,
  input: { teamId: string; memberId: string; token: string },
  now = Date.now(),
): boolean {
  const row = db
    .prepare<[string, string, string, number], { id: string }>(
      `SELECT l.id
       FROM session_leases l
       JOIN presence p ON p.id = l.presence_id
       WHERE l.team_id = ?
         AND l.member_id = ?
         AND l.token_hash = ?
         AND l.revoked_at IS NULL
         AND l.expires_at > ?
         AND p.held_until IS NULL`,
    )
    .get(input.teamId, input.memberId, hashToken(input.token), now);
  return Boolean(row);
}

/** Mark outstanding leases dead before a lifecycle transition that retains their Presence rows. */
export function revokeMemberSessionLeases(
  db: Database,
  memberId: string,
  now = Date.now(),
): string[] {
  const leases = db
    .prepare<[string], { id: string }>(
      'SELECT id FROM session_leases WHERE member_id = ? AND revoked_at IS NULL',
    )
    .all(memberId)
    .map((row) => row.id);
  if (leases.length > 0)
    db.prepare(
      'UPDATE session_leases SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL',
    ).run(now, memberId);
  return leases;
}
