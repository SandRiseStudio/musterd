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
    model: string | null;
    build: string | null;
    epoch: number | null;
  }[];
}

/** Attach-time context the client may supply (musterd/0.2, ADR 014 + ADR 021 + ADR 101). */
export interface AttachContext {
  provenance?: Provenance | null;
  workspace?: string | null;
  driver?: string | null;
  /** Harness-attested model id (ADR 101). Attested, never verified; absent → null (`unknown`). */
  model?: string | null;
  /** Client-attested build ref of the connecting dist (ADR 135); absent → null (unstamped client). */
  build?: string | null;
  /** Client-attested feature epoch (ADR 148); absent → null (older client). The roster's skew signal. */
  epoch?: number | null;
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
  // Back online — clear any sticky offline reason (ADR 141).
  db.prepare('UPDATE members SET last_offline_reason = NULL WHERE id = ?').run(memberId);
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
    model: ctx.model ?? null,
    build: ctx.build ?? null,
    epoch: ctx.epoch ?? null,
    created_at: now,
  };
  db.prepare(
    `INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, held_until, provenance, workspace, driver, model, build, epoch, created_at)
     VALUES (@id, @member_id, @surface, @status, @conn_id, @last_seen_at, @held_until, @provenance, @workspace, @driver, @model, @build, @epoch, @created_at)`,
  ).run(row);
  return row;
}

/**
 * Release a presence on a clean disconnect: drop the connection but keep the row as a *hold*
 * the same member can reclaim for `graceMs` (single-active, ADR 010). The reaper frees it when
 * `held_until` passes. Held rows are excluded from the live/roster views below.
 * Stamps sticky `disconnected` (ADR 141); during grace `reclaimable` still projects `reconnecting`.
 */
export function release(db: Database, presenceId: string, graceMs: number): void {
  const now = Date.now();
  const member = db
    .prepare<[string], { member_id: string }>('SELECT member_id FROM presence WHERE id = ?')
    .get(presenceId);
  db.prepare(
    'UPDATE presence SET conn_id = NULL, last_seen_at = ?, held_until = ? WHERE id = ?',
  ).run(now, now + graceMs, presenceId);
  if (member) {
    db.prepare(
      "UPDATE members SET last_offline_reason = 'disconnected', updated_at = ? WHERE id = ?",
    ).run(now, member.member_id);
  }
}

/**
 * Drop every presence row for a member (active or held). Used to keep an **agent** seat
 * single-active on a fresh hello (kind-scoped — humans fan out instead, ADR 042), and to free a
 * seat on operator reclaim/remove (any kind).
 */
export function clearMemberPresence(db: Database, memberId: string): void {
  db.prepare('DELETE FROM presence WHERE member_id = ?').run(memberId);
}

/** Drop a single presence row by id — used to evict exactly a displaced connection (ADR 068). */
export function clearPresenceById(db: Database, presenceId: string): void {
  db.prepare('DELETE FROM presence WHERE id = ?').run(presenceId);
}

/**
 * Drop a member's *orphaned* presence rows — held or disconnected leftovers with no live socket
 * (`conn_id IS NULL`). A fresh agent hello uses this to clear crashed-session / grace-hold remnants
 * without touching a live same-workspace session it deliberately keeps (ADR 068).
 */
