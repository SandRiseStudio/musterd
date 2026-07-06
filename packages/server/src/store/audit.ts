import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { log } from '../log.js';

/**
 * The v0.3 governance audit log (ADR 071, P2 of ADR 069). Append-only: every governed decision writes one
 * row — the coordination-governance trace no single-agent observability tool can produce, and a direct
 * feed for the batond flywheel (ADR 051). There is intentionally no update/delete API.
 */

/** A dotted governance verb. P2 emits the first five; P3 adds grant/claim/account-status/key/policy/request. */
export type AuditAction =
  | 'urgent.flagged'
  | 'urgent.denied'
  | 'send.denied'
  | 'member.reclaim'
  | 'member.remove'
  | 'observe.denied'
  // P3.1 (ADR 076): admin governance ops.
  | 'grant.issue'
  | 'grant.revoke'
  | 'key.rotate'
  | 'policy.change'
  | 'account_status.change'
  // P3.2 (ADR 077): claim handshake + request lane.
  | 'claim.occupied'
  | 'claim.refused'
  | 'claim.pending'
  | 'request.decide'
  | 'request.expired'
  // ADR 088: an interrupt-class act was surfaced to a busy agent at a tool boundary (delivery, not
  // send — `urgent.flagged` audits the send). One row per (recipient, act): who grabbed the mic, when,
  // at whom. The raised→read pair (this row, then the recipient's inbox read of `detail.act`) is the
  // delivery-confirmation signal.
  | 'interrupt.raised';

export interface AuditEntry {
  /** Seat name that initiated the op; null for system/reaper writes. */
  actor: string | null;
  action: AuditAction;
  /** Affected seat/resource name; null when not seat-scoped. */
  target: string | null;
  /** The authorization outcome. An executed governance op is `allow`. */
  result: 'allow' | 'deny';
  /** JSON-serializable context (`{ reason }`, `{ fallback: 'no-admin' }`, …); never secrets. */
  detail?: Record<string, unknown>;
}

export interface AuditRow {
  id: string;
  team_id: string;
  ts: number;
  actor: string | null;
  action: string;
  target: string | null;
  result: 'allow' | 'deny';
  detail: string | null;
  created_at: number;
}

/**
 * Append an audit entry. **Best-effort observability, never a gate**: a failure here is logged and
 * swallowed so it can never break the request path it is recording.
 */
export function appendAudit(db: Database, teamId: string, entry: AuditEntry): void {
  try {
    const now = Date.now();
    const row: AuditRow = {
      id: ulid(),
      team_id: teamId,
      ts: now,
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      result: entry.result,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
      created_at: now,
    };
    db.prepare(
      `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (@id, @team_id, @ts, @actor, @action, @target, @result, @detail, @created_at)`,
    ).run(row);
  } catch (err) {
    log.warn({ msg: 'audit_append_failed', action: entry.action, err: String(err) });
  }
}

/**
 * Has an `interrupt.raised` row already been written for this (recipient, act)? The interrupt line is
 * re-probed at *every* tool boundary, so an urgent act sits raised across many checks until read —
 * this dedup keeps the governance log to one legible row per delivered act (ADR 088) instead of one
 * per tool call. DB-backed (not in-memory) so it survives a daemon restart. Best-effort: a read error
 * degrades to "not yet raised" (at worst one extra row), never a gate on the probe.
 */
export function hasInterruptRaised(
  db: Database,
  teamId: string,
  target: string,
  actId: string,
): boolean {
  try {
    const row = db
      .prepare<[string, string, string], { one: number }>(
        `SELECT 1 AS one FROM audit
          WHERE team_id = ? AND action = 'interrupt.raised' AND target = ?
            AND json_extract(detail, '$.act') = ? LIMIT 1`,
      )
      .get(teamId, target, actId);
    return row != null;
  } catch {
    return false;
  }
}

/** Read the audit log for a team, newest-first, capped. `before` pages older than a given ts. */
export function listAudit(
  db: Database,
  teamId: string,
  opts: { limit?: number; before?: number } = {},
): AuditRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (opts.before != null) {
    return db
      .prepare<
        [string, number, number],
        AuditRow
      >('SELECT * FROM audit WHERE team_id = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(teamId, opts.before, limit);
  }
  return db
    .prepare<
      [string, number],
      AuditRow
    >('SELECT * FROM audit WHERE team_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
    .all(teamId, limit);
}
