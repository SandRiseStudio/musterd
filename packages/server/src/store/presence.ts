import type { Provenance, PresenceStatus, Surface } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { REMOTE_PRESENCE_TTL_MS } from '../config.js';
import { appendAudit, appendReplicatedEvent } from './audit.js';
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
    wake_lease: string | null;
  }[];
}

/** Attach-time context the client may supply (musterd/0.2, ADR 014 + ADR 021 + ADR 101). */
export interface AttachContext {
  provenance?: Provenance | null;
  workspace?: string | null;
  driver?: string | null;
  /** Harness-attested model id (ADR 101). Attested, never verified; absent → null (`unknown`). */
  model?: string | null;
  /** WHICH TIER produced `model` — `observed` | `environment` | `binding`. Rides with `model` and
   *  means nothing without it; absent → null, which honestly says "this row does not know". */
  model_source?: string | null;
  /** Client-attested build ref of the connecting dist (ADR 135); absent → null (unstamped client). */
  build?: string | null;
  /** Client-attested feature epoch (ADR 148); absent → null (older client). The roster's skew signal. */
  epoch?: number | null;
  /** The wake lease this session was spawned by (ADR 241), attested from `MUSTERD_WAKE_LEASE`.
   *  Absent → null, and null never matches a verifying lease: absence is not an assertion. */
  wake_lease?: string | null;
}

/** The seat and team behind a member id — every transition names the seat, never the private id. */
function seatOf(db: Database, memberId: string): { team_id: string; name: string } | undefined {
  return db
    .prepare<
      [string],
      { team_id: string; name: string }
    >('SELECT team_id, name FROM members WHERE id = ?')
    .get(memberId);
}

type DetachReason = 'goodbye' | 'reaped' | 'displaced' | 'cleared';

/**
 * Emit `presence.detached` for LOCAL rows only (`node IS NULL`), then delete them. `where` selects
 * the rows. A remote row is never the subject of a locally emitted transition: this machine did
 * not end that session and must not say it did (presence replication spec §1).
 */
function detachLocalRows(
  db: Database,
  where: string,
  params: unknown[],
  reason: DetachReason,
): void {
  const rows = db
    .prepare<
      unknown[],
      { id: string; member_id: string }
    >(`SELECT id, member_id FROM presence WHERE node IS NULL AND ${where}`)
    .all(...params);
  for (const r of rows) {
    const seat = seatOf(db, r.member_id);
    if (seat) {
      appendReplicatedEvent(db, seat.team_id, {
        actor: seat.name,
        action: 'presence.detached',
        target: seat.name,
        result: 'allow',
        detail: { presence: r.id, reason },
      });
    }
    db.prepare('DELETE FROM presence WHERE id = ?').run(r.id);
  }
}

/**
 * Create a presence row (a new attachment) for a member on a surface. A member may hold multiple
 * rows at once: agents are kept single-active by the ws hello path (clear-then-attach), while human
 * seats fan out and accumulate live rows (kind-scoped single-active, ADR 042).
 *
 * The row and its `presence.attached` event are one transaction (presence replication, 2026-09-02):
 * the event carries what the roster shows — never `wake_lease`, which identifies rather than
 * describes and does not travel.
 */
export function attach(
  db: Database,
  memberId: string,
  surface: Surface,
  connId: string | null,
  ctx: AttachContext = {},
): PresenceRow {
  return db.transaction(() => {
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
      model_source: ctx.model ? (ctx.model_source ?? null) : null,
      build: ctx.build ?? null,
      epoch: ctx.epoch ?? null,
      wake_lease: ctx.wake_lease ?? null,
      node: null,
      created_at: now,
    };
    db.prepare(
      `INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, held_until, provenance, workspace, driver, model, model_source, build, epoch, wake_lease, node, created_at)
       VALUES (@id, @member_id, @surface, @status, @conn_id, @last_seen_at, @held_until, @provenance, @workspace, @driver, @model, @model_source, @build, @epoch, @wake_lease, @node, @created_at)`,
    ).run(row);
    const seat = seatOf(db, memberId);
    if (seat) {
      appendReplicatedEvent(db, seat.team_id, {
        actor: seat.name,
        action: 'presence.attached',
        target: seat.name,
        result: 'allow',
        detail: {
          presence: row.id,
          surface,
          provenance: row.provenance,
          workspace: row.workspace,
          driver: row.driver,
          model: row.model,
          model_source: row.model_source,
          build: row.build,
          epoch: row.epoch,
        },
      });
    }
    return row;
  })();
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
    // `disconnected` means "ended without a goodbye", so it only fills an empty slot (attach
    // cleared it). A deliberate-exit stamp already placed this session (session_ended via the
    // SessionEnd hook, seat_released via unbind) must survive the socket closing moments later.
    db.prepare(
      "UPDATE members SET last_offline_reason = 'disconnected', updated_at = ? WHERE id = ? AND last_offline_reason IS NULL",
    ).run(now, member.member_id);
  }
}

