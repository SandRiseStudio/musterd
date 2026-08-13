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

/**
 * The default busy/quiet line, used only where the shape demands a *label* the caller did not
 * choose: the roster's `quiescence.state` and the wake pool's `seat_quiet` fact. Deliberately the
 * same 120s as the auto-refresher's `--quiet-floor` default, so the two server-side readers of this
 * signal do not quietly disagree about what "busy" means.
 *
 * This is not the server-side threshold the design rules out. That prohibition is about *taking a
 * decision away from the consumer* — and it holds: `quiet_for_ms` rides the wire beside the label,
 * so any reader with its own line recomputes and ignores this one. What a constant cannot do is
 * make `state` optional; some number has to draw it, and an undocumented one drawn ad-hoc at each
 * call site would be strictly worse than one named here.
 */
export const QUIESCENCE_DEFAULT_QUIET_AFTER_MS = 120_000;

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
 * Per-seat newest audited action for one team: `actor name → ts`. One query for the whole roster —
 * the caller renders every member, and a per-member query would turn a roster read into N of them.
 *
 * An actor with no audited action inside the lookback is **absent from the map**, never present
 * with a zero or a floor value. Absence is how `unknown` survives the trip to the caller: a `Map`
 * miss is unambiguous in a way a sentinel number is not, and the ADR 169/189 discipline only works
 * if "I have no evidence" cannot be mistaken for "I have evidence of quiet".
 *
 * Unlike {@link quietestBusyMs} this does not narrow to live agent seats. The narrowing there is
 * the /health consumer's (a bounce is an agent cost); here the callers are the roster — which
 * renders humans too — and the wake pool, which reads only the offline seats it was already
 * considering. Filtering belongs to whoever knows why.
 */
export function lastActionByActor(
  db: Database,
  teamId: string,
  opts: { now?: number; lookbackMs?: number; excludeActions?: string[] } = {},
): Map<string, number> {
  const now = opts.now ?? Date.now();
  const lookback = opts.lookbackMs ?? QUIESCENCE_LOOKBACK_MS;
  const exclude = opts.excludeActions ?? [];
  const rows =
    exclude.length === 0
      ? db
          .prepare<[string, number], { actor: string; last_ts: number }>(
            `SELECT a.actor AS actor, MAX(a.ts) AS last_ts
               FROM audit a
              WHERE a.team_id = ? AND a.ts > ?
              GROUP BY a.actor`,
          )
          .all(teamId, now - lookback)
      : db
          .prepare<[string, number, ...string[]], { actor: string; last_ts: number }>(
            `SELECT a.actor AS actor, MAX(a.ts) AS last_ts
               FROM audit a
              WHERE a.team_id = ? AND a.ts > ?
                AND a.action NOT IN (${exclude.map(() => '?').join(', ')})
              GROUP BY a.actor`,
          )
          .all(teamId, now - lookback, ...exclude);
  return new Map(rows.map((r) => [r.actor, r.last_ts]));
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
