import {
  DeferUntilSchema,
  eligibleOf,
  PROTOCOL_VERSION,
  type DeferUntil,
  type Envelope,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import type { MessageRow } from './rows.js';

/**
 * The sender's presence provenance at send time — the freshest non-held row (a resident socket's
 * heartbeat and the ambient touch both keep `last_seen_at` current). Stamped onto the message by
 * `insertMessage` itself, SERVER-derived by construction (there is no wire field), so a wake-born
 * session cannot masquerade as human-driven to escape the ADR 131 §4 ping-pong demotion.
 */
function senderProvenance(db: Database, memberId: string): string | null {
  const row = db
    .prepare<[string], { provenance: string | null }>(
      `SELECT provenance FROM presence
        WHERE member_id = ? AND held_until IS NULL
        ORDER BY last_seen_at DESC, created_at DESC LIMIT 1`,
    )
    .get(memberId);
  return row?.provenance ?? null;
}

/** Insert an envelope into the append-only log. `toMemberId` set iff to.kind==='member'. */
export function insertMessage(
  db: Database,
  teamId: string,
  fromMemberId: string,
  toMemberId: string | null,
  env: Envelope,
): MessageRow {
  const row: MessageRow = {
    id: env.id,
    team_id: teamId,
    from_member: fromMemberId,
    to_kind: env.to.kind,
    to_member: toMemberId,
    act: env.act,
    body: env.body,
    thread_id: env.thread ?? null,
    meta: env.meta ? JSON.stringify(env.meta) : null,
    from_provenance: senderProvenance(db, fromMemberId),
    ts: env.ts,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO messages
       (id, team_id, from_member, to_kind, to_member, act, body, thread_id, meta, from_provenance, ts, created_at)
     VALUES
       (@id, @team_id, @from_member, @to_kind, @to_member, @act, @body, @thread_id, @meta, @from_provenance, @ts, @created_at)`,
  ).run(row);
  return row;
}

/** The `ts` of one message by id (loop-latency lookups, ADR 082 slice 3). Null when unknown. */
export function getMessageTs(db: Database, teamId: string, id: string): number | null {
  const row = db
    .prepare<
      [string, string],
      { ts: number }
    >('SELECT ts FROM messages WHERE team_id = ? AND id = ?')
    .get(teamId, id);
  return row?.ts ?? null;
}

/**
 * Directed acts (request_help/handoff) not yet answered by an accept/decline whose
 * `meta.in_reply_to` names them **or closed by a resolve on their thread** — the open-loops gauge
 * (ADR 082 slice 3; resolve-exclusion added with ADR 090 so the gauge and the delivery ledger are
 * two derivations of one truth). Daemon-wide on purpose: a health signal sampled only when
 * telemetry is on.
 */
export function countOpenLoops(db: Database): number {
  const row = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM messages m
        WHERE m.act IN ('request_help','handoff')
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id
               AND r.act IN ('accept','decline')
               AND json_extract(r.meta, '$.in_reply_to') = m.id)
          AND NOT EXISTS (
            SELECT 1 FROM messages v
             WHERE v.team_id = m.team_id
               AND v.act = 'resolve'
               AND v.thread_id = COALESCE(m.thread_id, m.id))`,
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Open loops grouped by team slug (#207) — the per-team form of {@link countOpenLoops} for the
 * `open_loops` observable gauge, so a per-team/per-model coordination leaderboard can read the gauge
 * by `musterd.team`. Only teams with ≥1 open loop appear (a zero team is simply absent this cycle).
 */
export function countOpenLoopsByTeam(db: Database): { team: string; count: number }[] {
  return db
    .prepare<[], { team: string; count: number }>(
      `SELECT t.slug AS team, COUNT(*) AS count FROM messages m
         JOIN teams t ON t.id = m.team_id
        WHERE m.act IN ('request_help','handoff')
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id
               AND r.act IN ('accept','decline')
               AND json_extract(r.meta, '$.in_reply_to') = m.id)
          AND NOT EXISTS (
            SELECT 1 FROM messages v
             WHERE v.team_id = m.team_id
               AND v.act = 'resolve'
               AND v.thread_id = COALESCE(m.thread_id, m.id))
        GROUP BY t.slug`,
    )
    .all();
}

export interface InboxOpts {
  since?: number;
  unreadOnly?: boolean;
  cursorTs?: number;
  limit?: number;
}

/**
 * A member's inbox: messages in their team addressed to them or to team/broadcast,
 * excluding their own sends. unreadOnly filters by the caller-supplied cursor ts.
 */
export function listInbox(
  db: Database,
  member: { id: string; team_id: string },
  opts: InboxOpts = {},
): MessageRow[] {
  const params: unknown[] = [member.team_id, member.id, member.id];
  let where = `WHERE team_id = ?
       AND (to_member = ? OR to_kind IN ('team','broadcast'))
       AND from_member != ?`;
  if (opts.unreadOnly) {
    where += ' AND ts > ?';
    params.push(opts.cursorTs ?? 0);
  } else if (typeof opts.since === 'number') {
    where += ' AND ts > ?';
    params.push(opts.since);
  }
  // With a limit, take the NEWEST `limit` (DESC + LIMIT) then re-sort ascending for display — an
  // inbox is read most-recent-first, so a bounded view must keep the recent tail, not the oldest N
  // (the `ts ASC LIMIT` bug that returned the wrong end; mirrors listTeamMessages' backfill).
  if (opts.limit) {
    params.push(opts.limit);
    return db
      .prepare<
        unknown[],
        MessageRow
      >(`SELECT * FROM (SELECT * FROM messages ${where} ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts ASC, id ASC`)
      .all(...params);
  }
  return db
    .prepare<unknown[], MessageRow>(`SELECT * FROM messages ${where} ORDER BY ts ASC, id ASC`)
    .all(...params);
}

/**
 * Total size of a member's inbox view (same visibility rule as {@link listInbox}, no cursor/limit) —
 * the denominator behind the CLI's "showing N of TOTAL" footer, so a bounded default can honestly say
 * how much history it elided. Cheap COUNT; unread is derived client-side from the cursor.
 */
export function countInbox(db: Database, member: { id: string; team_id: string }): number {
  const row = db
    .prepare<[string, string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM messages
        WHERE team_id = ?
          AND (to_member = ? OR to_kind IN ('team','broadcast'))
          AND from_member != ?`,
    )
    .get(member.team_id, member.id, member.id);
  return row?.n ?? 0;
}

/**
 * The interrupt-class acts still waiting for `me` in `messages` (ADR 088 §3) — the predicate the
 * `inbox --interrupt-check` probe runs at every tool boundary. Interrupt-class = **directed at me
 * or a `request_help` anyone can answer**, **not closed** by a `resolve` on its thread (ADR 025), and
 * either **flagged urgent** (`meta.urgent === true`, which the send path only ever leaves set when the
 * sender's `can_flag_urgent` passed the ADR 071 gate — so the capability check is already enforced
 * upstream) **or a `steer`** (ADR 103: a directive is interrupt-class by definition, so it raises the
 * line whether or not it is flagged urgent; `challenge`/`defer` stay behind the urgent tier) **or a
 * routed acceptance** (ADR 225: an `ask` carrying `meta.lane_review`). A terminal `resolve` never
 * interrupts.
 *
 * Obligation class (ADR 225 decision 1). Acceptance was structurally invisible here: it is an `ask`
 * at `tier:'standard'` and never carries `urgent`, so the free rail this predicate feeds skipped the
 * one act that blocks another seat's lane. Measured 2026-08-04 — five routed acceptances reached a
 * live, heads-down acceptor only when a human typed "check messages", and two produced a *crossed
 * handoff*: two seats re-assigning one lane twelve minutes apart, each on an inbox the other's act
 * had not reached. Both were alive throughout, so no wake addresses it; the gap yields contradiction,
 * not merely silence. `meta.lane_review` is the marker because the daemon sets it on the review
 * route — and `routeEnvelope` strips any client-supplied copy, so this cannot become an ungated
 * back door around the scarce `can_flag_urgent` flag (ADR 071).
 *
 * Obligations do NOT supersede each other, which is the one place they part company with steers: a
 * steer is a *direction* (newest wins, ADR 103), while an acceptance is an obligation against one
 * specific lane — a second one does not discharge the first, so every open acceptance stays on the
 * line.
 *
 * Steer supersession (ADR 103, borrowing ADR 017's newest-wins primitive applied to *direction*): only
 * the newest steer directed at me survives — older steers are superseded so a late-waking agent sees
 * only the current direction, never a contradictory stack. The winning-steer bar is taken over the
 * whole set (resolved or not) so resolving the current steer can't revive an older one, and the bar
 * can't collapse onto a stale steer. This is a pure read-side collapse, the mirror of how `resolve`
 * closes a thread above; no supersede column, no write-path side-effect.
 *
 * Newest first, so the caller names the most recent steer. Pure — reads envelopes, never the DB — so
 * it is trivially testable and the "daemon-composed, never the raw body" line (§4) is built from its
 * structured fields, not from `env.body`.
 */
export function pendingInterrupts(
  messages: Envelope[],
  me: string,
  /** ADR 225: admit obligation-class acts (a routed acceptance). **Off by default, and that default
   *  is load-bearing** — this predicate has two consumers with opposite needs. The ADR 088 interrupt
   *  line feeds a LIVE seat and is free, so it opts in. `claimWakeLeases` uses the same predicate to
   *  pick *immediate wakes*, which cost ADR 131 `wake_cost` and whose review path is deliberately
   *  gated on `loops.review` + `flow:auto` (ADR 191); admitting acceptance there would route a paid
   *  wake around its own policy gate. That the same predicate cannot serve both rails is precisely
   *  ADR 225's thesis — live and offline want different instruments — appearing in the code. */
  opts: { obligations?: boolean } = {},
): Envelope[] {
  const resolved = new Set<string>();
  // ADR NNN: an eligible-set act is discharged by the FIRST accept/decline naming it — for every
  // named seat at once. Built in the same pass as `resolved` and for the same reason: this predicate
  // is pure over envelopes (no `Database`), so it cannot call the ledger's `actAnswered`. It does not
  // need one — the discharging act is an envelope in the very list being scanned.
  const discharged = new Set<string>();
  for (const m of messages) {
    if (m.act === 'resolve' && m.thread) resolved.add(m.thread);
    if (m.act === 'accept' || m.act === 'decline') {
      const ref = (m.meta as { in_reply_to?: unknown } | null | undefined)?.['in_reply_to'];
      if (typeof ref === 'string') discharged.add(ref);
    }
  }
  const isUrgent = (m: Envelope) =>
    (m.meta as { urgent?: unknown } | null | undefined)?.['urgent'] === true;
  // ADR 225: a routed acceptance is obligation-class. Keyed on the daemon-set `lane_review` marker,
  // never on act+tier alone — a plain directed `ask` must not raise the line.
  const isObligation = (m: Envelope) =>
    opts.obligations === true &&
    m.act === 'ask' &&
    (m.meta as { lane_review?: unknown } | null | undefined)?.['lane_review'] != null;
  // ADR NNN: an eligible set REPLACES the default obligation rule rather than adding to it — which is
  // what narrows `request_help` from "every seat on the team" (its behaviour without a set, below) to
  // the named few. Discharge is checked here rather than at the filter so a stood-down act stops
  // being action-needed *everywhere* at once, including in the `steer` winner scan.
  const actionNeeded = (m: Envelope) => {
    if (m.act === 'resolve') return false;
    const names = eligibleOf(m.meta as Record<string, unknown> | null | undefined);
    if (names) return names.includes(me) && !discharged.has(m.id);
    return m.act === 'request_help' || (m.to.kind === 'member' && m.to.name === me);
  };
  // The single winning steer: the newest steer directed at me across the WHOLE set — resolved or not —
  // so a resolved current steer can't revive an older one it already superseded, and the bar can't
  // collapse onto a stale steer just because the newest was filtered out. (With a ts-based read cursor,
  // an older steer can't be unread while a newer one is read, so unread-only input carries the true
  // newest steer here.) Ties on `ts` (two steers in the same millisecond) break on `id` — ULIDs sort
  // deterministically — so it is always *exactly one* steer, never a contradictory pair.
  let winningSteerId: string | undefined;
  let winningTs = Number.NEGATIVE_INFINITY;
  for (const m of messages) {
    if (m.from === me || m.act !== 'steer' || !actionNeeded(m)) continue;
    if (m.ts > winningTs || (m.ts === winningTs && (winningSteerId ?? '') < m.id)) {
      winningTs = m.ts;
      winningSteerId = m.id;
    }
  }
  return messages
    .filter(
      (m) =>
        m.from !== me &&
        actionNeeded(m) &&
        (isUrgent(m) || m.act === 'steer' || isObligation(m)) &&
        !resolved.has(m.thread ?? m.id) &&
        // Newest steer wins: any steer that isn't the single winner is superseded — it neither
        // interrupts nor counts (a ts tie is broken by id, so no two steers survive together).
        (m.act !== 'steer' || m.id === winningSteerId),
    )
    .sort((a, b) => b.ts - a.ts);
}

/** One act `me` has postponed, and what will bring it back (ADR 211 §1). */
export interface Deferral {
  /** the directed act being postponed */
  target: string;
  /** the deferring `wait`'s id */
  by: string;
  /** the deferring `wait`'s ts — the bar every condition is measured against */
  ts: number;
  until: DeferUntil;
}

/**
 * The deferrals `me` currently holds, latest-wins per target (ADR 211 §3).
 *
 * A deferring `wait` (`meta.defer_ref` + `meta.until`) postpones one directed act. Re-deferring is
 * appending another `wait`, so this is a pure read-side collapse — no supersede column, no
 * write-path side-effect — the same shape as the steer supersession above. A ts tie breaks on id,
 * as ULIDs sort deterministically, so the fold never depends on input order.
 *
 * Only waits authored by `me` count: deferring someone else's inbox item is not expressible here,
 * and the transport rejects it besides.
 */
export function deferrals(messages: Envelope[], me: string): Map<string, Deferral> {
  const out = new Map<string, Deferral>();
  for (const m of messages) {
    if (m.act !== 'wait' || m.from !== me) continue;
    const meta = (m.meta ?? {}) as { defer_ref?: unknown; until?: unknown };
    if (typeof meta.defer_ref !== 'string' || meta.defer_ref.trim().length === 0) continue;
    const until = DeferUntilSchema.safeParse(meta.until);
    if (!until.success) continue;
    const prev = out.get(meta.defer_ref);
    if (prev && (prev.ts > m.ts || (prev.ts === m.ts && prev.by >= m.id))) continue;
    out.set(meta.defer_ref, { target: meta.defer_ref, by: m.id, ts: m.ts, until: until.data });
  }
  return out;
}

/**
 * The deferred targets whose condition has since fired (ADR 211 §2).
 *
 * Both conditions reduce to one question — does an act exist on this subject with a ts later than
 * the deferral's? — so there is one predicate over two subjects, and no clock anywhere (ADR 179).
 *
 * `{ lane }` is deliberately LOOSE: it fires on the first lane-state act for that lane after the
 * wait, which may not be the state the deferrer wanted. Naming a target state would be more precise
 * and more to get wrong; evidence can argue for the precise form later.
 *
 * The bar is the NEWEST wait per target (whatever `deferrals` folded), so re-deferring genuinely
 * re-postpones rather than leaving a raise latched from a superseded wait. A target whose thread is
 * closed (ADR 025 `resolve`) never raises — the work it postponed is over.
 */
export function raisedDeferrals(messages: Envelope[], me: string): Set<string> {
  const held = deferrals(messages, me);
  const out = new Set<string>();
  if (held.size === 0) return out;

  const threadOf = new Map<string, string>();
  for (const m of messages) threadOf.set(m.id, m.thread ?? m.id);
  const resolved = new Set<string>();
  for (const m of messages) if (m.act === 'resolve' && m.thread) resolved.add(m.thread);

  for (const [target, d] of held) {
    const thread = threadOf.get(target) ?? target;
    if (resolved.has(thread)) continue;
    const fired = messages.some((m) => {
      if (m.ts <= d.ts) return false;
      if ('reply' in d.until) return m.from !== me && (m.thread ?? m.id) === thread;
      const laneState = (m.meta ?? {}) as { lane_state?: { lane?: unknown } };
      return laneState.lane_state?.lane === d.until.lane;
    });
    if (fired) out.add(target);
  }
  return out;
}

/** A deferral this old that has not raised is the ADR 211 loss mode — surfaced, never actuated. */
export const LONG_DEFERRED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The deferrals that have gone quiet (ADR 211 Failure mode): older than the threshold and still not
 * raised. An act deferred until a lane that never moves again is never raised, so postponement
 * becomes a tidy way to drop work — this is the exception that makes that visible.
 *
 * Warn, never block, never auto-un-defer. The system does not get to decide on a Member's behalf
 * that their deferral has expired; it only says the condition has not fired in a long time.
 */
export function longDeferred(
  messages: Envelope[],
  me: string,
  now: number,
  thresholdMs: number = LONG_DEFERRED_MS,
): { target: string; until: 'lane' | 'reply'; deferred_ts: number; age_days: number }[] {
  const raised = raisedDeferrals(messages, me);
  const out: { target: string; until: 'lane' | 'reply'; deferred_ts: number; age_days: number }[] =
    [];
  for (const d of deferrals(messages, me).values()) {
    if (raised.has(d.target)) continue;
    const age = now - d.ts;
    if (age < thresholdMs) continue;
    out.push({
      target: d.target,
      until: 'reply' in d.until ? 'reply' : 'lane',
      deferred_ts: d.ts,
      age_days: Math.floor(age / (24 * 60 * 60 * 1000)),
    });
  }
  return out.sort((a, b) => a.deferred_ts - b.deferred_ts);
}

/**
 * The member's most recent `status_update` reduced to a roster label + when it was set.
 * The label is `meta.state` (the SPEC field) or, if absent, the message body. Returns null
 * if the member has never posted a status_update with any label text.
 */
export function latestStatusUpdate(
  db: Database,
  memberId: string,
): { state: string; ts: number } | null {
  const row = db
    .prepare<
      [string],
      { body: string; meta: string | null; ts: number }
    >("SELECT body, meta, ts FROM messages WHERE from_member = ? AND act = 'status_update' ORDER BY ts DESC, id DESC LIMIT 1")
    .get(memberId);
  if (!row) return null;
  const metaState = row.meta
    ? (JSON.parse(row.meta) as Record<string, unknown>)['state']
    : undefined;
  const state = (typeof metaState === 'string' && metaState.trim() ? metaState : row.body).trim();
  return state ? { state, ts: row.ts } : null;
}

export interface TeamMessagesOpts {
  since?: number;
  limit?: number;
  /**
   * Recipient-scoping (need-to-know): when set, restrict the timeline to envelopes this member is a
   * party to — sender, recipient, or a team/broadcast act. Admin-visibility callers omit it and read
   * the whole team timeline. Closes the DM-leak gap where any seat's `GET /messages` returned every
   * directed envelope (ADR 061 follow-up).
   */
  forMemberId?: string;
}

/**
 * The whole team timeline — every persisted envelope, regardless of recipient — for the firehose's
 * history backfill (`GET /teams/:slug/messages`, ADR 061). Always returned in ascending (`ts, id`)
 * display order; `limit` caps the page (default 200). The two modes differ only in *which* window the
 * cap keeps:
 *
 * - **No `since` (initial backfill):** the most RECENT `limit` messages. This is what every live view
 *   wants — you open `/live` (or `musterd inbox`) to see what just happened, not the team's first 200
 *   messages ever. (The prior `ORDER BY ts ASC LIMIT` kept the OLDEST `limit` and silently dropped the
 *   newest on any over-cap history, so a busy team's backfill missed exactly the acts it came for —
 *   they only trickled in over the live socket. ADR 107 verification surfaced this.)
 * - **`since` (forward catch-up):** the oldest `limit` messages strictly after `since` (by ts), so a
 *   caller holding a cursor can page forward without skipping the gap. `since` is exclusive.
 */
export function listTeamMessages(
  db: Database,
  teamId: string,
  opts: TeamMessagesOpts = {},
): MessageRow[] {
  const limit = opts.limit ?? 200;
  // Need-to-know scope: a party is the sender, the recipient, or anyone (a team/broadcast act).
  const scopeSql = opts.forMemberId
    ? " AND (from_member = ? OR to_member = ? OR to_kind IN ('team','broadcast'))"
    : '';
  const scopeParams = opts.forMemberId ? [opts.forMemberId, opts.forMemberId] : [];
  if (typeof opts.since === 'number') {
    // Forward catch-up: walk forward from the cursor, oldest-first, so no message in the gap is skipped.
    return db
      .prepare<
        unknown[],
        MessageRow
      >(`SELECT * FROM messages WHERE team_id = ? AND ts > ?${scopeSql} ORDER BY ts ASC, id ASC LIMIT ?`)
      .all(teamId, opts.since, ...scopeParams, limit);
  }
  // Initial backfill: take the newest `limit` (DESC + LIMIT), then re-sort ascending for display.
  return db
    .prepare<
      unknown[],
      MessageRow
    >(`SELECT * FROM (SELECT * FROM messages WHERE team_id = ?${scopeSql} ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts ASC, id ASC`)
    .all(teamId, ...scopeParams, limit);
}

/** Convert a stored row back to a protocol Envelope (for delivery/inbox responses). */
export function rowToEnvelope(
  row: MessageRow,
  teamSlug: string,
  fromName: string,
  toName: string | null,
): Envelope {
  const to =
    row.to_kind === 'member'
      ? { kind: 'member' as const, name: toName ?? '' }
      : row.to_kind === 'team'
        ? { kind: 'team' as const }
        : { kind: 'broadcast' as const };
  return {
    id: row.id,
    v: PROTOCOL_VERSION,
    team: teamSlug,
    from: fromName,
    to,
    act: row.act as Envelope['act'],
    body: row.body,
    thread: row.thread_id,
    meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null,
    ts: row.ts,
  };
}
