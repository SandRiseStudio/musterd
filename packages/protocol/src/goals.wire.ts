/**
 * The Goal vocabulary and its ordering as plain TypeScript — no zod. `goals.ts` builds its enum
 * from this tuple and re-exports the names, so the browser can order a goal grid without pulling a
 * validator into its bundle (`guards.ts`).
 */

/**
 * Derived Goal status (ADR 048 as amended by ADR 084) — a projection, never stored. Live and
 * flap-tolerant: reopening work returns a Goal to `in-flight`. `shipped` is conjunctive over lanes
 * (all terminal, ≥1 `done`); a permanent milestone latch is a deferred, separate declared marker.
 */
export const GOAL_STATUSES = ['planned', 'in-flight', 'shipped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** A Goal's build-order marker as it reads today (ADR 257): `'later'` shelves it, `null` is unset. */
export type GoalWave = 'later' | null;

const STATUS_RANK: Record<GoalStatus, number> = { 'in-flight': 0, planned: 1, shipped: 2 };

/** The fields `compareGoals` reads — kept structural so it needs no zod-derived Goal type. */
export interface GoalOrder {
  wave: GoalWave;
  status: GoalStatus;
  declared_at: number;
}

/**
 * The order Goals are offered in (ADR 257), shared by every consumer — `nextGoal`, the orientation
 * brief, the `no_goal` suggestion and the web grid — so the four cannot drift apart again (drifting
 * copies of a rank function are what let the retired numeric wave mis-steer the board unnoticed).
 *
 * Shelved last, then `in-flight` before `planned` before `shipped`, then **most recently declared
 * first**. Recency is the self-maintaining signal the numeric rank was not: re-declaring or amending a
 * Goal is itself the statement that the team cares about it now, so the order cannot go stale while
 * nobody is looking. `depends_on` remains a separate, harder filter — a blocked Goal is not a
 * candidate at all, which is correctness, where this is only preference.
 */
export function compareGoals(a: GoalOrder, b: GoalOrder): number {
  return (
    Number(a.wave === 'later') - Number(b.wave === 'later') ||
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    b.declared_at - a.declared_at
  );
}
