import type { Provenance, PresenceStatus, Surface } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import type { MemberRow, PresenceRow } from './rows.js';

export interface PresenceSummary {
  member: MemberRow;
  status: PresenceStatus;
  presences: {
    surface: Surface;
    status: PresenceStatus;
    last_seen_at: number;
    provenance: Provenance | null;
    workspace: string | null;
    driver: string | null;
  }[];
}

/** Attach-time context the client may supply (musterd/0.2, ADR 014 + ADR 021). */
export interface AttachContext {
  provenance?: Provenance | null;
  workspace?: string | null;
  driver?: string | null;
}

/**
 * Create a presence row (a new attachment) for a member on a surface. A member may hold multiple
 * rows at once: agents are kept single-active by the ws hello path (clear-then-attach), while human
 * seats fan out and accumulate live rows (kind-scoped single-active, ADR 042).
 */
export function attach(
  db: Database,
  memberId: string,
  surface: Surface,
  connId: string | null,
  ctx: AttachContext = {},
): PresenceRow {
  const now = Date.now();
  const row: PresenceRow = {
    id: ulid(),
    member_id: memberId,
    surface,
    status: 'online',
    conn_id: connId,
    last_seen_at: now,
    held_until: null,
    provenance: ctx.provenance ?? null,
    workspace: ctx.workspace ?? null,
    driver: ctx.driver ?? null,
    created_at: now,
  };
  db.prepare(
    `INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, held_until, provenance, workspace, driver, created_at)
     VALUES (@id, @member_id, @surface, @status, @conn_id, @last_seen_at, @held_until, @provenance, @workspace, @driver, @created_at)`,
  ).run(row);
  return row;
}

/**
 * Release a presence on a clean disconnect: drop the connection but keep the row as a *hold*
 * the same member can reclaim for `graceMs` (single-active, ADR 010). The reaper frees it when
 * `held_until` passes. Held rows are excluded from the live/roster views below.
 */
export function release(db: Database, presenceId: string, graceMs: number): void {
  const now = Date.now();
  db.prepare(
    'UPDATE presence SET conn_id = NULL, last_seen_at = ?, held_until = ? WHERE id = ?',
  ).run(now, now + graceMs, presenceId);
}

/**
 * Drop every presence row for a member (active or held). Used to keep an **agent** seat
 * single-active on a fresh hello (kind-scoped — humans fan out instead, ADR 042), and to free a
 * seat on operator reclaim/remove (any kind).
 */
export function clearMemberPresence(db: Database, memberId: string): void {
  db.prepare('DELETE FROM presence WHERE member_id = ?').run(memberId);
}

