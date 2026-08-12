import {
  eligibleOf,
  isAwaitingAcceptance,
  LANE_TERMINAL_STATES,
  normalizeSeatName,
  type ActDelivery,
  type DeliveryRecipient,
  type LaneState,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { getCursor } from './cursors.js';
import type { MessageRow } from './rows.js';

/**
 * The per-recipient delivery ledger (ADR 090) — `logged → seen → answered`, **derived** from the
 * message log + inbox cursors + the interrupt audit, never stored. `logged` is implicit (the row
 * exists; durability IS delivery, so there is no local `failed`); `seen` is the recipient's cursor
 * watermark crossing the act (exact as a boolean, watermark-precise as a timestamp); `answered` is
 * the same predicate `countOpenLoops`/`recordLoopClosure` use (an accept/decline naming the act via
 * `meta.in_reply_to`, or a resolve on its thread). Pure reads, the `countOpenLoops` pattern.
 */

interface RecipientRow {
  id: string;
  name: string;
}

/** Whom a persisted act addresses. For team/broadcast this is the *current* non-observer roster
 * minus the sender — membership that changed since the send is approximated by the roster of now
 * (the log stores no fan-out list; ADR 090 accepts and labels this). */
function recipientsOf(db: Database, msg: MessageRow): RecipientRow[] {
  if (msg.to_kind === 'member') {
    if (!msg.to_member) return [];
    const row = db
      .prepare<[string], RecipientRow>('SELECT id, name FROM members WHERE id = ?')
      .get(msg.to_member);
    return row ? [row] : [];
  }
  // ADR 254: an eligible set narrows OBLIGATION, not visibility. The act is team-addressed and every
  // seat can read it — but only the named seats owe an answer, and this ledger tracks what is owed.
  //
  // Note this branch is strictly MORE precise than the roster query below: the names are pinned in
  // the envelope, so a seat that has since left is still visibly the one who was asked. There is
  // deliberately no `left_at IS NULL` filter here — dropping a departed seat would rewrite history
  // into "we never asked them", which is the approximation the team branch is stuck with, not one to
  // reproduce where the log actually knows better.
  const eligible = eligibleOf(metaOf(msg));
  if (eligible) {
    const stmt = db.prepare<[string, string], RecipientRow>(
      'SELECT id, name FROM members WHERE team_id = ? AND name = ?',
    );
    return eligible.flatMap((name) => {
      const row = stmt.get(msg.team_id, name);
      return row ? [row] : [];
    });
  }
  return db
    .prepare<
      [string, string],
      RecipientRow
    >('SELECT id, name FROM members WHERE team_id = ? AND left_at IS NULL AND observer = 0 AND id != ?')
    .all(msg.team_id, msg.from_member);
}

/** An act's decoded `meta`, or null when absent/corrupt. */
function metaOf(msg: MessageRow): Record<string, unknown> | null {
  if (!msg.meta) return null;
  try {
    return JSON.parse(msg.meta) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isUrgent(msg: MessageRow): boolean {
  return metaOf(msg)?.['urgent'] === true;
}

/** The resolve that closed this act's thread (thread_key = thread_id ?? id), if any. */
function threadResolve(
  db: Database,
  msg: MessageRow,
): { act: string; id: string; ts: number } | null {
  const threadKey = msg.thread_id ?? msg.id;
  const row = db
    .prepare<
      [string, string],
      { id: string; ts: number }
    >(`SELECT id, ts FROM messages WHERE team_id = ? AND act = 'resolve' AND thread_id = ? ORDER BY ts ASC LIMIT 1`)
    .get(msg.team_id, threadKey);
  return row ? { act: 'resolve', id: row.id, ts: row.ts } : null;
}

/**
 * ADR 254: ANY seat's accept/decline naming the act — the any-of discharge an eligible set promises.
 *
 * This clause has to exist, and the reason is worth recording because the design assumed it away:
 * `answerBy` below is scoped to a single recipient (`from_member = recipientId`), which is exactly
 * right for a directed act and exactly wrong for "either of you". Without this, bob answering would
 * leave Ada owing the act forever, and the ledger — the instrument that decides what is still open —
 * would contradict the primitive's whole promise.
 *
 * Applied ONLY when the act carries an eligible set. A plain team act keeps per-recipient answering,
 * because there "someone replied" genuinely does not mean everyone else is off the hook.
 */
function anyAnswer(db: Database, msg: MessageRow): { act: string; id: string; ts: number } | null {
  const row = db
    .prepare<[string, string], { act: string; id: string; ts: number }>(
      `SELECT act, id, ts FROM messages
        WHERE team_id = ? AND act IN ('accept','decline')
          AND json_extract(meta, '$.in_reply_to') = ?
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(msg.team_id, msg.id);
  return row ?? null;
}

/** This recipient's accept/decline naming the act via `meta.in_reply_to`, if any. */
function answerBy(
  db: Database,
  msg: MessageRow,
  recipientId: string,
): { act: string; id: string; ts: number } | null {
  const row = db
    .prepare<[string, string, string], { act: string; id: string; ts: number }>(
      `SELECT act, id, ts FROM messages
        WHERE team_id = ? AND from_member = ? AND act IN ('accept','decline')
          AND json_extract(meta, '$.in_reply_to') = ?
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(msg.team_id, recipientId, msg.id);
  return row ?? null;
}

/**
 * A handoff is discharged by DOING THE WORK, and that is invisible to the two reply-shaped clauses
 * above. This is the third clause: the lane a `lane_handoff` names has left the recipient's plate.
 *
 * WHY IT HAD TO EXIST, measured on the live ledger 2026-08-06. miley handed ryder lane
 * `01KZ9W0R29`; he diagnosed it, shipped ADR 246 (#716/#722) and submitted at 18:19:57. No `accept`
 * ever named the handoff and no `resolve` ever landed on its thread — because that is not how anyone
 * discharges a handoff. So the wake-candidate query never learned the work was done and kept
 * spawning sessions three hours later. Her ONE handoff was TWO envelopes and the attempt cap keys
 * per act, so it bought six wakes for already-merged work, entirely within policy.
 *
 * DERIVED, NEVER STORED — the same posture as the rest of this file, and here it buys a property a
 * stored flag could not: if acceptance REJECTS the lane it returns to an active state and the
 * handoff becomes owed again on the next read, with nothing to un-set.
 *
 * Deliberately narrow. Only a handoff that NAMES a lane, and only when that lane currently exists
 * and is out of play: submitted for acceptance (either ADR 169/192 spelling) or terminal. A bare
 * handoff, or one naming a lane that no longer exists, keeps its old behaviour rather than silently
 * going quiet — a wake that should not have fired is expensive, but a handoff that stops asking is
 * work dropped on the floor, and only one of those is recoverable.
 *
 * Exported so every reader of a handoff-as-live-instruction (wake candidacy, orientation `why`)
 * uses the same out-of-play test. A second copy in `orientation.ts` is how the `why` kept serving
 * discharged work after this clause landed for wakes (#745).
 */
export function handoffNamedLaneOutOfPlay(
  db: Database,
  teamId: string,
  meta: string | null,
  body?: string | null,
): boolean {
  const lane = namedHandoffLane(db, teamId, meta);
  if (lane) return laneOutOfPlay(lane.state);
  // No structured lane. ADR 231 (#662) made every handoff carry one, but the 24 that predate it
  // never will, and a bare handoff is always "in play" — so the newest one wins the `why` slot
  // PERMANENTLY, outranking every structured handoff older than it, with no event able to retire
  // it. Measured 2026-08-12: 34 handoffs, 24 bare, 7 naming their lane in the body, the oldest
  // still served as a live instruction 16 days after its lane shipped.
  //
  // A lane id in prose is not prose: it resolves to a lane row or it does not. What keeps this on
  // the right side of "only a recorded fact earns a label" is that nothing here reads MEANING —
  // an identifier is matched, and an ambiguous or unresolvable one abstains.
  return bodyNamedLanesAllOutOfPlay(db, teamId, body);
}

function laneOutOfPlay(state: string): boolean {
  return isAwaitingAcceptance(state) || LANE_TERMINAL_STATES.has(state as LaneState);
}

/**
 * Lane ids as they appear in prose: rendered TRUNCATED (`01KYJ8B5AB` for the full 26-char ULID), so
 * this matches a Crockford-base32 ULID prefix of at least 10 characters. Below that a prefix stops
 * being distinguishing; `I`, `L`, `O` and `U` are outside the alphabet.
 */
const LANE_ID_IN_PROSE = /\b01[0-9A-HJKMNP-TV-Z]{8,24}\b/g;

/**
 * True only when the body names at least one lane and EVERY lane it names has left play.
 *
 * All-or-nothing on purpose. Real handoffs name more than one lane — the one being handed off and a
 * lane it overlaps or supersedes (the measured example named both its subject and a surface-overlap
 * neighbour). Discharging on "some named lane is done" would silence a live handoff because it
 * mentioned a finished one in passing, and this file's own rule is that a wake which should not have
 * fired is expensive while a handoff that stops asking is work dropped on the floor — only one of
 * those is recoverable. So any still-live mention keeps the whole handoff showing.
 */
function bodyNamedLanesAllOutOfPlay(db: Database, teamId: string, body?: string | null): boolean {
  if (!body) return false;
  const prefixes = [...new Set(body.match(LANE_ID_IN_PROSE) ?? [])];
  if (prefixes.length === 0) return false;
  let resolved = 0;
  for (const prefix of prefixes) {
    // An ambiguous prefix picked out no single lane, so it is not evidence about any of them.
    // LIMIT 2 is enough to tell "exactly one" from "more than one" without scanning the rest.
    const matches = db
      .prepare<
        [string, string],
        { state: string }
      >("SELECT state FROM lanes WHERE team_id = ? AND id LIKE ? || '%' LIMIT 2")
      .all(teamId, prefix);
    if (matches.length !== 1) continue;
    if (!laneOutOfPlay(matches[0]!.state)) return false;
    resolved++;
  }
  return resolved > 0;
}

function namedHandoffLane(
  db: Database,
  teamId: string,
  meta: string | null,
): { id: string; state: string; updated_at: number } | null {
  if (!meta) return null;
  let laneId: unknown;
  try {
    const parsed = JSON.parse(meta) as { lane_handoff?: { lane?: unknown } };
    laneId = parsed.lane_handoff?.lane;
  } catch {
    return null; // unparseable meta is not evidence of discharge
  }
  if (typeof laneId !== 'string' || laneId === '') return null;
  const lane = db
    .prepare<
      [string, string],
      { id: string; state: string; updated_at: number }
    >('SELECT id, state, updated_at FROM lanes WHERE team_id = ? AND id = ?')
    .get(teamId, laneId);
  return lane ?? null;
}

function laneHandoffDischarged(
  db: Database,
  msg: MessageRow,
): { act: string; id: string; ts: number } | null {
  if (msg.act !== 'handoff') return null;
  const lane = namedHandoffLane(db, msg.team_id, msg.meta);
  if (!lane) return null;
  if (!isAwaitingAcceptance(lane.state) && !LANE_TERMINAL_STATES.has(lane.state as LaneState)) {
    return null;
  }
  // `id` names the LANE, not a message: this closure has no envelope of its own, and pointing at a
  // real lane is more useful to a reader of the ledger than a synthetic message id would be.
  return { act: `lane:${lane.state}`, id: lane.id, ts: lane.updated_at };
}

/**
 * Has this recipient ANSWERED the act, by the ledger's own definition — an accept/decline naming
 * it via `meta.in_reply_to`, or a `resolve` closing its thread? Exported for the wake metrics
 * (ADR 131 O&E: "woken acts that reach `answered` in the ADR 090 ledger"), so the report reads
 * the LIVE ledger state rather than the host's report-time snapshot.
 */
export function actAnswered(
  db: Database,
  msg: MessageRow,
  recipientId: string,
): { act: string; id: string; ts: number } | null {
  return answerBy(db, msg, recipientId) ?? threadResolve(db, msg) ?? laneHandoffDischarged(db, msg);
}

/** ADR 088 interrupt raises recorded for this (act, recipient) — the attempt history. */
function interruptRaises(db: Database, msg: MessageRow, recipientName: string): number {
  const row = db
    .prepare<[string, string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action = 'interrupt.raised' AND target = ?
          AND json_extract(detail, '$.act') = ?`,
    )
    .get(msg.team_id, recipientName, msg.id);
  return row?.n ?? 0;
}

/** ADR 167 delivery-rail relays confirmed for this act — the exact `interruptRaises` pattern: an
 *  attempt is an audit row (`actor.session_message` whose `nudge_ref` names the act), the ledger
 *  projects it. The nudge row carries no recipient of its own (only the sender is authenticated),
 *  but a `nudge_ref` resolves through the act, whose recipient is fixed — so the count is per-act,
 *  landing on its one directed recipient. `verbatim` counts the fingerprint-matched subset. */
function ccdNudges(db: Database, msg: MessageRow): { total: number; verbatim: number } {
  const row = db
    .prepare<[string, string], { total: number; verbatim: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(json_extract(detail, '$.verbatim') = 1), 0) AS verbatim
         FROM audit
        WHERE team_id = ? AND action = 'actor.session_message'
          AND json_extract(detail, '$.nudge_ref') = ?`,
    )
    .get(msg.team_id, msg.id);
  return { total: row?.total ?? 0, verbatim: row?.verbatim ?? 0 };
}

function recipientLedger(
  db: Database,
  msg: MessageRow,
  recipient: RecipientRow,
  resolve: { act: string; id: string; ts: number } | null,
): DeliveryRecipient {
  // ADR 254: on an eligible-set act the FIRST answer from anyone discharges it for every named seat
  // (`anyAnswer`); everywhere else the per-recipient clause stands unchanged.
  const ownAnswer = eligibleOf(metaOf(msg)) ? anyAnswer(db, msg) : answerBy(db, msg, recipient.id);
  const answered = ownAnswer ?? resolve ?? laneHandoffDischarged(db, msg);
  const cursor = getCursor(db, recipient.id);
  const seen = cursor.last_read_ts >= msg.ts;
  const nudges = ccdNudges(db, msg);
  return {
    seat: recipient.name,
    seat_id: normalizeSeatName(recipient.name),
    state: answered ? 'answered' : seen ? 'seen' : 'logged',
    seen_by: seen ? cursor.updated_at : null,
    answered,
    interrupt_raises: interruptRaises(db, msg, recipient.name),
    ccd_nudges: nudges.total,
    ccd_nudges_verbatim: nudges.verbatim,
  };
}

function actDeliveryOf(db: Database, msg: MessageRow, now: number): ActDelivery {
  const resolve = threadResolve(db, msg);
  const from = db
    .prepare<[string], { name: string }>('SELECT name FROM members WHERE id = ?')
    .get(msg.from_member);
  return {
    id: msg.id,
    act: msg.act,
    from: from?.name ?? '?',
    to_kind: msg.to_kind as ActDelivery['to_kind'],
    thread: msg.thread_id,
    ts: msg.ts,
    age_ms: Math.max(0, now - msg.ts),
    urgent: isUrgent(msg),
    recipients: recipientsOf(db, msg).map((r) => recipientLedger(db, msg, r, resolve)),
  };
}

/**
 * The acts a cursor advance from `fromTs` (exclusive) to `toTs` (inclusive) newly marks seen, for
 * the `musterd.coordination.seen_latency` emission (ADR 090). Scope matches the ledger, not the
 * whole team firehose: acts directed at me, plus team/broadcast **loop-opening** acts
 * (request_help/handoff — their `to_member` is NULL, so a `to_member = me` filter alone silently
 * skips them; bugbot on #114). Never my own sends.
 */
export function crossedBySeen(
  db: Database,
  teamId: string,
  memberId: string,
  fromTs: number,
  toTs: number,
): { act: string; urgent: boolean; ts: number }[] {
  const rows = db
    .prepare<[string, number, number, string, string], MessageRow>(
      `SELECT * FROM messages
        WHERE team_id = ? AND ts > ? AND ts <= ?
          AND (to_member = ?
               OR (to_kind IN ('team','broadcast') AND act IN ('request_help','handoff')))
          AND from_member != ?`,
    )
    .all(teamId, fromTs, toTs, memberId, memberId);
  return rows.map((m) => ({ act: m.act, urgent: isUrgent(m), ts: m.ts }));
}

/** The per-act ledger: one act's journey across every recipient. Null for an unknown id. */
export function actDelivery(
  db: Database,
  teamId: string,
  messageId: string,
  now: number = Date.now(),
): ActDelivery | null {
  const msg = db
    .prepare<[string, string], MessageRow>('SELECT * FROM messages WHERE team_id = ? AND id = ?')
    .get(teamId, messageId);
  return msg ? actDeliveryOf(db, msg, now) : null;
}

/**
 * The open directed ledger (ADR 090 §2): every loop-opening act — `request_help`/`handoff`, plus
 * urgent-flagged directed acts — not yet answered by an accept/decline naming it or a resolve on
 * its thread. This is the `open_loops` gauge made answerable (which act, whose inbox, seen or
 * ignored), and the two derivations must reconcile (the ADR's no-drift guard). Oldest first.
 */
export function openDirectedLedger(
  db: Database,
  teamId: string,
  now: number = Date.now(),
): ActDelivery[] {
  const rows = db
    .prepare<[string], MessageRow>(
      `SELECT m.* FROM messages m
        WHERE m.team_id = ?
          AND (m.act IN ('request_help','handoff')
               OR (m.to_kind = 'member' AND json_extract(m.meta, '$.urgent') = 1))
          AND m.act NOT IN ('accept','decline','resolve')
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id AND r.act IN ('accept','decline')
               AND json_extract(r.meta, '$.in_reply_to') = m.id)
          AND NOT EXISTS (
            SELECT 1 FROM messages v
             WHERE v.team_id = m.team_id AND v.act = 'resolve'
               AND v.thread_id = COALESCE(m.thread_id, m.id))
        ORDER BY m.ts ASC`,
    )
    .all(teamId);
  return rows.map((m) => actDeliveryOf(db, m, now));
}
