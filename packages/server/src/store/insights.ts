import type {
  BlockedLane,
  CoordinationDensity,
  FlowMetrics,
  Report,
  WaitingOnEntry,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { listGoals } from './goals.js';
import { listLanes } from './lanes.js';

/**
 * The insight engine (ADR 050, server-side per ADR 084) — leadership projections over lanes + the act
 * log, computed once so CLI/MCP/dashboard render one truth. Never stores anything; Goodhart-safe
 * (measures outcomes and queues, never message volume). See `@musterd/protocol/insights`.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CONTENDING = "('claimed','active','blocked')";

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
  };
}