/** Does this member currently hold a *live* (connected, non-held) presence? Drives agent single-active. */
export function hasActivePresence(db: Database, memberId: string): boolean {
  const row = db
    .prepare<
      [string],
      { n: number }
    >('SELECT COUNT(*) AS n FROM presence WHERE member_id = ? AND held_until IS NULL AND conn_id IS NOT NULL')
    .get(memberId);
  return (row?.n ?? 0) > 0;
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

/**
 * Ambient presence (ADR 057): a connectionless liveness touch written when a member runs an
 * authenticated command, so a bursty one-shot agent reads present instead of offline between watch
 * sockets. Liveness only — the `working: <x>` label still comes solely from a status_update
 * (two-clocks rule, ADR 010).
 *
 * Three invariants hold it together:
 *  - **No-op under a resident session.** If the member already holds a live *connected* presence (a
 *    real socket), its heartbeat owns liveness; we add nothing (ambient is the fallback for one-shots).
 *  - **Upsert, never append.** Refresh the member's single connectionless, non-held row (or create one
 *    if absent) — a thousand commands leave one ambient row, not a thousand to reap. The explicit
 *    `POST /presence` ping keeps its own row-per-call behavior and is not routed here.
 *  - **Never displaces.** It only writes its own `conn_id = NULL` row; it never closes a socket or
 *    clears rows, so newest-session-wins (ADR 017) stays the only eviction path.
 *
 * Returns true when this touch flipped the member from no-live-presence to present (an offline→online
 * transition), so the caller can emit a presence event to live watchers.
 */
export function touchAmbientPresence(
  db: Database,
  memberId: string,
  surface: Surface,
  timeoutMs: number,
  ctx: AttachContext = {},
): boolean {
  // A live resident session (real socket) already owns liveness — don't add a competing row.
  if (hasActivePresence(db, memberId)) return false;
  const wasLive = hasLivePresence(db, memberId, timeoutMs);
  const provenance: Provenance = ctx.provenance ?? 'session';
  const existing = db
    .prepare<
      [string],
      { id: string }
    >('SELECT id FROM presence WHERE member_id = ? AND conn_id IS NULL AND held_until IS NULL ORDER BY last_seen_at DESC LIMIT 1')
    .get(memberId);
  if (existing) {
    db.prepare(
      'UPDATE presence SET last_seen_at = ?, status = ?, surface = ?, provenance = ?, workspace = ?, driver = ? WHERE id = ?',
    ).run(
      Date.now(),
      'online',
      surface,
      provenance,
      ctx.workspace ?? null,
      ctx.driver ?? null,
      existing.id,
    );
  } else {
    attach(db, memberId, surface, null, { ...ctx, provenance });
  }
  return !wasLive;
}

/** Does this member currently have any live presence (within timeout, not a release hold)? */
export function hasLivePresence(db: Database, memberId: string, timeoutMs: number): boolean {
  const cutoff = Date.now() - timeoutMs;
  const row = db
    .prepare<
      [string, number],
      { n: number }
    >('SELECT COUNT(*) AS n FROM presence WHERE member_id = ? AND held_until IS NULL AND last_seen_at > ?')
    .get(memberId, cutoff);
  return (row?.n ?? 0) > 0;
}

/**
 * How many distinct members hold a *live* presence right now, across **all** teams in this db.
 * The daemon hosts every team, so this cross-team count is the honest answer to "who is connected"
 * — used by the CLI's `service stop|restart` guard (ADR 047) to refuse bouncing a shared daemon out
 * from under a teammate. Counts members, not rows: a member fanned out over two surfaces is one
 * session. Mirrors the live filter used by the roster (fresh heartbeat, not a release hold).
 */
export function countLivePresences(db: Database, timeoutMs: number): number {
  const cutoff = Date.now() - timeoutMs;
  const row = db
    .prepare<
      [number],
      { n: number }
    >('SELECT COUNT(DISTINCT member_id) AS n FROM presence WHERE held_until IS NULL AND last_seen_at > ?')
    .get(cutoff);
  return row?.n ?? 0;
}

/** Roster presence summary for a team. A member is online if any fresh presence; else offline. */
export function listPresence(db: Database, teamId: string, timeoutMs: number): PresenceSummary[] {
  const cutoff = Date.now() - timeoutMs;
  const members = db
    .prepare<
      [string],
      MemberRow
    >('SELECT * FROM members WHERE team_id = ? AND left_at IS NULL ORDER BY created_at')
    .all(teamId);
  return members.map((member) => {
    const presences = db
      .prepare<
        [string, number],
        PresenceRow
      >('SELECT * FROM presence WHERE member_id = ? AND held_until IS NULL AND last_seen_at > ? ORDER BY last_seen_at DESC')
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
        provenance: (p.provenance as Provenance | null) ?? null,
        workspace: p.workspace ?? null,
        driver: p.driver ?? null,
      })),
    };
  });
}

/**
 * Remove dead presence rows — stale live ones (no heartbeat past the timeout) and release holds
 * whose reclaim grace has expired. Returns the removed rows (for offline events).
 */
export function reapStale(db: Database, timeoutMs: number): PresenceRow[] {
  const now = Date.now();
  const cutoff = now - timeoutMs;
  const stale = db
    .prepare<
      [number, number],
      PresenceRow
    >('SELECT * FROM presence WHERE last_seen_at <= ? OR (held_until IS NOT NULL AND held_until <= ?)')
    .all(cutoff, now);
  if (stale.length > 0) {
    db.prepare(
      'DELETE FROM presence WHERE last_seen_at <= ? OR (held_until IS NOT NULL AND held_until <= ?)',
    ).run(cutoff, now);
  }
  return stale;
}

export function presenceById(db: Database, id: string): PresenceRow | undefined {
  return db.prepare<[string], PresenceRow>('SELECT * FROM presence WHERE id = ?').get(id);
}
