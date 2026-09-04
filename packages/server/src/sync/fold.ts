import {
  ActSchema,
  ToolCallEventSchema,
  type SyncPullEvent,
  type SyncPullLaneEvent,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { getMemberByName } from '../store/members.js';
import { upsertForeignNode } from '../store/nodes.js';
import type { MessageRow } from '../store/rows.js';
import { recordToolCalls } from '../store/toolCalls.js';

/**
 * The fold (ADR 325 increment 3b-ii): apply the team's canonical order to THIS daemon's `messages`.
 *
 * This is the second insert path ADR 331 §Consequences warned about, and the whole slice is shaped
 * so there is exactly one of it, reviewed here, run by hub and puller alike. Three disciplines:
 *
 *  - **`nodes.next_seq` is never touched.** A folded row keeps the stamp its origin minted; the
 *    local allocator belongs to `insertMessage` alone. `fold.test.ts`'s first case is the falsifier.
 *  - **Idempotent on `(origin_node, origin_seq)`**, held by `idx_messages_origin` (v54) — not on
 *    `messages.id`, which ADR 335 deliberately left unique-per-origin only.
 *  - **Block, don't skip.** The first event that cannot be fully resolved stops the cursor AT that
 *    event; everything before it commits. Out-of-order application would make "everything up to N
 *    is applied" unanswerable, which is the one thing a cursor is for.
 *
 * `created_at` is this daemon's clock at fold time — never `envelope.ts`, which is the ORIGIN's
 * clock and travels (ADR 335 §1). The inbox and wake cursors are moving off `ts` onto `created_at`
 * for exactly that reason (spec §"The ts-cursor defect"); a wire value here would reintroduce the
 * defect under the fixed column.
 */

export type FoldStop =
  | { kind: 'unresolved_seat'; seat: string; hub_seq: number }
  | { kind: 'unknown_act'; act: string; hub_seq: number }
  | { kind: 'id_collision'; id: string; hub_seq: number; held_origin: string }
  | { kind: 'origin_gap'; origin: string; expected: number; got: number; hub_seq: number }
  // Lane events (spec §"The wire, decided"). `unknown_lane_event` is `unknown_act`'s shape for the
  // second kind: a verb this build cannot project — upgrade this daemon, retried each tick.
  // `lane_unborn` is a transition for a lane this daemon never saw born: the origin's lane predates
  // `lane.opened` (2026-09-02) or the log has a hole. Applying it would mint a row with no title.
  | { kind: 'unknown_lane_event'; action: string; hub_seq: number }
  | { kind: 'lane_unborn'; lane: string; action: string; hub_seq: number }
  // Presence events (presence replication, 2026-09-02): the same two shapes for the third kind.
  // `unknown_presence_event` also covers a surface this build's CHECK cannot store — the origin
  // runs a newer build. `presence_unborn` is a re-attestation for a session this daemon never saw
  // attach: a hole, not a fact to invent a row from. (A detach for one is a no-op that advances —
  // the same fact arriving after our stale-node sweep.)
  | { kind: 'unknown_presence_event'; action: string; hub_seq: number }
  | { kind: 'presence_unborn'; presence: string; action: string; hub_seq: number }
  // Ledger events (ADR 365). There is no `unknown_ledger_event` for an unrecognised VERB — a
  // ledger row projects into nothing, so a verb this build has never heard of is a row it can
  // still hold honestly, and blocking would wedge the fold on a fact that decides nothing. The one
  // refusal is a PROJECTED verb wearing the non-projecting tag: a `lane.*`/`presence.*` action
  // under `kind: 'ledger'` would land in `audit` with its stamp and never reach its projector,
  // leaving this daemon's `lanes` silently behind the origin's with no gap to find it by.
  | { kind: 'mistagged_ledger_event'; action: string; hub_seq: number }
  // Policy events (residence-2 census gap 1, 2026-09-03): the fourth kind. Only the first shape —
  // there is no `unborn` for policy, because a team's row always exists here (the fold runs for a
  // team this daemon holds) and the event carries the WHOLE stored doc, not a delta. A verb this
  // build cannot project stops, retried each tick, the same as every other kind.
  | { kind: 'unknown_policy_event'; action: string; hub_seq: number }
  // Continuity events (residence-2 census gap 2, 2026-09-03): the fifth kind. `cursor_unborn` is
  // the cursor's own `unborn` shape — the message the cursor names has not folded here yet, so the
  // position it describes does not exist locally. Blocking is the point: skipping would leave the
  // cursor pointing at a place this daemon cannot resolve, and the next tick has the message.
  | { kind: 'unknown_continuity_event'; action: string; hub_seq: number }
  | { kind: 'cursor_unborn'; message: string; seat: string; hub_seq: number }
  // Record events (ADR 371, residence-2 census gap 3): the sixth kind. A record projects into a
  // TABLE (unlike the ledger), so a verb this build cannot project stops — a row nothing reads is
  // not a fact held honestly. `seed_unborn` is the seed thread's own `unborn`: the relay seed the
  // entry names has not been ingested here yet. The relay runs on every daemon, so it is at most one
  // poll away; blocking is the `lane_unborn` discipline — an entry with no seed to hang on would be
  // a row nothing can find.
  | { kind: 'unknown_record_event'; action: string; hub_seq: number }
  | { kind: 'seed_unborn'; relay_id: string; hub_seq: number };

/** The `lane.*` verbs the fold can project. Anything else stops as `unknown_lane_event`. */
const LANE_VERBS = new Set([
  'lane.opened',
  'lane.claimed',
  'lane.released',
  'lane.updated',
  'lane.state_changed',
  'lane.ready_for_review',
  'lane.closed',
  // Review verbs carry no state; they are held in `audit` for the readers that want them.
  'lane.review_sent_back',
  'lane.review_peer_confirmed',
]);

/**
 * Project one replicated lane transition into this daemon's `lanes` — the materialised fold the
 * spec chose over a read-time projection. Every case mirrors the origin's own write: what the
 * store did to its row when it wrote this verb, this does to ours. `null` when the lane has no row
 * here and the verb is not its birth.
 */
function projectLaneEvent(
  db: Database,
  teamId: string,
  event: SyncPullLaneEvent['event'],
): 'applied' | 'unborn' {
  const d = (event.detail ?? {}) as Record<string, unknown>;
  const laneId = (typeof d['lane'] === 'string' ? d['lane'] : event.target) ?? '';
  const ts = event.ts;
  const held = db
    .prepare<[string, string], { id: string }>('SELECT id FROM lanes WHERE team_id = ? AND id = ?')
    .get(teamId, laneId);

  if (event.action === 'lane.opened') {
    // The birth carries the whole declaration (Finding 4). A replay past the idempotence check
    // cannot reach here, so a held row means two origins minted one lane id: keep ours, the way
    // `id_collision` keeps the message we hold — and say nothing, since the audit row is kept.
    if (held) return 'applied';
    const scope = Array.isArray(d['scope']) ? d['scope'] : [];
    const dependsOn = Array.isArray(d['depends_on']) ? d['depends_on'] : [];
    const risk = Array.isArray(d['risk']) ? d['risk'] : [];
    const stakes = typeof d['stakes'] === 'string' ? d['stakes'] : 'normal';
    const provenance = typeof d['stakes_provenance'] === 'string' ? d['stakes_provenance'] : null;
    db.prepare(
      `INSERT INTO lanes (id, team_id, project, title, detail, kind, owner_seat, role, surface_globs,
                          depends_on, branch, goal_id, risk, stakes, stakes_provenance, merged_json, state,
                          created_by, created_at, claimed_at, resolved_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', ?, ?, NULL, NULL, ?)`,
    ).run(
      laneId,
      teamId,
      typeof d['project'] === 'string' ? d['project'] : 'default',
      typeof d['title'] === 'string' ? d['title'] : '',
      typeof d['detail'] === 'string' ? d['detail'] : null,
      typeof d['kind'] === 'string' ? d['kind'] : null,
      typeof d['role'] === 'string' ? d['role'] : null,
      JSON.stringify(scope),
      JSON.stringify(dependsOn),
      typeof d['branch'] === 'string' ? d['branch'] : null,
      typeof d['goal_id'] === 'string' ? d['goal_id'] : null,
      risk.length > 0 ? JSON.stringify(risk) : null,
      stakes !== 'normal' ? stakes : null,
      provenance === 'defaulted' ? 'defaulted' : null,
      typeof d['created_by'] === 'string' ? d['created_by'] : (event.actor ?? ''),
      typeof d['created_at'] === 'number' ? d['created_at'] : ts,
      typeof d['created_at'] === 'number' ? d['created_at'] : ts,
    );
    return 'applied';
  }
  if (!held) return 'unborn';

  switch (event.action) {
    case 'lane.claimed': {
      const owner = typeof d['owner'] === 'string' ? d['owner'] : event.actor;
      db.prepare(
        `UPDATE lanes SET owner_seat = ?, state = CASE WHEN state = 'open' THEN 'claimed' ELSE state END,
                          claimed_at = ?, updated_at = ? WHERE team_id = ? AND id = ?`,
      ).run(owner, ts, ts, teamId, laneId);
      return 'applied';
    }
    case 'lane.released':
      db.prepare(
        `UPDATE lanes SET owner_seat = NULL, state = 'open', claimed_at = NULL, updated_at = ?
          WHERE team_id = ? AND id = ?`,
      ).run(ts, teamId, laneId);
      return 'applied';
    case 'lane.state_changed': {
      const to = typeof d['to'] === 'string' ? d['to'] : null;
      if (to === null) return 'applied';
      db.prepare('UPDATE lanes SET state = ?, updated_at = ? WHERE team_id = ? AND id = ?').run(
        to,
        ts,
        teamId,
        laneId,
      );
      return 'applied';
    }
    case 'lane.ready_for_review':
      db.prepare(
        "UPDATE lanes SET state = 'awaiting_acceptance', updated_at = ? WHERE team_id = ? AND id = ?",
      ).run(ts, teamId, laneId);
      return 'applied';
    case 'lane.closed': {
      const state = typeof d['state'] === 'string' ? d['state'] : 'done';
      db.prepare(
        'UPDATE lanes SET state = ?, resolved_at = ?, updated_at = ? WHERE team_id = ? AND id = ?',
      ).run(state, ts, ts, teamId, laneId);
      return 'applied';
    }
    case 'lane.updated': {
      // `changes: { field: { from, to } }` — values since hole 2. Each audited field maps to its
      // column; `scope` keeps its historical `surface_globs` column name.
      const changes = (d['changes'] ?? {}) as Record<string, { to?: unknown }>;
      const column: Record<string, string> = {
        title: 'title',
        detail: 'detail',
        project: 'project',
        role: 'role',
        scope: 'surface_globs',
        depends_on: 'depends_on',
        branch: 'branch',
        goal_id: 'goal_id',
        risk: 'risk',
        stakes: 'stakes',
        kind: 'kind',
        merged: 'merged_json',
      };
      for (const [field, change] of Object.entries(changes)) {
        const col = column[field];
        if (!col) continue;
        let value: unknown = change.to ?? null;
        if (field === 'scope' || field === 'depends_on') value = JSON.stringify(value ?? []);
        else if (field === 'risk')
          value = Array.isArray(value) && value.length > 0 ? JSON.stringify(value) : null;
        else if (field === 'stakes') value = value === 'normal' ? null : value;
        else if (field === 'merged') value = value === null ? null : JSON.stringify(value);
        db.prepare(`UPDATE lanes SET ${col} = ?, updated_at = ? WHERE team_id = ? AND id = ?`).run(
          value,
          ts,
          teamId,
          laneId,
        );
      }
      return 'applied';
    }
    default:
      return 'applied';
  }
}

/** The `policy.*` verbs the fold can project. Anything else stops as `unknown_policy_event`. */
const POLICY_VERBS = new Set(['policy.change']);

/**
 * Project a replicated policy change into this daemon's `teams.policy` (residence-2 census gap 1).
 *
 * Replace semantics, exactly as `setPolicy` has them: the event's `detail` is the whole STORED
 * sparse override, so a key it omits is unset here too and this build's own default comes back to
 * life for it. Nothing is merged into the local row — a merge would let a knob an admin cleared on
 * the hub survive forever on every machine that once held it.
 *
 * `policy` is hub-authoritative, so this is a one-writer projection: last hub event wins, and there
 * is no per-machine value to reconcile against. `updated_at` is the local clock at fold time, like
 * every other folded row's receipt stamp.
 */
function projectPolicyEvent(
  db: Database,
  teamId: string,
  event: SyncPullLaneEvent['event'],
  now: number,
): 'applied' | 'unknown' {
  if (event.action !== 'policy.change') return 'unknown';
  const stored = event.detail ?? {};
  db.prepare('UPDATE teams SET policy = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(stored),
    now,
    teamId,
  );
  return 'applied';
}

/** The `record.*` verbs the fold can project. Anything else stops as `unknown_record_event`. */
const RECORD_VERBS = new Set(['record.tool_calls', 'record.seed_thread', 'record.incident_report']);

/**
 * Project a replicated record (ADR 371) into its table. Nothing here decides: every projection is
 * an additive UPSERT or an idempotent INSERT, and the fold's Rule 2 (a held `(origin_node,
 * origin_seq)` pair is skipped before this runs) is what makes the additive one exactly-once.
 *
 * - `tool_calls`: the same hourly fold `recordToolCalls` runs, under the ORIGIN's `bucket_start` —
 *   the batch landed in that hour on the machine that measured it, and the report groups by hour.
 * - `seed_thread`: `seeds.id` and `members.id` are daemon-private, so the entry names the relay id
 *   and the member; both resolve HERE. The entry keeps the origin's id — one row, one key, on every
 *   machine — and the member is resolved by the caller (the seat rule every seat-fact kind shares).
 * - `incident_report`: the hub's pool row, mirrored read-only so `incidentReporters` answers on a
 *   joiner. The same verb carries the later `lane_id` stamp, hence the upsert on the id.
 */
function projectRecordEvent(
  db: Database,
  teamId: string,
  event: SyncPullLaneEvent['event'],
  memberId: string | null,
): 'applied' | 'unknown' | 'seed_unborn' {
  const d = event.detail ?? {};
  if (event.action === 'record.tool_calls') {
    const seat = typeof d['seat'] === 'string' ? d['seat'] : event.actor;
    const bucket = typeof d['bucket_start'] === 'number' ? d['bucket_start'] : event.ts;
    const parsed = z.array(ToolCallEventSchema).safeParse(d['events']);
    if (!seat || !parsed.success) return 'unknown';
    recordToolCalls(
      db,
      teamId,
      seat,
      typeof d['role'] === 'string' ? d['role'] : null,
      parsed.data,
      bucket,
    );
    return 'applied';
  }
  if (event.action === 'record.seed_thread') {
    const entryId = d['entry_id'];
    const relayId = d['relay_id'];
    const kind = d['kind'];
    const body = d['body'];
    const createdAt = typeof d['created_at'] === 'number' ? d['created_at'] : event.ts;
    if (
      typeof entryId !== 'string' ||
      typeof relayId !== 'string' ||
      typeof kind !== 'string' ||
      typeof body !== 'string' ||
      !memberId
    )
      return 'unknown';
    const seed = db
      .prepare<
        [string, string],
        { id: string }
      >('SELECT id FROM seeds WHERE team_id = ? AND relay_id = ?')
      .get(teamId, relayId);
    if (!seed) return 'seed_unborn';
    db.prepare(
      `INSERT OR IGNORE INTO seed_thread_entries (id, seed_id, kind, body, member_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(entryId, seed.id, kind, body, memberId, createdAt);
    return 'applied';
  }
  if (event.action === 'record.incident_report') {
    const reportId = d['report_id'];
    const gate = d['gate'];
    const seat = typeof d['seat'] === 'string' ? d['seat'] : event.actor;
    if (typeof reportId !== 'string' || typeof gate !== 'string' || !seat) return 'unknown';
    db.prepare(
      `INSERT INTO incident_reports (id, team_id, gate, seat, sig, ref, message_id, lane_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET lane_id = COALESCE(excluded.lane_id, lane_id)`,
    ).run(
      reportId,
      teamId,
      gate,
      seat,
      typeof d['sig'] === 'string' ? d['sig'] : null,
      typeof d['ref'] === 'string' ? d['ref'] : null,
      typeof d['message_id'] === 'string' ? d['message_id'] : null,
      typeof d['lane_id'] === 'string' ? d['lane_id'] : null,
      typeof d['created_at'] === 'number' ? d['created_at'] : event.ts,
    );
    return 'applied';
  }
  return 'unknown';
}

/** The `continuity.*` verbs the fold can project. Anything else stops as `unknown_continuity_event`. */
const CONTINUITY_VERBS = new Set([
  'continuity.memory_saved',
  'continuity.memory_cleared',
  'continuity.cursor_advanced',
]);

/**
 * Project a replicated continuity event into this daemon's `seat_memory` / `inbox_cursors`
 * (residence-2 census gap 2). The seat is already resolved by the caller.
 *
 * MEMORY is last-writer-wins on the ORIGIN's clock. `saved_at` (or `cleared_at`) travels in the
 * event and is compared against the local row's `saved_at`; an older event loses and is applied as
 * a no-op rather than stopping, because a note that lost a race is not a hole in the log. One clock
 * per fact, the origin's — the rule ADR 335 sets for `ts` and the only one that survives two
 * machines whose wall clocks disagree by more than the gap between two saves.
 *
 * A CLEAR is a fact with a timestamp, not an absence: without one, a note a seat deliberately
 * dropped walks back in from the next peer that still holds it.
 *
 * CURSORS never carry a timestamp across. `last_read_message_id` is resolved against THIS daemon's
 * `messages.created_at`, and the cursor takes the max of that and where it already sits. This is
 * the ts-cursor defect (lane 01M1FAYTHQA881M35PDPXRTGM1) in federated form: `last_read_ts` is a
 * receipt clock, and the same message has a different one on every machine that folded it, so
 * max-merging the raw number would move the cursor to a position no local row ever occupied and
 * swallow the unread acts in between. A cursor is a place in the log; the place is re-read here.
 */
function projectContinuityEvent(
  db: Database,
  teamId: string,
  seat: { id: string; name: string },
  event: SyncPullLaneEvent['event'],
  now: number,
): 'applied' | 'unknown' | 'cursor_unborn' {
  const detail = event.detail ?? {};
  if (event.action === 'continuity.memory_saved') {
    const savedAt = typeof detail['saved_at'] === 'number' ? detail['saved_at'] : event.ts;
    const local = db
      .prepare<
        [string],
        { saved_at: number }
      >('SELECT saved_at FROM seat_memory WHERE member_id = ?')
      .get(seat.id);
    if (local && local.saved_at >= savedAt) return 'applied';
    // No local note is NOT "nothing to compare against" (gptbot's decline of lane 01M1JNY14F,
    // 2026-09-03): a clear deleted the row, and a save minted BEFORE that clear on another machine
    // can still arrive after it. The clear's clock is held — every `continuity.memory_cleared` is an
    // audit row with `cleared_at`, this daemon's own included — so the delayed older save loses to
    // it here exactly as it would have lost to the row the clear removed. ADR 366 decision 4.
    if (!local) {
      const cleared = db
        .prepare<[string, string], { t: number | null }>(
          `SELECT MAX(json_extract(detail, '$.cleared_at')) AS t FROM audit
            WHERE team_id = ? AND action = 'continuity.memory_cleared' AND actor = ?`,
        )
        .get(teamId, seat.name);
      if (cleared?.t != null && cleared.t >= savedAt) return 'applied';
    }
    db.prepare(
      `INSERT INTO seat_memory (member_id, headline, body, saved_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         headline = excluded.headline, body = excluded.body, saved_at = excluded.saved_at`,
    ).run(
      seat.id,
      typeof detail['headline'] === 'string' ? detail['headline'] : '',
      typeof detail['body'] === 'string' ? detail['body'] : '',
      savedAt,
    );
    return 'applied';
  }
  if (event.action === 'continuity.memory_cleared') {
    const clearedAt = typeof detail['cleared_at'] === 'number' ? detail['cleared_at'] : event.ts;
    const local = db
      .prepare<
        [string],
        { saved_at: number }
      >('SELECT saved_at FROM seat_memory WHERE member_id = ?')
      .get(seat.id);
    // A save made after the clear wins: the seat wrote a new note on another machine, and the
    // clear it raced is about the note that note replaced.
    if (local && local.saved_at > clearedAt) return 'applied';
    db.prepare('DELETE FROM seat_memory WHERE member_id = ?').run(seat.id);
    return 'applied';
  }
  if (event.action === 'continuity.cursor_advanced') {
    const messageId = detail['last_read_message_id'];
    if (typeof messageId !== 'string') return 'unknown';
    const row = db
      .prepare<[string], { created_at: number }>('SELECT created_at FROM messages WHERE id = ?')
      .get(messageId);
    if (!row) return 'cursor_unborn';
    const local = db
      .prepare<
        [string],
        { last_read_ts: number; last_read_message_id: string | null }
      >('SELECT last_read_ts, last_read_message_id FROM inbox_cursors WHERE member_id = ?')
      .get(seat.id);
    // Forward only, measured in this daemon's own order — and that order is the `(created_at, id)`
    // point `listMessages` reads unread against (store/messages.ts), not `created_at` alone. Two
    // messages folded in one batch share a millisecond, and a cursor that compared only the clock
    // would refuse to move from the first to the second while `unread` still listed the second.
    // The continuity test caught exactly that. An event naming an EARLIER place is not a conflict
    // to resolve — the seat read further on some other machine, and that is already here.
    if (
      local &&
      (local.last_read_ts > row.created_at ||
        (local.last_read_ts === row.created_at && (local.last_read_message_id ?? '') >= messageId))
    ) {
      return 'applied';
    }
    db.prepare(
      `INSERT INTO inbox_cursors (member_id, last_read_message_id, last_read_ts, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         last_read_message_id = excluded.last_read_message_id,
         last_read_ts = excluded.last_read_ts,
         updated_at = excluded.updated_at`,
    ).run(seat.id, messageId, row.created_at, now);
    return 'applied';
  }
  return 'unknown';
}

const PRESENCE_VERBS = new Set(['presence.attached', 'presence.detached', 'presence.reattested']);

/** The surfaces this build's `presence` CHECK admits (migration 57). Keep in step with it. */
const STORABLE_SURFACES = new Set([
  'cli',
  'claude-code',
  'codex',
  'opencode',
  'grok',
  'cursor',
  'web',
  'ios',
  'slack',
  'other',
  'musterd',
]);

/**
 * Project one replicated presence transition into this daemon's `presence` (spec §2). `node` is
 * the origin; `conn_id`/`held_until`/`wake_lease` are NULL: nothing here heartbeats, holds, or
 * verifies a lease for a session on another machine. A detach for a row we no longer hold is the
 * same fact arriving after our stale-node sweep — applied as a no-op. A reattest for a row we never
 * held is a hole, and stops.
 */
function projectPresenceEvent(
  db: Database,
  teamId: string,
  originNode: string,
  event: SyncPullLaneEvent['event'],
): 'applied' | 'unborn' | 'unknown' {
  const d = (event.detail ?? {}) as Record<string, unknown>;
  const presenceId = typeof d['presence'] === 'string' ? d['presence'] : '';
  if (!presenceId) return 'unknown';
  const str = (k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null);
  switch (event.action) {
    case 'presence.attached': {
      const surface = str('surface');
      if (!surface || !STORABLE_SURFACES.has(surface)) return 'unknown';
      const member = getMemberByName(db, teamId, event.actor ?? '');
      if (!member) return 'unknown'; // the caller resolved the seat already; defensive
      // Two origins minting one presence id cannot happen (ULIDs); a held row here is a replay
      // that slipped the pair check, so keep ours.
      if (db.prepare('SELECT 1 FROM presence WHERE id = ?').get(presenceId)) return 'applied';
      const model = str('model');
      db.prepare(
        `INSERT INTO presence (id, member_id, surface, status, conn_id, last_seen_at, held_until, provenance, workspace, driver, model, model_source, build, epoch, wake_lease, node, created_at)
         VALUES (?, ?, ?, 'online', NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        presenceId,
        member.id,
        surface,
        event.ts,
        str('provenance'),
        str('workspace'),
        str('driver'),
        model,
        model ? str('model_source') : null,
        str('build'),
        typeof d['epoch'] === 'number' ? d['epoch'] : null,
        originNode,
        event.ts,
      );
      return 'applied';
    }
    case 'presence.detached':
      db.prepare('DELETE FROM presence WHERE id = ? AND node = ?').run(presenceId, originNode);
      return 'applied';
    case 'presence.reattested': {
      const surface = str('surface');
      if (surface && !STORABLE_SURFACES.has(surface)) return 'unknown';
      const model = str('model');
      const r = db
        .prepare(
          'UPDATE presence SET model = ?, model_source = ?, surface = COALESCE(?, surface) WHERE id = ? AND node = ?',
        )
        .run(model, model ? str('model_source') : null, surface, presenceId, originNode);
      return r.changes === 0 ? 'unborn' : 'applied';
    }
    default:
      return 'unknown';
  }
}

/** The pull response's `nodes` summary, applied before the events it accompanies (spec §3). */
export function foldNodeLiveness(
  db: Database,
  teamId: string,
  nodes: { id: string; label: string; last_seen_at: number | null }[],
): void {
  // Safe for the local node too: `upsertForeignNode` touches only label and last_seen_at.
  for (const n of nodes) upsertForeignNode(db, teamId, n);
}

export interface FoldResult {
  applied: number;
  skipped: number;
  /** The cursor after this call — the last hub_seq applied or skipped. */
  last_hub_seq: number;
  stop: FoldStop | null;
  /**
   * The ids of the messages this call inserted, in fold order — the hub's route-time hooks that a
   * folded message must still fire (the incident pool, ADR 371 §2) run from this list, never from a
   * re-scan of `messages`, which would re-fire them on every tick.
   */
  messages: string[];
}

export function readPullCursor(db: Database, teamId: string): number {
  return (
    db
      .prepare<
        [string],
        { last_hub_seq: number }
      >('SELECT last_hub_seq FROM sync_pull_cursor WHERE team_id = ?')
      .get(teamId)?.last_hub_seq ?? 0
  );
}

function writePullCursor(db: Database, teamId: string, hubSeq: number, now: number): void {
  db.prepare(
    `INSERT INTO sync_pull_cursor (team_id, last_hub_seq, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET last_hub_seq = excluded.last_hub_seq, updated_at = excluded.updated_at`,
  ).run(teamId, hubSeq, now);
}

function localNodeId(db: Database, teamId: string): string | null {
  return (
    db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(teamId)?.node_id ?? null
  );
}

/**
 * The highest origin_seq this daemon holds for an origin — the read-side gap check's baseline.
 * Across BOTH replicated kinds: one allocator serves messages and lane rows (ADR 335 §8), so a head
 * read from one table alone under-reports and trips the gap check on a legitimate sequence.
 */
function heldHead(db: Database, originNode: string): number {
  const m =
    db
      .prepare<
        [string],
        { high: number | null }
      >('SELECT MAX(origin_seq) AS high FROM messages WHERE origin_node = ?')
      .get(originNode)?.high ?? 0;
  const a =
    db
      .prepare<
        [string],
        { high: number | null }
      >('SELECT MAX(origin_seq) AS high FROM audit WHERE origin_node = ?')
      .get(originNode)?.high ?? 0;
  return Math.max(m, a);
}

/** Rule 2 for both kinds: is the pair already held here? */
function heldPair(db: Database, originNode: string, originSeq: number): boolean {
  return (
    db
      .prepare<
        [string, number],
        { id: string }
      >('SELECT id FROM messages WHERE origin_node = ? AND origin_seq = ?')
      .get(originNode, originSeq) !== undefined ||
    db
      .prepare<
        [string, number],
        { id: string }
      >('SELECT id FROM audit WHERE origin_node = ? AND origin_seq = ?')
      .get(originNode, originSeq) !== undefined
  );
}

export function foldBatch(
  db: Database,
  teamId: string,
  events: SyncPullEvent[],
  now: number = Date.now(),
  /**
   * Where the log's lane history begins (`laneGenesis`), or `null` when the peer did not say. A
   * transition for a lane older than this needs no birth to wait for — see the `lane_unborn`
   * branch. `null` keeps the pre-2026-09-04 behaviour: block on every unborn lane.
   */
  laneGenesis: string | null = null,
): FoldResult {
  return db.transaction((): FoldResult => {
    const local = localNodeId(db, teamId);
    const startCursor = readPullCursor(db, teamId);
    let cursor = startCursor;
    let applied = 0;
    let skipped = 0;
    let stop: FoldStop | null = null;
    const messages: string[] = [];

    // A `return finish()` inside db.transaction COMMITS what ran before it: the prefix and the
    // cursor go together. Only an unclassified throw rolls the batch back.
    const finish = (): FoldResult => {
      if (cursor !== startCursor) writePullCursor(db, teamId, cursor, now);
      return { applied, skipped, last_hub_seq: cursor, stop, messages };
    };

    for (const event of events) {
      // Rule 1 — own origin: already here via insertMessage / the store's lane write. Not an error.
      if (local !== null && event.origin_node === local) {
        skipped += 1;
        cursor = event.hub_seq;
        continue;
      }

      // Rule 2 — replay: the pair is the idempotence key, whichever kind holds it.
      if (heldPair(db, event.origin_node, event.origin_seq)) {
        skipped += 1;
        cursor = event.hub_seq;
        continue;
      }

      // Read-side gap: the hub ingests gaplessly and we walk hub_seq in order, so this cannot trip
      // unless the hub's own invariant broke. Terminal — it is that invariant's falsifier from here.
      const expected = heldHead(db, event.origin_node) + 1;
      if (event.origin_seq !== expected) {
        stop = {
          kind: 'origin_gap',
          origin: event.origin_node,
          expected,
          got: event.origin_seq,
          hub_seq: event.hub_seq,
        };
        return finish();
      }

      // The fourth kind: a ledger row (ADR 365). Held in `audit` with its stamp, projected into
      // nothing — the ledger IS the projection, and `deriveWakeMetrics` reads it there. No seat
      // resolution: an audit row's `actor` is text, not a foreign key, so a seat this roster lacks
      // costs nothing and blocking on it would stall the ledger behind git lag.
      if (event.kind === 'ledger') {
        const e = event.event;
        if (e.action.startsWith('lane.') || e.action.startsWith('presence.')) {
          stop = { kind: 'mistagged_ledger_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        db.prepare(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          e.id,
          teamId,
          e.ts,
          e.actor,
          e.action,
          e.target,
          e.result,
          e.detail ? JSON.stringify(e.detail) : null,
          now,
          event.origin_node,
          event.origin_seq,
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      // The policy kind: a policy change (residence-2 census gap 1). Held in `audit` with its
      // stamp, then projected into `teams.policy` in the same transaction — the same discipline as
      // the lane and presence kinds. No seat resolution: the actor is an admin on the HUB's roster
      // and may not be a member here at all, and the fact is about the team, not about a seat.
      if (event.kind === 'policy') {
        const e = event.event;
        if (!POLICY_VERBS.has(e.action)) {
          stop = { kind: 'unknown_policy_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        if (projectPolicyEvent(db, teamId, e, now) === 'unknown') {
          stop = { kind: 'unknown_policy_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        db.prepare(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          e.id,
          teamId,
          e.ts,
          e.actor,
          e.action,
          e.target,
          e.result,
          e.detail ? JSON.stringify(e.detail) : null,
          now,
          event.origin_node,
          event.origin_seq,
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      // The sixth kind: a record (ADR 371, residence-2 census gap 3) — a tool-call batch, a seed
      // thread entry, or the hub's incident pool row. Project first, then hold the row in `audit`
      // with its stamp, the discipline every projecting kind follows. The seed thread names a
      // member and must resolve it here (git lag otherwise); the other two key on seat NAMES and
      // resolve nothing, as the ledger kind does.
      if (event.kind === 'record') {
        const e = event.event;
        if (!RECORD_VERBS.has(e.action)) {
          stop = { kind: 'unknown_record_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        let memberId: string | null = null;
        if (e.action === 'record.seed_thread') {
          const by = e.detail?.['by'];
          const member = getMemberByName(db, teamId, typeof by === 'string' ? by : (e.actor ?? ''));
          if (!member) {
            stop = {
              kind: 'unresolved_seat',
              seat: typeof by === 'string' ? by : (e.actor ?? ''),
              hub_seq: event.hub_seq,
            };
            return finish();
          }
          memberId = member.id;
        }
        const outcome = projectRecordEvent(db, teamId, e, memberId);
        if (outcome === 'unknown') {
          stop = { kind: 'unknown_record_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        if (outcome === 'seed_unborn') {
          const relayId = e.detail?.['relay_id'];
          stop = {
            kind: 'seed_unborn',
            relay_id: typeof relayId === 'string' ? relayId : '',
            hub_seq: event.hub_seq,
          };
          return finish();
        }
        db.prepare(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          e.id,
          teamId,
          e.ts,
          e.actor,
          e.action,
          e.target,
          e.result,
          e.detail ? JSON.stringify(e.detail) : null,
          now,
          event.origin_node,
          event.origin_seq,
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      // The fifth kind: a seat's continuity — its memory note and its inbox cursor (residence-2
      // census gap 2). Seat facts, so the seat must resolve here before anything is projected: an
      // unknown name is git lag, the same rule the message and presence kinds follow.
      if (event.kind === 'continuity') {
        const e = event.event;
        if (!CONTINUITY_VERBS.has(e.action)) {
          stop = { kind: 'unknown_continuity_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        const seat = getMemberByName(db, teamId, e.actor ?? '');
        if (!seat) {
          stop = { kind: 'unresolved_seat', seat: e.actor ?? '', hub_seq: event.hub_seq };
          return finish();
        }
        // Project first, so a stop lands BEFORE the audit row does — a row present for an event
        // this daemon never applied would advance heldHead past it.
        const outcome = projectContinuityEvent(db, teamId, seat, e, now);
        if (outcome === 'unknown') {
          stop = { kind: 'unknown_continuity_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        if (outcome === 'cursor_unborn') {
          const messageId = e.detail?.['last_read_message_id'];
          stop = {
            kind: 'cursor_unborn',
            message: typeof messageId === 'string' ? messageId : '',
            seat: seat.name,
            hub_seq: event.hub_seq,
          };
          return finish();
        }
        db.prepare(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          e.id,
          teamId,
          e.ts,
          e.actor,
          e.action,
          e.target,
          e.result,
          e.detail ? JSON.stringify(e.detail) : null,
          now,
          event.origin_node,
          event.origin_seq,
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      // The third kind: a presence transition. Same discipline as the lane kind — project first,
      // then hold the row in `audit` with its stamp — plus the message rule for the seat: a
      // presence for a seat this roster lacks is git lag, not a fact to drop.
      if (event.kind === 'presence') {
        const e = event.event;
        if (!PRESENCE_VERBS.has(e.action)) {
          stop = { kind: 'unknown_presence_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        // A seat this roster does not hold is git lag for a MESSAGE — the inbox counts it, so the
        // fold waits (Rule 3, below). Presence is the other case, and ADR 382 decided it: a
        // presence row for a seat we do not hold paints no roster line and gates no claim, so it
        // projects into nothing — and a row that projects into nothing is one this daemon can hold
        // honestly, the ledger's own carve-out. Waiting is what hurts: a seat minted db-only (a web
        // sign-in, never in git) can never arrive, and one stopped the first real joiner dead at
        // hub_seq 9657 (2026-09-04). So it advances, and the audit row below still lands — evidence,
        // not a hole. This is the attach's half of a rule detach already followed.
        const seatHeld = Boolean(getMemberByName(db, teamId, e.actor ?? ''));
        if (seatHeld) {
          const outcome = projectPresenceEvent(db, teamId, event.origin_node, e);
          if (outcome === 'unknown') {
            stop = { kind: 'unknown_presence_event', action: e.action, hub_seq: event.hub_seq };
            return finish();
          }
          if (outcome === 'unborn') {
            const presenceId =
              typeof e.detail?.['presence'] === 'string' ? (e.detail['presence'] as string) : '';
            stop = {
              kind: 'presence_unborn',
              presence: presenceId,
              action: e.action,
              hub_seq: event.hub_seq,
            };
            return finish();
          }
        }
        db.prepare(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          e.id,
          teamId,
          e.ts,
          e.actor,
          e.action,
          e.target,
          e.result,
          e.detail ? JSON.stringify(e.detail) : null,
          now,
          event.origin_node,
          event.origin_seq,
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      // The second kind: a lane transition. Held in `audit` with its stamp verbatim, then projected
      // into `lanes` in this same transaction — the fold is the one foreign writer of both.
      if (event.kind === 'lane') {
        const e = event.event;
        if (!LANE_VERBS.has(e.action)) {
          stop = { kind: 'unknown_lane_event', action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        const laneId =
          (typeof e.detail?.['lane'] === 'string' ? (e.detail['lane'] as string) : e.target) ?? '';
        // Project first: an unborn lane must stop BEFORE the audit row lands, or the row's presence
        // would advance heldHead past an event this daemon never applied.
        const outcome = projectLaneEvent(db, teamId, e);
        // A lane older than the log's first `lane.opened` has no birth anywhere to wait for: the
        // log contains none for anything older, by construction (ULIDs sort by birth time). Waiting
        // is waiting forever — which is precisely how the first real joiner wedged, 9,393 events in.
        // So it advances: no `lanes` row is invented (a row with no title would be worse than none),
        // the audit row below still lands, and the transition stays findable in the trail. Every
        // other unborn lane still blocks, because there the birth may yet arrive or a hole is real.
        const preHistory =
          outcome === 'unborn' && laneGenesis !== null && laneId !== '' && laneId < laneGenesis;
        if (outcome === 'unborn' && !preHistory) {
          stop = { kind: 'lane_unborn', lane: laneId, action: e.action, hub_seq: event.hub_seq };
          return finish();
        }
        db.prepare(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          e.id,
          teamId,
          e.ts,
          e.actor,
          e.action,
          e.target,
          e.result,
          e.detail ? JSON.stringify(e.detail) : null,
          now,
          event.origin_node,
          event.origin_seq,
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      const env = event.envelope;

      // Rule 3 — resolve every seat the envelope names, or stop here. `to` blocks too: NULL would
      // silently turn a directed act into a broadcast.
      const from = getMemberByName(db, teamId, env.from);
      if (!from) {
        stop = { kind: 'unresolved_seat', seat: env.from, hub_seq: event.hub_seq };
        return finish();
      }
      let toMember: string | null = null;
      if (env.to.kind === 'member') {
        const to = getMemberByName(db, teamId, env.to.name);
        if (!to) {
          stop = { kind: 'unresolved_seat', seat: env.to.name, hub_seq: event.hub_seq };
          return finish();
        }
        toMember = to.id;
      }

      // Rule 5 — the id is held under a different pair (rule 2 passed, so it is not a replay).
      const collision = db
        .prepare<[string], { origin_node: string }>('SELECT origin_node FROM messages WHERE id = ?')
        .get(env.id);
      if (collision) {
        stop = {
          kind: 'id_collision',
          id: env.id,
          hub_seq: event.hub_seq,
          held_origin: collision.origin_node,
        };
        return finish();
      }

      // Unknown act — the wire outran the reader: the origin runs a newer build. messages.act
      // carries no CHECK (dropped in the table rewrite), so the schema would happily store it and
      // every reader downstream would meet an act it cannot classify. Block until this daemon is
      // upgraded; skipping would drop an event a peer considers sent.
      if (!ActSchema.safeParse(env.act).success) {
        stop = { kind: 'unknown_act', act: env.act, hub_seq: event.hub_seq };
        return finish();
      }

      // Rule 4 — insert with the origin stamp verbatim. NEVER reads or writes nodes.next_seq.
      const row: MessageRow = {
        id: env.id,
        team_id: teamId,
        from_member: from.id,
        to_kind: env.to.kind,
        to_member: toMember,
        act: env.act,
        body: env.body,
        thread_id: env.thread ?? null,
        meta: env.meta ? JSON.stringify(env.meta) : null,
        from_provenance: event.from_provenance,
        origin_node: event.origin_node,
        origin_seq: event.origin_seq,
        ts: env.ts,
        created_at: now,
      };
      db.prepare(
        `INSERT INTO messages
           (id, team_id, from_member, to_kind, to_member, act, body, thread_id, meta, from_provenance, origin_node, origin_seq, ts, created_at)
         VALUES
           (@id, @team_id, @from_member, @to_kind, @to_member, @act, @body, @thread_id, @meta, @from_provenance, @origin_node, @origin_seq, @ts, @created_at)`,
      ).run(row);
      messages.push(row.id);
      applied += 1;
      cursor = event.hub_seq;
    }
    return finish();
  })();
}