/**
 * Drop every presence row for a member (active or held). Used to keep an **agent** seat
 * single-active on a fresh hello (kind-scoped — humans fan out instead, ADR 042), and to free a
 * seat on operator reclaim/remove (any kind).
 */
export function clearMemberPresence(db: Database, memberId: string): void {
  detachLocalRows(db, 'member_id = ?', [memberId], 'cleared');
}

/** Drop a single presence row by id — used to evict exactly a displaced connection (ADR 068). */
export function clearPresenceById(db: Database, presenceId: string): void {
  detachLocalRows(db, 'id = ?', [presenceId], 'displaced');
}

/**
 * Drop a member's *orphaned* presence rows — held or disconnected leftovers with no live socket
 * (`conn_id IS NULL`). A fresh agent hello uses this to clear crashed-session / grace-hold remnants
 * without touching a live same-workspace session it deliberately keeps (ADR 068).
 */
export function clearOrphanPresence(db: Database, memberId: string): void {
  detachLocalRows(db, 'member_id = ? AND conn_id IS NULL', [memberId], 'cleared');
}

/**
 * Record that an occupancy was born attesting NOTHING while this member's previous occupancy
 * attested a model (ADR 246) — the de-attestation row. Returns whether one was written.
 *
 * WHY THIS EXISTS. Attestation is sticky WITHIN an occupancy (`model = COALESCE(?, model)` above,
 * and the claim path refuses to clear it) and resets ACROSS one. Both halves are right on their own
 * and the asymmetry is the hole: a new occupancy that attests nothing has no old→new transition to
 * audit, because it was born null — so the seat drops out of the ADR 188 review pool and the ledger
 * cannot say when, or that it happened at all. Measured 2026-08-05: 1214 `occupancy.model_attested`
 * rows, none carrying `new: null`, while `review.ts` has always READ that shape.
 *
 * `new: null` is load-bearing rather than incidental. The durable-attestation reader skips these
 * rows ("a de-attestation proves nothing"), so recording the loss can never become a route for a
 * dead session's model to certify a live review — the thing ADR 187 exists to forbid. This row is a
 * record OF a loss, never a claim about what is running.
 *
 * A seat that has NEVER attested drops nothing: `unknown` from the start is a different fact from
 * "was X, now nothing", and only the second is an event. Without that guard the ledger fills with
 * rows about harnesses that simply cannot attest yet (ADR 158: Codex, today).
 *
 * CONTRACT: callers emit only on a genuinely NEW occupancy — this does not dedupe, because an
 * ambient touch that reuses its row never reaches here and a claim is a new occupancy by definition.
 */
/**
 * Write an occupancy's opening attestation entry — the model it attests, or the fact that it
 * attests nothing (ADR 246). Every claim path calls this and none of them decide the rule
 * themselves.
 *
 * It exists as one function because the `if (model)` branch was duplicated across five claim sites
 * (the WS occupy, three HTTP claim outcomes, and the grant-approval attach), each of which recorded
 * the attested case and silently dropped the unattested one. Five copies of a predicate is how the
 * unattested half stayed invisible for as long as it did — fixing four of five would have left a
 * ledger that is right except where it isn't, which is worse than one that is uniformly incomplete.
 */
