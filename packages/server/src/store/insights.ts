import type {
  BlockedLane,
  CoordinationDensity,
  FlowMetrics,
  Report,
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
import { getMemberByName } from './members.js';
import { effectiveWakePolicy, getResidency } from './residency.js';
import type { MessageRow } from './rows.js';
import { getPolicy } from './teams.js';
import { deriveToolCallMetrics } from './toolCalls.js';

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
                         'residency.wake_exhausted','residency.wake_cost')
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
  return {
    window_days: WAKE_WINDOW_DAYS,
    wakes: byAct.size,
    resumed: [...byAct.values()].filter((r) => r.detail.session === 'resumed').length,
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
    by_seat,
  };
}

/** The whole report projection (ADR 050) — altitude-agnostic; the surfaces frame it per altitude. */
export function deriveReport(
  db: Database,
  teamId: string,
  teamSlug: string,
  now: number = Date.now(),
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
  };
}
