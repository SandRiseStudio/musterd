import type { CircularHandoff, MastBlock, StalledThread, TimeToUnblock } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { openDirectedLedger } from './delivery.js';

/**
 * The MAST-aware views (ADR 091; observability.md §5b) — the thread-shaped failure detectors over
 * the act log that nothing computed until now: time-to-unblock, stalled threads, circular
 * handoffs. Derived per query, never stored; windowed like coordination-density; diagnostic
 * instruments, never per-member scores (human-agent-dynamics §4). The other two §5b lenses are
 * served elsewhere and only referenced here: act-mix = coordinationDensity (ADR 050), ignored
 * request_help = the ADR 090 open directed ledger filtered by age.
 */

const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** A request_help unanswered this long is MAST's "ignored agent input". */
const IGNORED_HELP_MS = 60 * 60 * 1000;
/** A multi-act thread quiet this long with no resolve has stalled. */
const STALLED_MS = 24 * 60 * 60 * 1000;
/** Cap the lists — the report is a digest, not an export. */
const MAX_ENTRIES = 10;

/**
 * Time-to-unblock over loops *closed* in the window: an accept/decline naming a
 * request_help/handoff via meta.in_reply_to, or a resolve closing its thread root. The lived,
 * retroactive counterpart of the emitted loop_latency histogram.
 */
export function timeToUnblock(db: Database, teamId: string, now: number): TimeToUnblock {
  const since = now - WINDOW_MS;
  const latencies = db
    .prepare<[string, number], { ms: number }>(
      `SELECT (c.ts - o.ts) AS ms
         FROM messages c
         JOIN messages o
           ON o.team_id = c.team_id
          AND o.act IN ('request_help','handoff')
          AND (
            (c.act IN ('accept','decline') AND o.id = json_extract(c.meta, '$.in_reply_to'))
            OR
            (c.act = 'resolve' AND c.thread_id IS NOT NULL
             AND COALESCE(o.thread_id, o.id) = c.thread_id)
          )
        WHERE c.team_id = ? AND c.ts > ? AND c.act IN ('accept','decline','resolve')
          AND c.ts >= o.ts`,
    )
    .all(teamId, since)
    .map((r) => r.ms)
    .sort((a, b) => a - b);
  const q = (p: number) =>
    latencies.length === 0
      ? null
      : latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]!;
  return { closed: latencies.length, median_ms: q(0.5), p95_ms: q(0.95) };
}

/**
 * Stalled threads (MAST coordination breakdown): ≥ 2 acts on the thread, no resolve, quiet past
 * the threshold. Oldest-stall first, capped.
 */
export function stalledThreads(db: Database, teamId: string, now: number): StalledThread[] {
  const rows = db
    .prepare<[string, number, number], StalledThread & { last_ts: number }>(
      `SELECT m.thread_id AS thread,
              COUNT(*) AS acts,
              MAX(m.ts) AS last_ts,
              (SELECT m2.act FROM messages m2
                WHERE m2.team_id = m.team_id AND m2.thread_id = m.thread_id
                ORDER BY m2.ts DESC, m2.id DESC LIMIT 1) AS last_act,
              COUNT(DISTINCT m.from_member) AS participants
         FROM messages m
        WHERE m.team_id = ? AND m.thread_id IS NOT NULL AND m.ts > ?
        GROUP BY m.thread_id
       HAVING COUNT(*) >= 2
          AND SUM(CASE WHEN m.act = 'resolve' THEN 1 ELSE 0 END) = 0
          AND MAX(m.ts) < ?
        ORDER BY last_ts ASC`,
    )
    .all(teamId, now - WINDOW_MS, now - STALLED_MS)
    .slice(0, MAX_ENTRIES);
  return rows.map((r) => ({
    thread: r.thread,
    acts: r.acts,
    last_act: r.last_act,
    participants: r.participants,
    quiet_ms: Math.max(0, now - r.last_ts),
  }));
}

/**
 * Circular handoffs (MAST step repetition): within one thread, a handoff whose recipient already
 * sent or received an earlier handoff in that thread — work going in circles (A→B→…→A).
 */
export function circularHandoffs(db: Database, teamId: string, now: number): CircularHandoff[] {
  const rows = db
    .prepare<
      [string, number],
      { thread: string; from_id: string; to_id: string | null; ts: number }
    >(
      `SELECT COALESCE(m.thread_id, m.id) AS thread, m.from_member AS from_id, m.to_member AS to_id, m.ts
         FROM messages m
        WHERE m.team_id = ? AND m.act = 'handoff' AND m.ts > ?
        ORDER BY thread, m.ts ASC`,
    )
    .all(teamId, now - WINDOW_MS);
  const out: CircularHandoff[] = [];
  let thread = '';
  let involved = new Set<string>();
  let hops = 0;
  for (const r of rows) {
    if (r.thread !== thread) {
      thread = r.thread;
      involved = new Set();
      hops = 0;
    }
    hops += 1;
    if (r.to_id && involved.has(r.to_id) && !out.some((c) => c.thread === thread)) {
      out.push({ thread, hops, ts: r.ts });
    }
    involved.add(r.from_id);
    if (r.to_id) involved.add(r.to_id);
  }
  return out.slice(0, MAX_ENTRIES);
}

/** The whole mast block for the report (ADR 091). */
export function deriveMast(db: Database, teamId: string, now: number = Date.now()): MastBlock {
  return {
    window_days: WINDOW_DAYS,
    time_to_unblock: timeToUnblock(db, teamId, now),
    // MAST's ignored-input lens: the ADR 090 ledger filtered, not a second derivation.
    ignored_help: openDirectedLedger(db, teamId, now).filter(
      (d) => d.act === 'request_help' && d.age_ms > IGNORED_HELP_MS,
    ),
    stalled_threads: stalledThreads(db, teamId, now),
    circular_handoffs: circularHandoffs(db, teamId, now),
  };
}
