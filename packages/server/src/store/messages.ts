import { hostname } from 'node:os';
import {
  DeferUntilSchema,
  eligibleOf,
  PROTOCOL_VERSION,
  type DeferUntil,
  type Envelope,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
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

/**
 * This team's local node row (ADR 331 §Decision 1) — per (daemon, team), minted by migration v47
 * and lazily here for teams created after it.
 *
 * The `local_node` marker is the authority (v48, increment 3a), not `ORDER BY id LIMIT 1` as this
 * read once was. That ordering was correct only while enrollment did not exist and `nodes` held one
 * row per team; enrollment is exactly what adds remote rows, and one whose ULID sorted lower would
 * have taken over our stamp — holing our own sequence while writing numbers into a remote node's
 * that name events it never sent. Two sequences corrupted at once, which is the ambiguity between
 * loss and silence that ADR 331 exists to prevent.
 */
export function localNodeForTeam(db: Database, teamId: string): { id: string } {
  const marked = db
    .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
    .get(teamId);
  if (marked) return { id: marked.node_id };

  const id = ulid();
  db.prepare('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)').run(
    id,
    teamId,
    hostname(),
  );
  // Both writes or neither: `insertMessage` already holds the transaction, so a row minted without
  // its marker cannot survive to be re-minted on the next send.
  db.prepare('INSERT INTO local_node (team_id, node_id) VALUES (?, ?)').run(teamId, id);
  return { id };
}

/**
 * Insert an envelope into the append-only log. `toMemberId` set iff to.kind==='member'.
 *
 * Stamps `(origin_node, origin_seq)` (ADR 331): SERVER-derived like `from_provenance` — there is no
 * wire field, so a caller cannot supply an origin. Opens its own transaction (a SAVEPOINT when the
 * caller already holds one): the seq allocation and the insert are one atomic unit, so a throw
 * between them — a replayed envelope id's UNIQUE violation is the realistic one — burns no number
 * and leaves no hole.
 */
export function insertMessage(
  db: Database,
  teamId: string,
  fromMemberId: string,
  toMemberId: string | null,
  env: Envelope,
  /**
   * `now` is the receipt clock the row is stamped with (`created_at`) — the position every read
   * cursor walks. Injected for the same reason `slowestInboxLagMs(db, now)` is: a fixture that
   * needs two rows in one millisecond, or one that arrives an hour after it was stamped, cannot
   * get either from a wall clock. Production callers leave it unset.
   */
  opts: { now?: number } = {},
): MessageRow {
  return db.transaction((): MessageRow => {
    const node = localNodeForTeam(db, teamId);
    // Read-then-bump under SQLite's single-writer lock: `next_seq` names the next value to assign,
    // so the returned pre-increment value is this message's seq — monotone and gapless by construction.
    const seq = db
      .prepare<
        [string],
        { seq: number }
      >('UPDATE nodes SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq - 1 AS seq')
      .get(node.id)!.seq;
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
      origin_node: node.id,
      origin_seq: seq,
      ts: env.ts,
      created_at: opts.now ?? Date.now(),
    };
    db.prepare(
      `INSERT INTO messages
         (id, team_id, from_member, to_kind, to_member, act, body, thread_id, meta, from_provenance, origin_node, origin_seq, ts, created_at)
       VALUES
         (@id, @team_id, @from_member, @to_kind, @to_member, @act, @body, @thread_id, @meta, @from_provenance, @origin_node, @origin_seq, @ts, @created_at)`,
    ).run(row);
    return row;
  })();
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

/**
 * Every position in here is in RECEIPT order — `messages.created_at`, this daemon's clock at insert
 * or fold — never the envelope's `ts`, which is the origin's clock and travels (ADR 335). A cursor
 * keyed on `ts` never showed an event that arrived after the seat last read but was stamped before
 * it (the ts-cursor defect, lane 01M1FAYTHQA881M35PDPXRTGM1). `cursorTs` and `since` are both
 * `created_at` values; the CLI pages with the envelope's `received_at`, which is this column.
 */
export interface InboxOpts {
  since?: number;
  unreadOnly?: boolean;
  cursorTs?: number;
  /**
   * The cursor row's id — the TIEBREAK this query already orders by, finally expressed in the
   * position that walks it. A read cursor is a `(created_at, id)` point, not a ts: two messages can share a
   * millisecond (musterd fan-out sends land sub-millisecond apart), and `created_at > cursorTs` drops the
   * one that ties. Not "shown late" — never shown, because the cursor only moves forward.
   * Omitted ⇒ the ts-only floor, which is correct whenever nothing ties.
   */
  cursorId?: string | null;
  /** The newest `limit` — the recent tail, for a caller that asked to see the latest few. */
  limit?: number;
  /**
   * The OLDEST `headLimit` — a PREFIX of the unbounded read, for bounding a response the caller did
   * not ask to have bounded.
   *
   * The distinction is load-bearing, which is why this is a separate option and not a flag on
   * `limit`. Truncating to the newest n and then letting the reader advance its cursor to the newest
   * row it received steps over everything that was cut — ADR 287's loss, arrived at from the other
   * direction. A prefix cannot do that: advancing to the last row seen leaves the remainder unread,
   * and catching up takes several reads and reaches every message in order.
   */
  headLimit?: number;
}

/**
 * A member's inbox: messages in their team addressed to them or to team/broadcast,
 * excluding their own sends. unreadOnly filters by the caller-supplied cursor position (receipt order).
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
    // Both floors apply when both are given: `cursorTs` is what the seat has already read, `since` is
    // how far a paging caller has walked. They are applied SEPARATELY rather than as `max(...)`,
    // because only one of them carries a tiebreak: the cursor is a `(created_at, id)` point and compares
    // as one, while `since` is a plain created_at and stays strict. Collapsing them to a single number is what
    // made the tied row unreachable — `max()` cannot express half a comparison. With no ties the two
    // forms select exactly the same rows.
    const cursorTs = opts.cursorTs ?? 0;
    if (opts.cursorId) {
      where += ' AND (created_at > ? OR (created_at = ? AND id > ?))';
      params.push(cursorTs, cursorTs, opts.cursorId);
    } else {
      where += ' AND created_at > ?';
      params.push(cursorTs);
    }
    if (typeof opts.since === 'number') {
      where += ' AND created_at > ?';
      params.push(opts.since);
    }
  } else if (typeof opts.since === 'number') {
    where += ' AND created_at > ?';
    params.push(opts.since);
  }
  // With a limit, take the NEWEST `limit` (DESC + LIMIT) then re-sort ascending for display — an
  // inbox is read most-recent-first, so a bounded view must keep the recent tail, not the oldest N
  // (the `ts ASC LIMIT` bug that returned the wrong end; mirrors listTeamMessages' backfill).
  if (opts.limit) {
    const newest = db
      .prepare<
        unknown[],
        MessageRow
      >(`SELECT * FROM (SELECT * FROM messages ${where} ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at ASC, id ASC`)
      .all(...params, opts.limit);
    // MCP always sends `limit`, so the newest tail is team broadcasts and an old waiting handoff
    // never appears. The CLI banner reads with no limit and counts it. Pin action-needed unread
    // (request_help / ask / directed non-message) into the page. Directed `message` stays newest-N
    // so a mailbox of DMs does not explode the bound.
    if (!opts.unreadOnly) return newest;
    const pinned = db
      .prepare<unknown[], MessageRow>(
        `SELECT * FROM messages ${where} AND (
           act IN ('request_help', 'ask')
           OR (to_kind = 'member' AND act NOT IN ('message', 'resolve'))
         ) ORDER BY created_at ASC, id ASC`,
      )
      .all(...params);
    if (pinned.length === 0) return newest;
    const byId = new Map<string, MessageRow>();
    for (const row of newest) byId.set(row.id, row);
    for (const row of pinned) byId.set(row.id, row);
    return [...byId.values()].sort(
      (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
  // The prefix read: same order as the unbounded query, simply stopped early — except that it never
  // stops in the MIDDLE OF A TIE. A page cut between two rows sharing a millisecond cannot be walked
  // by a plain cursor: the next request asks for `created_at > last` and excludes every tied row, so
  // the remainder is stranded and the empty page reads as "caught up" (izzo's repro: 220 messages,
  // page one 200, page two 0, silently reaching 200). Completing the group instead of splitting it
  // makes `> last` exact again for EVERY caller — including one on an older client that has no way to
  // send a tiebreak — rather than adding a cursor field the lossy spelling still sits next to.
  //
  // The overshoot is the size of one tie group, so the bound is "about `headLimit`" rather than
  // exactly it. That is the deliberate trade: a response slightly over budget, or a silent
  // permanent hole in someone's history.
  if (opts.headLimit) {
    const head = db
      .prepare<
        unknown[],
        MessageRow
      >(`SELECT * FROM messages ${where} ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(...params, opts.headLimit);
    if (head.length < opts.headLimit) return head;
    const last = head[head.length - 1]!;
    const tied = db
      .prepare<
        unknown[],
        MessageRow
      >(`SELECT * FROM messages ${where} AND created_at = ? AND id > ? ORDER BY id ASC`)
      .all(...params, last.created_at, last.id);
    return tied.length > 0 ? [...head, ...tied] : head;
  }
  return db
    .prepare<
      unknown[],
      MessageRow
    >(`SELECT * FROM messages ${where} ORDER BY created_at ASC, id ASC`)
    .all(...params);
}

/**
 * Total size of a member's inbox view (same visibility rule as {@link listInbox}, no cursor/limit) —
 * the denominator behind the CLI's "showing N of TOTAL" footer, so a bounded default can honestly say
 * how much history it elided. Cheap COUNT; unread is derived client-side from the cursor.
 */
/** Unread count by the caller-supplied cursor — what a bounded read needs in order to say how much
 *  it could not carry. Counting is not marshalling: this stays cheap on a deep backlog. */
export function countUnread(
  db: Database,
  member: { id: string; team_id: string },
  cursorTs: number,
  /** The cursor row's id — same `(created_at, id)` comparison {@link listInbox} makes, so the count and the
   *  listing can never disagree about a tied row. Without it this returns 0 while one still waits. */
  cursorId?: string | null,
): number {
  if (cursorId) {
    const row = db
      .prepare<[string, string, string, number, number, string], { n: number }>(
        `SELECT COUNT(*) AS n FROM messages
          WHERE team_id = ?
            AND (to_member = ? OR to_kind IN ('team','broadcast'))
            AND from_member != ?
            AND (created_at > ? OR (created_at = ? AND id > ?))`,
      )
      .get(member.team_id, member.id, member.id, cursorTs, cursorTs, cursorId);
    return row?.n ?? 0;
  }
  const row = db
    .prepare<[string, string, string, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM messages
        WHERE team_id = ?
          AND (to_member = ? OR to_kind IN ('team','broadcast'))
          AND from_member != ?
          AND created_at > ?`,
    )
    .get(member.team_id, member.id, member.id, cursorTs);
  return row?.n ?? 0;
}

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
  opts: { obligations?: boolean; huddles?: boolean } = {},
): Envelope[] {
  const resolved = new Set<string>();
  // ADR 254: an eligible-set act is discharged by the FIRST accept/decline naming it — for every
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
  // ADR 378: a turn in a huddle I am IN rings the bell, so a live participant hears it at its next
  // tool boundary instead of at its next inbox check. Without this a huddle is asynchronous by
  // omission — delivery was already real-time (the ADR 061 firehose), only the bell was missing.
  //
  // Live rail only, like `obligations` and for ADR 225's reason: this predicate also picks PAID
  // wakes (`claimWakeLeases`), and raising every turn there would summon every offline participant
  // on every turn — precisely the token storm ADR 378 set out to avoid. Two flags now say
  // "live-only"; a third should collapse them into one.
  //
  // Who counts as in it: a NAMED participant (an eligible set, or a directed root) is in from the
  // root act. A `@team` huddle is an open invitation rather than a summons, so a seat joins by
  // taking a turn — otherwise one team-addressed huddle interrupts every seat on the roster, every
  // turn. Closed huddles go quiet for free: the root's id is in `resolved` once its `resolve` lands.
  // Maps each open huddle I am in to the moment I last spoke in it — `-Infinity` when I have not
  // spoken yet, so a named participant hears everything since the root. Only turns NEWER than that
  // ring: what was said before I joined is backlog I read on the way in, and the interrupt line is
  // for what needs me now, not for a transcript.
  const myOpenHuddles = new Map<string, { ts: number; id: string }>();
  if (opts.huddles === true) {
    for (const root of messages) {
      if ((root.meta as { huddle?: unknown } | null | undefined)?.['huddle'] == null) continue;
      if (resolved.has(root.id)) continue;
      const named = eligibleOf(root.meta as Record<string, unknown> | null | undefined);
      const inFromTheRoot = named
        ? named.includes(me)
        : root.to.kind === 'member' && root.to.name === me;
      // Ties on `ts` break on id, the same convention the steer scan below uses: ULIDs sort
      // deterministically, so two turns in one millisecond still have one order everybody agrees on.
      let spoke = { ts: Number.NEGATIVE_INFINITY, id: '' };
      for (const t of messages) {
        if (t.thread !== root.id || t.from !== me) continue;
        if (t.ts > spoke.ts || (t.ts === spoke.ts && t.id > spoke.id))
          spoke = { ts: t.ts, id: t.id };
      }
      const joined = spoke.ts > Number.NEGATIVE_INFINITY;
      if (inFromTheRoot || joined || root.from === me) myOpenHuddles.set(root.id, spoke);
    }
  }
  const isHuddleTurn = (m: Envelope) => {
    if (m.thread == null) return false;
    const since = myOpenHuddles.get(m.thread);
    if (since === undefined) return false;
    return m.ts > since.ts || (m.ts === since.ts && m.id > since.id);
  };
  // ADR 254: an eligible set REPLACES the default obligation rule rather than adding to it — which is
  // what narrows `request_help` from "every seat on the team" (its behaviour without a set, below) to
  // the named few. Discharge is checked here rather than at the filter so a stood-down act stops
  // being action-needed *everywhere* at once, including in the `steer` winner scan.
  const actionNeeded = (m: Envelope) => {
    if (m.act === 'resolve') return false;
    // A huddle turn is addressed to the room, not to me — the default rule below would reject it
    // before its class was ever considered. Being in the huddle IS the address (ADR 378).
    if (isHuddleTurn(m)) return true;
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
        (isUrgent(m) || m.act === 'steer' || isObligation(m) || isHuddleTurn(m)) &&
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
    received_at: row.created_at,
  };
}
