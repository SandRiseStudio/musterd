import type { Quiescence } from '@musterd/protocol';
import type { Database } from '../db/open.js';

/**
 * Quiescence — the decision-grade "is this seat busy right now" read (2026-08-03 design; spec in
 * docs/superpowers/specs/2026-08-03-quiescence-signal-design.md). Derived, never stored: the audit
 * trail already timestamps every action the daemon witnesses (tool calls, sends, lane ops), so
 * "how long since this seat last did observable work" is a read-time question with zero new writers.
 *
 * Deliberately NOT `activity`. That is a display fact (ADR 010/140: "has this live seat
 * self-reported a task?") and for agents it is sticky by design — a wrong rendering is cosmetic.
 * This is what machines decide from — bounce timing, wake spend — and a wrong answer here
 * interrupts a seat mid-turn. Splitting them is the whole design; neither reads the other.
 *
 * `unknown` is honest and load-bearing (ADR 169/189 absent-vs-unknown): no audited action inside
 * the lookback is not "quiet", it is unknowable, and every consumer must degrade to its
 * without-this-signal behaviour on it. Thresholds belong to the CONSUMER — the busy/quiet line is a
 * parameter, never a server constant, or this would recreate `activity`'s one-size-fits-nobody.
 */

/** How far back the audit read looks. Beyond this, evidence is stale enough to call `unknown`. */
export const QUIESCENCE_LOOKBACK_MS = 60 * 60_000;

/** The pure verdict. `quietAfterMs` is the caller's line; `lastActionAt: null` means no evidence. */
export function resolveQuiescence(
  lastActionAt: number | null,
  now: number,
  quietAfterMs: number,
): Quiescence {
  if (lastActionAt === null) return { state: 'unknown', quiet_for_ms: null, source: 'audit' };
  // A future timestamp is clock skew, not time travel — clamp to "acted just now" rather than
  // handing a consumer a negative age it will compare against thresholds in surprising ways.
  const quietFor = Math.max(0, now - lastActionAt);
  return {
    state: quietFor >= quietAfterMs ? 'quiet' : 'busy',
    quiet_for_ms: quietFor,
    source: 'audit',
  };
}

/**
 * The one number `/health` carries for the auto-refresher: the age (ms) of the newest audited
 * action across live AGENT seats — "the most recently active seat acted this long ago". Null when
 * no live agent seat has acted inside the lookback: unknown, not zero, so a consumer that would
 * gate on it degrades to acting as if the field were never added.
 *
 * Cross-team on purpose, like `connections` beside it: a daemon bounce drops every team's sessions,
 * so the bounce decision must see every team's work. Agents only — a human's audit actions are a
 * human at a terminal, and the cost this signal guards (dropping a seat mid-tool-call) is an agent
 * cost; humans are guarded by the operator notification that already precedes a forced bounce.
 */
export function quietestBusyMs(
  db: Database,
  opts: { now?: number; presenceTimeoutMs: number; lookbackMs?: number },
): number | null {
  const now = opts.now ?? Date.now();
  const lookback = opts.lookbackMs ?? QUIESCENCE_LOOKBACK_MS;
  const row = db
    .prepare<[number, number], { last_ts: number | null }>(
      `SELECT MAX(a.ts) AS last_ts
       FROM audit a
       JOIN members m ON m.team_id = a.team_id AND m.name = a.actor
       WHERE a.ts > ?
         AND m.kind = 'agent'
         AND EXISTS (
           SELECT 1 FROM presence p
           WHERE p.member_id = m.id AND p.held_until IS NULL AND p.last_seen_at > ?
         )`,
    )
    .get(now - lookback, now - opts.presenceTimeoutMs);
  if (!row || row.last_ts === null) return null;
  return Math.max(0, now - row.last_ts);
}
