import type { Database } from 'better-sqlite3';
import type { PresenceStatus, Surface } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { MemberRow, PresenceRow } from './rows.js';

export interface PresenceSummary {
  member: MemberRow;
  status: PresenceStatus;
  presences: { surface: Surface; status: PresenceStatus; last_seen_at: number }[];
}

/** Create a presence row (a new attachment) for a member on a surface. */
export function attach(
  db: Database,
  memberId: string,
  surface: Surface,
  connId: string | null,
): PresenceRow {
  const now = Date.now();
  const row: PresenceRow = {
    id: ulid(),
    member_id: memberId,
    surface,
    status: 'online',
    conn_id: connId,
    last_seen_at: now,
    created_at: now,
  };
  db.prepare(
    `INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, created_at)
     VALUES (@id, @member_id, @surface, @status, @conn_id, @last_seen_at, @created_at)`,
  ).run(row);
  return row;
}

export function heartbeat(db: Database, presenceId: string, status?: PresenceStatus): void {
  if (status) {
    db.prepare('UPDATE presence SET last_seen_at = ?, status = ? WHERE id = ?').run(
      Date.now(),
      status,
      presenceId,
    );
  } else {
    db.prepare('UPDATE presence SET last_seen_at = ? WHERE id = ?').run(Date.now(), presenceId);
  }
}

export function detach(db: Database, presenceId: string): void {
  db.prepare('DELETE FROM presence WHERE id = ?').run(presenceId);
}

/** Does this member currently have any live presence (within timeout)? */
export function hasLivePresence(db: Database, memberId: string, timeoutMs: number): boolean {
  const cutoff = Date.now() - timeoutMs;
  const row = db
    .prepare<[string, number], { n: number }>(
      'SELECT COUNT(*) AS n FROM presence WHERE member_id = ? AND last_seen_at > ?',
    )
    .get(memberId, cutoff);
  return (row?.n ?? 0) > 0;
}

/** Roster presence summary for a team. A member is online if any fresh presence; else offline. */
export function listPresence(db: Database, teamId: string, timeoutMs: number): PresenceSummary[] {
  const cutoff = Date.now() - timeoutMs;
  const members = db
    .prepare<[string], MemberRow>('SELECT * FROM members WHERE team_id = ? AND left_at IS NULL ORDER BY created_at')
    .all(teamId);
  return members.map((member) => {
    const presences = db
      .prepare<[string, number], PresenceRow>(
        'SELECT * FROM presence WHERE member_id = ? AND last_seen_at > ? ORDER BY last_seen_at DESC',
      )
      .all(member.id, cutoff);
    const status: PresenceStatus =
      presences.length === 0
        ? 'offline'
        : presences.some((p) => p.status === 'online')
          ? 'online'
          : 'away';
    return {
      member,
      status,
      presences: presences.map((p) => ({
        surface: p.surface as Surface,
        status: p.status,
        last_seen_at: p.last_seen_at,
      })),
    };
  });
}

/** Remove presence rows older than the timeout. Returns the removed rows (for offline events). */
export function reapStale(db: Database, timeoutMs: number): PresenceRow[] {
  const cutoff = Date.now() - timeoutMs;
  const stale = db
    .prepare<[number], PresenceRow>('SELECT * FROM presence WHERE last_seen_at <= ?')
    .all(cutoff);
  if (stale.length > 0) {
    db.prepare('DELETE FROM presence WHERE last_seen_at <= ?').run(cutoff);
  }
  return stale;
}

export function presenceById(db: Database, id: string): PresenceRow | undefined {
  return db.prepare<[string], PresenceRow>('SELECT * FROM presence WHERE id = ?').get(id);
}
