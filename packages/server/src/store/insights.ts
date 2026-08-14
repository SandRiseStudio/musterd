import type {
  BlockedLane,
  CoordinationDensity,
  FlowMetrics,
  LongDeferred,
  Report,
  ReviewMetrics,
  SteeringMetrics,
  WaitingOnEntry,
  WakeMetrics,
  WakeSeatCost,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { actAnswered, openDirectedLedger } from './delivery.js';
import { listGoals } from './goals.js';
import { listLanes } from './lanes.js';
import { deriveMast } from './mast.js';
import { getMemberById, getMemberByName } from './members.js';
import { listTeamMessages, longDeferred, rowToEnvelope } from './messages.js';
import { effectiveWakePolicy, getResidency } from './residency.js';
import { teamFamilyPosture } from './review.js';
import type { MessageRow } from './rows.js';
import { getPolicy } from './teams.js';
import { deriveToolCallMetrics } from './toolCalls.js';

/** Matches the inbox/wake reads' bound (ADR 211 §3). */
const DEFERRAL_SCAN_LIMIT = 2000;

/**
 * The insight engine (ADR 050, server-side per ADR 084) — leadership projections over lanes + the act
 * log, computed once so CLI/MCP/dashboard render one truth. Never stores anything; Goodhart-safe
 * (measures outcomes and queues, never message volume). See `@musterd/protocol/insights`.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CONTENDING = "('claimed','active','blocked')";
const STEERING_WINDOW_DAYS = 7;
const STEERING_WINDOW_MS = STEERING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Flow metrics from the lanes table (ADR 050 Part 5 / ADR 084). Single aggregate queries. */
export function flowMetrics(db: Database, teamId: string, now: number = Date.now()): FlowMetrics {
  const throughput = db
    .prepare<
      [string, number],
      { n: number }
    >(`SELECT COUNT(*) AS n FROM lanes WHERE team_id = ? AND state = 'done' AND resolved_at > ?`)
    .get(teamId, now - WEEK_MS)!;

  const cycle = db
    .prepare<[string], { avg: number | null }>(
      `SELECT AVG(resolved_at - claimed_at) AS avg
         FROM lanes
        WHERE team_id = ? AND state = 'done' AND resolved_at IS NOT NULL AND claimed_at IS NOT NULL`,
    )
    .get(teamId)!;

  const wip = db
    .prepare<
      [string],
      { n: number; oldest: number | null }
    >(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM lanes WHERE team_id = ? AND state IN ${CONTENDING}`)
    .get(teamId)!;

  return {
    throughput_7d: throughput.n,
    cycle_time_ms: cycle.avg === null ? null : Math.round(cycle.avg),
    wip: wip.n,
    oldest_wip_age_ms: wip.oldest === null ? null : Math.max(0, now - wip.oldest),
  };
}

interface DirectedRow {
  recipient: string;
  thread_key: string;
  ts: number;
}

/**
 * The waiting-on view (ADR 050 Part 6): unresolved directed asks aggregated by the member they target,
 * oldest-first. This is `openActionNeeded` (ADR 024/025) lifted server-side and grouped by recipient —
 * a directed act (to a specific member, not `resolve`) whose thread carries no `resolve` means that
 * member still owes. request_help (to `@team`, no single owner) is intentionally excluded — this names
 * *who* is the bottleneck. Counts distinct threads, never messages (no reward for re-pinging).
 */
export function waitingOn(
  db: Database,
  teamId: string,
  now: number = Date.now(),
): WaitingOnEntry[] {
  const resolved = new Set(
    db
      .prepare<[string], { thread_id: string }>(
        `SELECT DISTINCT thread_id FROM messages WHERE team_id = ? AND act = 'resolve' AND thread_id IS NOT NULL`,
      )
      .all(teamId)
      .map((r) => r.thread_id),
  );

  // Directed, action-needy acts: to a specific member, not a resolve. thread_key = thread_id or own id.
  const rows = db
    .prepare<[string], DirectedRow>(
      `SELECT mt.name AS recipient, COALESCE(m.thread_id, m.id) AS thread_key, m.ts AS ts
         FROM messages m
         JOIN members mt ON mt.id = m.to_member
        WHERE m.team_id = ? AND m.to_kind = 'member' AND m.act != 'resolve'`,
    )
    .all(teamId);

  // Per recipient → distinct unresolved threads, with the oldest ask's ts.
  const byMember = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (resolved.has(row.thread_key)) continue;
    let threads = byMember.get(row.recipient);
    if (!threads) byMember.set(row.recipient, (threads = new Map()));
    const prev = threads.get(row.thread_key);
    if (prev === undefined || row.ts < prev) threads.set(row.thread_key, row.ts);
  }

  return [...byMember.entries()]
    .map(([member, threads]) => ({
      member,
      threads: threads.size,
      oldest_age_ms: Math.max(0, now - Math.min(...threads.values())),
    }))
    .sort((a, b) => b.oldest_age_ms - a.oldest_age_ms);
}

const COORD_WINDOW_DAYS = 7;
/** Flag only on a non-trivial sample, so a quiet team isn't scolded for three messages. */
const COORD_MIN_ACTS = 10;

/**
 * Coordination-density (the P3 dogfood signal) — over the last {@link COORD_WINDOW_DAYS} days, how much
 * of the team's traffic is broadcast `status_update` journal vs directed/threaded exchange. Flags
 * "coordination that only looks collaborative" when journal-heavy (≥50%) and exchange-light (<20%) over
 * a real sample. One grouped pass over the message log. Goodhart-safe: measures the shape, not volume.
 */
export function coordinationDensity(
  db: Database,
  teamId: string,
  now: number = Date.now(),
): CoordinationDensity {
  const since = now - COORD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const row = db
    .prepare<
      [string, number],
      { acts: number; journal: number; directed: number; threaded: number }
    >(
      `SELECT COUNT(*) AS acts,
              SUM(CASE WHEN act = 'status_update' AND to_kind IN ('team','broadcast') THEN 1 ELSE 0 END) AS journal,
              SUM(CASE WHEN to_kind = 'member' THEN 1 ELSE 0 END) AS directed,
              SUM(CASE WHEN thread_id IS NOT NULL THEN 1 ELSE 0 END) AS threaded
         FROM messages
        WHERE team_id = ? AND ts > ?`,
    )
    .get(teamId, since)!;

  const acts = row.acts;
  const journal = row.journal ?? 0;
  // directed ∪ threaded — a message counts as exchange if it's either (avoid double-counting).
  const exchange = db
    .prepare<
      [string, number],
      { n: number }
    >(`SELECT COUNT(*) AS n FROM messages WHERE team_id = ? AND ts > ? AND (to_kind = 'member' OR thread_id IS NOT NULL)`)
    .get(teamId, since)!.n;

  const journal_ratio = acts === 0 ? 0 : journal / acts;
  const exchange_ratio = acts === 0 ? 0 : exchange / acts;
  return {
    window_days: COORD_WINDOW_DAYS,
    acts,
    journal,
    directed: row.directed ?? 0,
    threaded: row.threaded ?? 0,
    journal_ratio,
    exchange_ratio,
    flag: acts >= COORD_MIN_ACTS && journal_ratio >= 0.5 && exchange_ratio < 0.2,
  };
}

interface SteerRow {
  id: string;
  recipient_id: string;
  ts: number;
}

interface ActRow {
  id: string;
  from_member: string;
  ts: number;
  in_reply_to: string | null;
}

interface WakeRow {
  id: string;
  recipient_id: string;
  subject: string;
  /** `lane_warning.with` — Goal id for stale_plan, other lane id for stale_dependency. */
  with_ref: string | null;
  ts: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/**
 * Interrupt-line arc metrics (ADR 125): steering latency, supersession-correctness, stale-work-caught.
 * Pure read over messages + lanes — the launch-demo instrument panel.
 */
export function deriveSteeringMetrics(
  db: Database,
  teamId: string,
  now: number = Date.now(),
): SteeringMetrics {
  const since = now - STEERING_WINDOW_MS;

  const steers = db
    .prepare<[string, number], SteerRow>(
      `SELECT m.id AS id, m.to_member AS recipient_id, m.ts AS ts
         FROM messages m
        WHERE m.team_id = ? AND m.act = 'steer' AND m.to_kind = 'member'
          AND m.to_member IS NOT NULL AND m.ts > ?`,
    )
    .all(teamId, since);

  const latencies: number[] = [];
  for (const s of steers) {
    // Recipient's first act strictly after the steer (ts, then id) — the acknowledgment.
    const later = db
      .prepare<[string, string, number, number, string], { ts: number }>(
        `SELECT ts FROM messages
          WHERE team_id = ? AND from_member = ?
            AND (ts > ? OR (ts = ? AND id > ?))
          ORDER BY ts ASC, id ASC LIMIT 1`,
      )
      .get(teamId, s.recipient_id, s.ts, s.ts, s.id);
    if (later) latencies.push(later.ts - s.ts);
  }

  latencies.sort((a, b) => a - b);

  // Supersession-correctness: acts whose in_reply_to names a steer already superseded at act.ts.
  const replyActs = db
    .prepare<[string, number], ActRow>(
      `SELECT m.id AS id, m.from_member AS from_member, m.ts AS ts,
              json_extract(m.meta, '$.in_reply_to') AS in_reply_to
         FROM messages m
        WHERE m.team_id = ? AND m.ts > ?
          AND json_extract(m.meta, '$.in_reply_to') IS NOT NULL`,
    )
    .all(teamId, since);

  let superseded_acts = 0;
  for (const a of replyActs) {
    if (!a.in_reply_to) continue;
    const named = db
      .prepare<
        [string, string],
        { act: string; to_member: string | null; ts: number }
      >(`SELECT act, to_member, ts FROM messages WHERE team_id = ? AND id = ?`)
      .get(teamId, a.in_reply_to);
    if (!named || named.act !== 'steer' || !named.to_member) continue;
    // A newer steer to the same recipient before this act → the named one was superseded.
    // Tie-break equal timestamps with message id (ADR 103 / pendingInterrupts: higher id wins).
    const newer = db
      .prepare<
        [string, string, string, number, number, string, number, number, string],
        { n: number }
      >(
        `SELECT COUNT(*) AS n FROM messages
          WHERE team_id = ? AND act = 'steer' AND to_member = ?
            AND id != ?
            AND (ts > ? OR (ts = ? AND id > ?))
            AND (ts < ? OR (ts = ? AND id < ?))`,
      )
      .get(
        teamId,
        named.to_member,
        a.in_reply_to,
        named.ts,
        named.ts,
        a.in_reply_to,
        a.ts,
        a.ts,
        a.id,
      );
    if ((newer?.n ?? 0) > 0) superseded_acts += 1;
  }

  const wakes = db
    .prepare<[string, number], WakeRow>(
      `SELECT m.id AS id, m.to_member AS recipient_id,
              json_extract(m.meta, '$.lane_warning.subject') AS subject,
              json_extract(m.meta, '$.lane_warning.with') AS with_ref,
              m.ts AS ts
         FROM messages m
        WHERE m.team_id = ? AND m.ts > ?
          AND json_extract(m.meta, '$.lane_warning.kind') IN ('stale_plan','stale_dependency')
          AND m.to_member IS NOT NULL
          AND json_extract(m.meta, '$.lane_warning.subject') IS NOT NULL`,
    )
    .all(teamId, since);

  let stale_caught = 0;
  for (const w of wakes) {
    const lane = db
      .prepare<
        [string, string],
        { state: string; resolved_at: number | null; goal_id: string | null }
      >(`SELECT state, resolved_at, goal_id FROM lanes WHERE team_id = ? AND id = ?`)
      .get(teamId, w.subject);
    const abandonedOrDone =
      lane !== undefined &&
      (lane.state === 'abandoned' || lane.state === 'done') &&
      lane.resolved_at !== null &&
      lane.resolved_at > w.ts;
    if (abandonedOrDone) {
      stale_caught += 1;
      continue;
    }
    // Course-change must reference the warned work (ADR 126): reply to the wake, or name the
    // lane's goal_id / the wake's `with` Goal id — not any owner chatter.
    const laneGoal = lane?.goal_id ?? null;
    const withRef = w.with_ref;
    const course = db
      .prepare<
        [
          string,
          string,
          number,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
        ],
        { n: number }
      >(
        `SELECT COUNT(*) AS n FROM messages
          WHERE team_id = ? AND from_member = ? AND ts > ?
            AND act IN ('accept','handoff','status_update','resolve')
            AND (
              json_extract(meta, '$.in_reply_to') = ?
              OR (? IS NOT NULL AND json_extract(meta, '$.goal_id') = ?)
              OR (? IS NOT NULL AND json_extract(meta, '$.goal_id') = ?)
            )`,
      )
      .get(teamId, w.recipient_id, w.ts, w.id, laneGoal, laneGoal, withRef, withRef);
    if ((course?.n ?? 0) > 0) stale_caught += 1;
  }

  return {
    window_days: STEERING_WINDOW_DAYS,
    steers: steers.length,
    acked: latencies.length,
    latency_median_ms: percentile(latencies, 0.5),
    latency_p95_ms: percentile(latencies, 0.95),
    superseded_acts,
    stale_wakes: wakes.length,
    stale_caught,
  };
}

const REVIEW_WINDOW_DAYS = 30;
const REVIEW_WINDOW_MS = REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Two-stage close metrics (ADR 169 O&E) — the review lifecycle as counts, projected here so the
 * eval is computable without an admin credential (ADR 052's reachability amendment).
 *
 * Counts only, and that is the whole privacy argument: every transition counted here is already
 * broadcast to the team as a `lane_state` act when it happens, so the aggregate discloses nothing
 * new — while the audit log keeps carrying claim refusals, grants, key rotation and policy changes
 * behind the admin boundary. The alternative (widening `GET /audit`) would have traded a
 * documentation problem for a governance one.
 *
 * A 30-day window rather than the wake ledger's 7: closes are far rarer than wakes, and the ADR's
 * own experiment is "the first month's review-catch rate".
 *
 * `routed` vs `no_candidate` is carried separately because the headline catch rate is unreadable
 * without it — a zero means "reviewers found nothing" or "no reviewer was ever eligible", and only
 * the first is a reason to call the feature decorative.
 */
export function deriveReviewMetrics(
  db: Database,
  teamId: string,
  now: number = Date.now(),
): ReviewMetrics {
  const since = now - REVIEW_WINDOW_MS;
  const rows = db
    .prepare<[string, number], { action: string; detail: string | null }>(
      `SELECT action, detail FROM audit
        WHERE team_id = ?
          AND action IN ('lane.ready_for_review','lane.closed','lane.review_sent_back')
          AND ts > ?`,
    )
    .all(teamId, since);

  const m: ReviewMetrics = {
    window_ms: REVIEW_WINDOW_MS,
    ready: 0,
    routed: 0,
    no_candidate: 0,
    acceptance_exempt: 0,
    exempt_sampled: 0,
    sent_back: 0,
    closed: {
      total: 0,
      counterpart_confirm: 0,
      review_timeout: 0,
      review_unanswered: 0,
      review_cut_short: 0,
      no_candidate: 0,
      acceptance_exempt: 0,
      human_review_missed: 0,
      human_required_unknown: 0,
      self_close: 0,
      abandoned: 0,
      legacy_unlabelled: 0,
      unknown_reason: 0,
    },
  };
  for (const r of rows) {
    let d: {
      reviewer?: string;
      no_candidate?: boolean;
      acceptance_exempt?: boolean;
      exempt_sampled?: boolean;
      reason?: string;
      human_required_unknown?: boolean;
    } = {};
    try {
      d = r.detail ? (JSON.parse(r.detail) as typeof d) : {};
    } catch {
      d = {}; // an unparseable row is not worth failing a whole report over
    }
    if (r.action === 'lane.review_sent_back') {
      m.sent_back++;
    } else if (r.action === 'lane.ready_for_review') {
      m.ready++;
      // Pre-#450 rows recorded neither field; they count as `ready` and abstain from the split
      // rather than being guessed into one side of it.
      // ADR 234 increment 2: matched FIRST and on its own counter. An exempt row carries neither
      // `reviewer` nor `no_candidate`, so without this clause it would land in the abstain bucket
      // and the report would call a designed exemption "predates routing-outcome recording" — an
      // unknown asserted about the one row that knows exactly what it did.
      if (d.acceptance_exempt === true) m.acceptance_exempt++;
      else if (typeof d.reviewer === 'string' && d.reviewer.length > 0) m.routed++;
      else if (d.no_candidate === true) m.no_candidate++;
      // Orthogonal to the split above: a sampled-in lane ROUTED, and is counted in `routed` too.
      // This is the sample size the low tier is producing, and the Eval divides by it.
      if (d.exempt_sampled === true) m.exempt_sampled++;
    } else {
      m.closed.total++;
      const reason = d.reason;
      if (reason === 'counterpart_confirm') m.closed.counterpart_confirm++;
      else if (reason === 'review_timeout') m.closed.review_timeout++;
      // ADR 217: the two halves the old label conflated — a wait the owner honoured, and one it cut
      // short. Matched explicitly, like every other recorded reason, so neither can fall to the
      // `else` and be counted as an unknown it is not.
      else if (reason === 'review_unanswered') m.closed.review_unanswered++;
      else if (reason === 'review_cut_short') m.closed.review_cut_short++;
      else if (reason === 'no_candidate') m.closed.no_candidate++;
      // ADR 234 increment 2: matched explicitly like every other recorded reason. Left to the
      // `else` it would count as `unknown_reason` — "written by a newer build, upgrade the reader" —
      // which is exactly the wrong remedy for a reason this build writes itself.
      else if (reason === 'acceptance_exempt') m.closed.acceptance_exempt++;
      // ADR 172's counter-metric needs its own bucket: without one it fell to the `else` and was
      // counted as a self-close — "never entered review" said of a lane that entered review and
      // whose required human never came, which is the opposite of what the row records.
      else if (reason === 'human_review_missed') m.closed.human_review_missed++;
      else if (reason === 'abandoned') m.closed.abandoned++;
      // `self_close` is a RECORDED reason asserting "never entered review", so it must be matched
      // explicitly. It used to be the `else`, which meant it also absorbed the two ways of not
      // knowing — and then asserted that positive claim about rows that made none.
      else if (reason === 'self_close') m.closed.self_close++;
      // Two ways to be uninformed, two remedies, therefore two names (ADR 173 clause 1): a row that
      // recorded no reason is the legacy single-stage shape and there is nothing to do about it; a
      // reason this build cannot classify was written by a NEWER one, and the remedy is to upgrade
      // the reader. One shared `unknown` would rebuild the collapse one level up.
      else if (reason === undefined) m.closed.legacy_unlabelled++;
      else m.closed.unknown_reason++;
      // Orthogonal to the reason: the close edge stamps this when it could not tell whether a human
      // was required, so the number above is readable as "…and N we could not judge" (ADR 173).
      if (d.human_required_unknown === true) m.closed.human_required_unknown++;
    }
  }
  return m;
}

const WAKE_WINDOW_DAYS = 7;
const WAKE_WINDOW_MS = WAKE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** One parsed `residency.*` audit row — the wake ledger's outcome record. */
interface WakeAuditRow {
  action: string;
  /** Seat name (audit `target`). */
  target: string;
  ts: number;
  detail: {
    act?: string;
    lease_id?: string;
    session?: string;
    cost_usd?: number;
    /** ADR 209: what delivery the host observed. Absent on every wake predating that ADR. */
    delivery_outcome?: string;
    /** ADR 210: why the exact-match rung resolved. Absent unless the order was resume_eligible. */
    exact_match?: string;
    /** ADR 252: a session attested THIS lease before it expired — the wake was paid for. Present
     *  only when true; absence is silence, not a denial. */
    session_captured?: boolean;
  };
}

/**
 * Wake metrics (ADR 131 O&E, increment 5) — derived from `residency.*` audit rows joined to the
 * message log, the `deriveSteeringMetrics` shape. The headline pair:
 *
 * - **wake latency**: triggering directed act's ts → the woken seat's first act strictly after it.
 *   The message log proxies "first authenticated act", consistent with ADR 125 steering latency —
 *   non-message authenticated activity (presence touches, lane ops) deliberately doesn't count.
 * - **answer rate**: woken acts that reach `answered` in the ADR 090 ledger — a LIVE read via
 *   {@link actAnswered}, never the host's report-time `answered` snapshot (honest but stale).
 *
 * Attempts don't multiply samples: latency/answer are per *distinct* woken act. Cost is summed per
 * lease, preferring a supplementary `residency.wake_cost` row over the primary report's field, and
 * `cost_reported` carries the honesty denominator. Per-seat economics flag `over_budget` against
 * the seat's effective `budget_usd` — a REPORT bound (nothing was stopped mid-run).
 */
export function deriveWakeMetrics(
  db: Database,
  teamId: string,
  now: number = Date.now(),
): WakeMetrics {
  const since = now - WAKE_WINDOW_MS;
  const rows: WakeAuditRow[] = db
    .prepare<
      [string, number],
      { action: string; target: string; ts: number; detail: string | null }
    >(
      `SELECT action, target, ts, detail FROM audit
        WHERE team_id = ?
          AND action IN ('residency.woke','residency.wake_failed','residency.wake_deferred',
                         'residency.wake_exhausted','residency.wake_cost',
                         'residency.wake_report_rejected')
          AND ts > ?
        ORDER BY ts ASC`,
    )
    .all(teamId, since)
    .map((r) => {
      let detail: WakeAuditRow['detail'] = {};
      try {
        detail = r.detail ? (JSON.parse(r.detail) as WakeAuditRow['detail']) : {};
      } catch {
        /* best-effort rows stay countable */
      }
      return { action: r.action, target: r.target, ts: r.ts, detail };
    });

  // ADR 273: reports the daemon REFUSED. Not a wake outcome — a wake whose outcome never got
  // recorded, which is worse, because the lease then expires and reads as "the host never
  // answered". Counted separately from `failed` for exactly that reason: folding it in would
  // repeat the ADR 269 mistake of letting a refusal wear a failure's clothes.
  const reportsRejected = rows.filter((r) => r.action === 'residency.wake_report_rejected').length;

  const failed = rows.filter((r) => r.action === 'residency.wake_failed').length;
  const deferred = rows.filter((r) => r.action === 'residency.wake_deferred').length;
  const exhausted = rows.filter((r) => r.action === 'residency.wake_exhausted').length;

  // Distinct woken acts (attempt-dedupe): the LAST woke row classifies fresh-vs-resumed.
  const wokeRows = rows.filter((r) => r.action === 'residency.woke');
  const byAct = new Map<string, WakeAuditRow>();
  for (const r of wokeRows) if (r.detail.act) byAct.set(r.detail.act, r);

  // Cost per lease: primary report fields first, a supplementary wake_cost row wins.
  const costByLease = new Map<string, { seat: string; cost: number }>();
  for (const r of rows) {
    if (r.detail.lease_id === undefined || r.detail.cost_usd === undefined) continue;
    if (r.action === 'residency.wake_cost' || !costByLease.has(r.detail.lease_id)) {
      costByLease.set(r.detail.lease_id, { seat: r.target, cost: r.detail.cost_usd });
    }
  }

  const latencies: number[] = [];
  let answered = 0;
  const wakesBySeat = new Map<string, number>();
  for (const [actId, woke] of byAct) {
    wakesBySeat.set(woke.target, (wakesBySeat.get(woke.target) ?? 0) + 1);
    const msg = db
      .prepare<[string, string], MessageRow>('SELECT * FROM messages WHERE team_id = ? AND id = ?')
      .get(teamId, actId);
    const recipient = getMemberByName(db, teamId, woke.target);
    if (!msg || !recipient) continue;
    // The seat's first act strictly after the trigger (ts, then id) — the steering tie-break.
    const later = db
      .prepare<[string, string, number, number, string], { ts: number }>(
        `SELECT ts FROM messages
          WHERE team_id = ? AND from_member = ?
            AND (ts > ? OR (ts = ? AND id > ?))
          ORDER BY ts ASC, id ASC LIMIT 1`,
      )
      .get(teamId, recipient.id, msg.ts, msg.ts, msg.id);
    if (later) latencies.push(later.ts - msg.ts);
    if (actAnswered(db, msg, recipient.id)) answered += 1;
  }
  latencies.sort((a, b) => a - b);

  // Per-seat economics against the effective budget_usd (a per-run report bound: over_budget
  // when any single wake's attested cost exceeded it).
  const teamDefaults = getPolicy(db, teamId).residency;
  const by_seat: WakeSeatCost[] = [...wakesBySeat.entries()]
    .map(([seat, wakes]) => {
      const costs = [...costByLease.values()].filter((c) => c.seat === seat).map((c) => c.cost);
      const total = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
      const member = getMemberByName(db, teamId, seat);
      const enrollment = member ? getResidency(db, teamId, member.id) : null;
      const budget = enrollment
        ? (effectiveWakePolicy(teamDefaults, enrollment.policy).budget_usd ?? null)
        : null;
      return {
        seat,
        wakes,
        cost_usd_total: total,
        budget_usd: budget,
        over_budget: budget !== null && costs.some((c) => c > budget),
      };
    })
    .sort((a, b) => a.seat.localeCompare(b.seat));

  const costs = [...costByLease.values()].map((c) => c.cost);
  const costTotal = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;

  // ADR 252: wakes known to have PAID for a session and known to have no price. `wake_cost` is
  // written only on the report path, so a lease that spawned a session and then expired unreported
  // contributes nothing to `cost_usd_total` — it reads as free. This counts those, from the
  // identity token the session itself attested. A FLOOR by construction: an un-upgraded CLI
  // attests no token, and a wake it ran is simply not visible here (ADR 236 — absence is not a
  // zero). It is deliberately not folded into the cost total: the honest statement is "this many
  // wakes cost something we cannot name", never a made-up dollar figure.
  const unpricedSessions = rows.filter(
    (r) =>
      r.detail.session_captured === true &&
      r.detail.lease_id !== undefined &&
      !costByLease.has(r.detail.lease_id),
  ).length;

  // The ADR 209/210 Eval split, over the SAME attempt-deduped act set as every other wake number
  // here — so the cohorts are comparable by construction rather than by a reader's assumption.
  // Counted from the classifying (last) woke row; a supplementary wake_cost row re-states the same
  // values and must not double-count. Absent fields are skipped, never defaulted: a wake that
  // reported no delivery is not a `fresh` wake, it is an unmeasured one.
  const delivery = { fresh: 0, resumed: 0, fresh_fallback: 0 };
  const exact = { bound: 0, missing: 0, mismatched: 0, stale: 0 };
  let deliveryMeasured = 0;
  let exactMeasured = 0;
  for (const r of byAct.values()) {
    const d = r.detail.delivery_outcome;
    if (d !== undefined && d in delivery) {
      delivery[d as keyof typeof delivery] += 1;
      deliveryMeasured += 1;
    }
    const e = r.detail.exact_match;
    if (e !== undefined && e in exact) {
      exact[e as keyof typeof exact] += 1;
      exactMeasured += 1;
    }
  }

  return {
    window_days: WAKE_WINDOW_DAYS,
    wakes: byAct.size,
    resumed: [...byAct.values()].filter((r) => r.detail.session === 'resumed').length,
    delivery,
    delivery_measured: deliveryMeasured,
    exact_match: exact,
    exact_match_measured: exactMeasured,
    failed,
    deferred,
    exhausted,
    answered,
    answer_rate: byAct.size > 0 ? answered / byAct.size : null,
    latency_median_ms: percentile(latencies, 0.5),
    latency_p95_ms: percentile(latencies, 0.95),
    cost_usd_total: costTotal,
    cost_usd_per_wake: costTotal !== null ? costTotal / costs.length : null,
    cost_reported: costs.length,
    unpriced_sessions: unpricedSessions,
    reports_rejected: reportsRejected,
    by_seat,
  };
}

/** The whole report projection (ADR 050) — altitude-agnostic; the surfaces frame it per altitude. */
/**
 * The long-deferred exception (ADR 211 Failure mode), per seat. An act deferred until a lane that
 * never moves again is never raised, so postponement can quietly become dropping. Surfacing it is
 * the whole mitigation: warn, never block, never auto-un-defer — the system does not decide on a
 * Member's behalf that their deferral has expired.
 */
function deriveLongDeferred(
  db: Database,
  teamId: string,
  teamSlug: string,
  now: number,
): LongDeferred[] {
  const rows = listTeamMessages(db, teamId, { limit: DEFERRAL_SCAN_LIMIT });
  const envelopes = rows.map((r) => {
    const from = getMemberById(db, r.from_member);
    const to = r.to_member ? getMemberById(db, r.to_member) : null;
    return rowToEnvelope(r, teamSlug, from?.name ?? '?', to?.name ?? null);
  });
  const seats = new Set(envelopes.filter((e) => e.act === 'wait').map((e) => e.from));
  const out: LongDeferred[] = [];
  for (const seat of seats) {
    for (const d of longDeferred(envelopes, seat, now)) out.push({ seat, ...d });
  }
  return out.sort((a, b) => a.deferred_ts - b.deferred_ts);
}

export function deriveReport(
  db: Database,
  teamId: string,
  teamSlug: string,
  now: number = Date.now(),
  /** Presence liveness window for the family-posture snapshot (ADR 172); omitted ⇒ no posture. */
  presenceTimeoutMs?: number,
): Report {
  const blocked: BlockedLane[] = listLanes(db, teamId, teamSlug)
    .filter((l) => l.state === 'blocked')
    .map((l) => ({ id: l.id, title: l.title, owner_seat: l.owner_seat, goal_id: l.goal_id }));

  return {
    team: teamSlug,
    generated_ts: now,
    flow: flowMetrics(db, teamId, now),
    waiting_on: waitingOn(db, teamId, now),
    goals: listGoals(db, teamId, teamSlug),
    blocked,
    coordination: coordinationDensity(db, teamId, now),
    open_directed: openDirectedLedger(db, teamId, now),
    mast: deriveMast(db, teamId, now),
    steering: deriveSteeringMetrics(db, teamId, now),
    wake: deriveWakeMetrics(db, teamId, now),
    tool_calls: deriveToolCallMetrics(db, teamId, now),
    review: deriveReviewMetrics(db, teamId, now),
    long_deferred: deriveLongDeferred(db, teamId, teamSlug, now),
    // ADR 172: the model-family posture snapshot — derived, never stored. Sustained monoculture is
    // read off the SERIES of reports, not off any single one.
    ...(presenceTimeoutMs !== undefined
      ? { family_posture: teamFamilyPosture(db, teamId, presenceTimeoutMs) }
      : {}),
  };
}
