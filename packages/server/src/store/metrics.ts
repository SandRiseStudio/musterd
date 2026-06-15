import type { Database } from 'better-sqlite3';

/**
 * DB-sampling aggregates behind the observable gauges (observability.md §4). Read-only; called from
 * the metric collection callback, so they must stay cheap (single grouped/aggregate queries).
 */

/** Live presences (connected, within timeout, not a reclaim hold) grouped by surface. */
export function activePresenceBySurface(
  db: Database,
  timeoutMs: number,
  now: number = Date.now(),
): { surface: string; count: number }[] {
  const cutoff = now - timeoutMs;
  return db
    .prepare<
      [number],
      { surface: string; count: number }
    >('SELECT surface, COUNT(*) AS count FROM presence WHERE held_until IS NULL AND last_seen_at > ? GROUP BY surface')
    .all(cutoff);
}

/**
 * How stale the slowest inbox is, in ms: the largest age of any member's oldest *unread* message
 * (addressed to them or team/broadcast, not their own send, past their read cursor). 0 when every
 * member is caught up. This is the "shouting into the void" / backlog signal, derived not stored.
 */
export function slowestInboxLagMs(db: Database, now: number = Date.now()): number {
  const row = db
    .prepare<[], { oldest: number | null }>(
      `SELECT MIN(msg.ts) AS oldest
         FROM members m
         LEFT JOIN inbox_cursors c ON c.member_id = m.id
         JOIN messages msg
           ON msg.team_id = m.team_id
          AND (msg.to_member = m.id OR msg.to_kind IN ('team','broadcast'))
          AND msg.from_member != m.id
          AND msg.ts > COALESCE(c.last_read_ts, 0)
        WHERE m.left_at IS NULL
        GROUP BY m.id
        ORDER BY oldest ASC
        LIMIT 1`,
    )
    .get();
  if (!row || row.oldest == null) return 0;
  return Math.max(0, now - row.oldest);
}