export function clearOrphanPresence(db: Database, memberId: string): void {
  db.prepare('DELETE FROM presence WHERE member_id = ? AND conn_id IS NULL').run(memberId);
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
    // Model attestation is **sticky** across ambient touches (ADR 101): an authenticated HTTP request
    // carries no model, so `COALESCE(?, model)` preserves the value attested at claim instead of
    // clearing it (attestation only moves forward — a real switch comes via a claim/heartbeat that
    // *does* carry a model). ADR 119: when the client *does* send a model (`x-musterd-model`), COALESCE
    // installs it on a fresh or blank ambient row — the fire-and-exit CLI re-attest path.
    // provenance/workspace/driver stay per-session seed and re-write normally.
    db.prepare(
      'UPDATE presence SET last_seen_at = ?, status = ?, surface = ?, provenance = ?, workspace = ?, driver = ?, model = COALESCE(?, model), build = COALESCE(?, build), epoch = COALESCE(?, epoch) WHERE id = ?',
    ).run(
      Date.now(),
      'online',
      surface,
      provenance,
      ctx.workspace ?? null,
      ctx.driver ?? null,
      ctx.model ?? null,
      ctx.build ?? null,
      ctx.epoch ?? null,
      existing.id,
    );
  } else {
    attach(db, memberId, surface, null, { ...ctx, provenance });
  }
  if (!wasLive) {
    db.prepare('UPDATE members SET last_offline_reason = NULL WHERE id = ?').run(memberId);
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
  // Observer seats (ADR 063) watch without participating — never counted as live sessions.
  const row = db
    .prepare<
      [number],
      { n: number }
    >('SELECT COUNT(DISTINCT p.member_id) AS n FROM presence p JOIN members m ON m.id = p.member_id WHERE p.held_until IS NULL AND p.last_seen_at > ? AND m.observer = 0')
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
    >('SELECT * FROM members WHERE team_id = ? AND left_at IS NULL AND observer = 0 ORDER BY created_at')
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
        model: p.model ?? null,
        build: p.build ?? null,
        epoch: p.epoch ?? null,
      })),
    };
  });
}

/**
 * Member ids on this team that are *held within their reclaim grace* right now (ADR 010) — a release
 * hold (`held_until` still in the future) the same member can reclaim. Distinct from live presence:
 * these read `offline` on the roster ({@link listPresence} excludes held rows), but the seat is a
 * **reservation**, not a vacancy — surfaced as `MemberSummary.reclaimable` so the clobber guard (ADR
 * 066/105) treats it as occupied. This is the one *positive* read of held rows; every other query
 * filters them out. `now` is passed in so the caller aligns it with its other clocks.
 */
export function listReclaimableMemberIds(db: Database, teamId: string, now: number): Set<string> {
  const rows = db
    .prepare<
      [string, number],
      { id: string }
    >('SELECT DISTINCT p.member_id AS id FROM presence p JOIN members m ON m.id = p.member_id WHERE m.team_id = ? AND m.left_at IS NULL AND p.held_until IS NOT NULL AND p.held_until > ?')
    .all(teamId, now);
  return new Set(rows.map((r) => r.id));
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

/**
 * Re-attest the model on a live occupancy (ADR 101): a mid-occupancy model switch (a `/model`
 * command, a fast-mode toggle) is real, so the adapter may update the attested value. Returns the
 * previous value when it actually changed (the caller audits `occupancy.model_attested` with
 * old → new), undefined when the row is missing or the value is unchanged (no audit noise).
 */
export function reattestModel(
  db: Database,
  presenceId: string,
  model: string | null,
): { previous: string | null } | undefined {
  const row = presenceById(db, presenceId);
  if (!row) return undefined;
  const next = model ?? null;
  if ((row.model ?? null) === next) return undefined;
  db.prepare('UPDATE presence SET model = ? WHERE id = ?').run(next, presenceId);
  return { previous: row.model ?? null };
}

/**
 * The current attested model to stamp on an act (ADR 101). When the sending occupancy is known
 * (`presenceId`, the WS path) the stamp reads **exactly that occupancy's** attestation — a member
 * fanned out over two sessions on different models never cross-attributes (ADR 042). When it isn't
 * (the stateless HTTP message paths, which hold no live occupancy) it falls back to the member's
 * freshest presence that attests a model. Null when nothing attests (`unknown`).
 */
export function currentAttestedModel(
  db: Database,
  memberId: string,
  presenceId?: string,
): string | null {
  if (presenceId) {
    const row = db
      .prepare<
        [string, string],
        { model: string | null }
      >('SELECT model FROM presence WHERE id = ? AND member_id = ?')
      .get(presenceId, memberId);
    return row?.model ?? null;
  }
  const row = db
    .prepare<
      [string],
      { model: string | null }
    >('SELECT model FROM presence WHERE member_id = ? AND model IS NOT NULL ORDER BY last_seen_at DESC, id DESC LIMIT 1')
    .get(memberId);
  return row?.model ?? null;
}