export function recordClaimAttestation(
  db: Database,
  teamId: string,
  member: { id: string; name: string },
  occupancyId: string,
  model: string | null | undefined,
): void {
  if (model) {
    // ADR 101: the initial attestation is the first entry in the occupancy's model history — the
    // audit log IS the switch history (old → new, source), never a table.
    appendAudit(db, teamId, {
      actor: member.name,
      action: 'occupancy.model_attested',
      target: member.name,
      result: 'allow',
      detail: { occupancy: occupancyId, old: null, new: model, source: 'claim' },
    });
    return;
  }
  recordUnattestedOccupancy(db, teamId, member, occupancyId, 'claim');
}

export function recordUnattestedOccupancy(
  db: Database,
  teamId: string,
  member: { id: string; name: string },
  occupancyId: string,
  source: 'claim' | 'ambient',
): boolean {
  const prior = db
    .prepare<
      [string, string],
      { model: string | null }
    >('SELECT model FROM presence WHERE member_id = ? AND id != ? AND model IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1')
    .get(member.id, occupancyId);
  if (!prior?.model) return false;
  appendAudit(db, teamId, {
    actor: member.name,
    action: 'occupancy.model_attested',
    target: member.name,
    result: 'allow',
    detail: { occupancy: occupancyId, old: prior.model, new: null, source },
  });
  return true;
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
  detachLocalRows(db, 'id = ?', [presenceId], 'goodbye');
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
    // provenance/workspace/driver stay per-session seed and re-write normally — and `wake_lease`
    // (ADR 241) rides with provenance rather than with model, deliberately. The two answer one
    // question together ("which session animates this row, and what caused it"), so a touch that
    // re-writes provenance must re-write the token in the same breath; a sticky token under a
    // fresh provenance would claim a lease the session no longer belongs to.
    db.prepare(
      // `model_source` is COALESCEd on the SAME condition as `model` (`ctx.model ? … : null`), so the
      // pair moves or stays together. Sticky-independently would be worse than not recording it: a
      // new model under a stale tier is a stamp that lies about its own provenance.
      'UPDATE presence SET last_seen_at = ?, status = ?, surface = ?, provenance = ?, workspace = ?, driver = ?, wake_lease = ?, model = COALESCE(?, model), model_source = COALESCE(?, model_source), build = COALESCE(?, build), epoch = COALESCE(?, epoch) WHERE id = ?',
    ).run(
      Date.now(),
      'online',
      surface,
      provenance,
      ctx.workspace ?? null,
      ctx.driver ?? null,
      ctx.wake_lease ?? null,
      ctx.model ?? null,
      ctx.model ? (ctx.model_source ?? null) : null,
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

/**
 * The set of `driver` names carried by a *live* presence right now on this team (ADR 021 co-presence,
 * activated by ADR 155 Increment 1). A driver names the human steering a live agent session; this is
 * how the roster derives "steering marks you working" — a human whose name is in this set composes as
 * `working`/present even without their own heartbeat, computed at read time, no synthetic presence row.
 * Same live filter as the roster (fresh heartbeat, not a release hold), scoped to the team.
 */
export function listLiveDrivers(db: Database, teamId: string, timeoutMs: number): Set<string> {
  const cutoff = Date.now() - timeoutMs;
  const rows = db
    .prepare<
      [string, number],
      { driver: string }
    >('SELECT DISTINCT p.driver AS driver FROM presence p JOIN members m ON m.id = p.member_id WHERE m.team_id = ? AND p.driver IS NOT NULL AND p.held_until IS NULL AND p.last_seen_at > ?')
    .all(teamId, cutoff);
  return new Set(rows.map((r) => r.driver));
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
        wake_lease: p.wake_lease ?? null,
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
  return db.transaction(() => {
    // The heartbeat cutoff is a LOCAL rule: only this machine's sockets and ambient touches animate
    // a local row, so only a local row can go quiet by it.
    const stale = db
      .prepare<
        [number, number],
        PresenceRow
      >('SELECT * FROM presence WHERE node IS NULL AND (last_seen_at <= ? OR (held_until IS NOT NULL AND held_until <= ?))')
      .all(cutoff, now);
    detachLocalRows(
      db,
      'last_seen_at <= ? OR (held_until IS NOT NULL AND held_until <= ?)',
      [cutoff, now],
      'reaped',
    );
    // Remote rows whose node has gone quiet: removed silently — this machine did not end that
    // session and must not say it did (spec §1). The origin's own `detached`, if it ever arrives,
    // deletes nothing and advances the cursor.
    const remoteCutoff = now - REMOTE_PRESENCE_TTL_MS;
    db.prepare(
      `DELETE FROM presence WHERE node IS NOT NULL AND id IN (
         SELECT p.id FROM presence p LEFT JOIN nodes n ON n.id = p.node
          WHERE p.node IS NOT NULL AND (n.last_seen_at IS NULL OR n.last_seen_at <= ?))`,
    ).run(remoteCutoff);
    return stale;
  })();
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
  modelSource?: string | null,
): { previous: string | null } | undefined {
  const row = presenceById(db, presenceId);
  if (!row) return undefined;
  const next = model ?? null;
  const nextSource = next ? (modelSource ?? null) : null;
  // Compare BOTH: a heal that only corrects the tier (same id, observation now backing what was a
  // declaration) is a real change and must be written, or the stamp keeps under-reporting itself.
  if ((row.model ?? null) === next && (row.model_source ?? null) === nextSource) return undefined;
  db.prepare('UPDATE presence SET model = ?, model_source = ? WHERE id = ?').run(
    next,
    nextSource,
    presenceId,
  );
  emitReattested(db, presenceId);
  return { previous: row.model ?? null };
}

/**
 * `presence.reattested` for a LOCAL row after its model or surface changed (presence replication,
 * 2026-09-02). Carries the whole attestation triple so a peer's fold needs no prior state beyond
 * the row itself. Callers return early when nothing changed, so no duplicate rows.
 */
function emitReattested(db: Database, presenceId: string): void {
  const after = presenceById(db, presenceId);
  if (!after || after.node !== null) return;
  const seat = seatOf(db, after.member_id);
  if (!seat) return;
  appendReplicatedEvent(db, seat.team_id, {
    actor: seat.name,
    action: 'presence.reattested',
    target: seat.name,
    result: 'allow',
    detail: {
      presence: presenceId,
      model: after.model,
      model_source: after.model_source,
      surface: after.surface,
    },
  });
}

/**
 * Re-attest the occupancy surface on a live presence (ADR 275): occupancy follows capture the
 * same way model does, so a mid-session heal must not keep the claim-time declaration. Returns
 * the previous value when it actually changed; undefined when the row is missing or unchanged
 * (no write). No audit row — `presence.surface` is the instrument (ADR 275 §4).
 */
export function reattestSurface(
  db: Database,
  presenceId: string,
  surface: Surface,
): { previous: Surface } | undefined {
  const row = presenceById(db, presenceId);
  if (!row) return undefined;
  if (row.surface === surface) return undefined;
  db.prepare('UPDATE presence SET surface = ? WHERE id = ?').run(surface, presenceId);
  emitReattested(db, presenceId);
  return { previous: row.surface as Surface };
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
  return currentAttestation(db, memberId, presenceId).model;
}

/**
 * The attested model **and the tier that produced it**, read together from one row (ADR 301). Always read as a pair: joining a model from one row to a tier from another is the
 * cross-attribution the `senderPresenceId` key exists to prevent, one field over.
 *
 * `source` is null whenever `model` is null, and may ALSO be null beside a real model — a row
 * written before migration 42, or by a client too old to send it. That null is honest and must not
 * be defaulted to `binding`: "we do not know which tier" is a different fact from "it was a
 * declaration", and guessing collapses exactly the distinction this carries.
 */
export function currentAttestation(
  db: Database,
  memberId: string,
  presenceId?: string,
): { model: string | null; source: string | null } {
  const row = presenceId
    ? db
        .prepare<
          [string, string],
          { model: string | null; model_source: string | null }
        >('SELECT model, model_source FROM presence WHERE id = ? AND member_id = ?')
        .get(presenceId, memberId)
    : db
        .prepare<
          [string],
          { model: string | null; model_source: string | null }
        >('SELECT model, model_source FROM presence WHERE member_id = ? AND model IS NOT NULL ORDER BY last_seen_at DESC, id DESC LIMIT 1')
        .get(memberId);
  const model = row?.model ?? null;
  return { model, source: model ? (row?.model_source ?? null) : null };
}
