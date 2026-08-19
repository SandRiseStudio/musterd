import { z } from 'zod';

/**
 * Declared Goals for a **general** team (ADR 048's open seam, resolved by ADR 084's forward guidance):
 * "a thread declared to `@team` carrying goal metadata — no new act, no new table." A Goal declaration
 * is an ordinary `message` act to `@team` whose `meta.goal` carries the skeleton. musterd's own dogfood
 * keeps using `roadmap.data.ts` as its Goal store (unaffected by this); this is the mechanism any other
 * team gets for free.
 */

/**
 * Derived Goal status (ADR 048 as amended by ADR 084) — a projection, never stored. Live and
 * flap-tolerant: reopening work returns a Goal to `in-flight`. `shipped` is conjunctive over lanes
 * (all terminal, ≥1 `done`); a permanent milestone latch is a deferred, separate declared marker.
 */
export const GoalStatusSchema = z.enum(['planned', 'in-flight', 'shipped']);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

/** plain-language one-liner for the stranger — what this goal means, not its title */
export const GoalStorySchema = z.string().trim().min(1).max(140);

/**
 * A Goal's build-order marker, as it reads **today** (ADR 257): `'later'` shelves a Goal, `null` is the
 * ordinary unset. The numeric rank is retired — see {@link LegacyDeclaredWaveSchema}.
 */
export const GoalWaveSchema = z.literal('later').nullable();

/**
 * The wave as it may appear **in the durable log** (ADR 257 migration). The journal is append-only and
 * pre-257 declarations carry integers (`wave: 7`), so the *read* schema must keep accepting them or
 * every legacy Goal fails `GoalDeclareMetaSchema.parse` and silently drops out of the projection. The
 * fold coerces an integer to `null` — history stays readable, but a number no longer orders anything.
 * The *write* path ({@link DeclareGoalSchema}) is closed to numbers.
 */
export const LegacyDeclaredWaveSchema = z.union([z.number().int(), z.literal('later')]);

export const GoalDeclareMetaSchema = z.object({
  goal: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    /** plain-language one-liner for the stranger — what this goal means, not its title */
    story: GoalStorySchema.optional(),
    /** Tolerant on read only (ADR 257): a pre-257 integer parses, then folds to `null`. */
    wave: LegacyDeclaredWaveSchema.optional(),
    /** Goal ids this Goal is blocked on — `nextGoal` skips a candidate until all of these ship. */
    depends_on: z.array(z.string()).optional(),
  }),
});
export type GoalDeclareMeta = z.infer<typeof GoalDeclareMetaSchema>;

/** A goal outcome note (value-layer design): what shipped changed for a user — evidence, not a slogan.
 *  Longer cap than `story` (280 vs 140) because evidence names specifics. Never part of the declared
 *  skeleton: re-declaration replaces the skeleton wholesale, and an outcome must survive that. */
export const GoalOutcomeSchema = z.object({
  goal_id: z.string().min(1),
  outcome: z.string().trim().min(1).max(280),
});
export type GoalOutcome = z.infer<typeof GoalOutcomeSchema>;

/** `meta.goal_outcome` on a team-visible `message` act — replayed by listGoals beside defer/steer. */
export const GoalOutcomeMetaSchema = z.object({ goal_outcome: GoalOutcomeSchema });
export type GoalOutcomeMeta = z.infer<typeof GoalOutcomeMetaSchema>;

/** A goal retraction: this Goal is withdrawn from the board. A signal folded on read, never a row
 *  deletion — the declaration and the retraction both stay in the append-only log (ADR 048's bet).
 *  Latest signal by ts wins, so a later re-declaration un-retracts. */
export const GoalRetractSchema = z.object({
  goal_id: z.string().min(1),
});
export type GoalRetract = z.infer<typeof GoalRetractSchema>;

/** `meta.goal_retract` on a team-visible `message` act — replayed by listGoals beside outcomes. */
export const GoalRetractMetaSchema = z.object({ goal_retract: GoalRetractSchema });
export type GoalRetractMeta = z.infer<typeof GoalRetractMetaSchema>;

/** A declared Goal with its derived status attached (ADR 048 as amended by 084) — the read projection. */
export const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** `'later'` = shelved, `null` = unset (ADR 257 retired the numeric rank; legacy ints fold to null). */
  wave: GoalWaveSchema,
  depends_on: z.array(z.string()),
  declared_by: z.string(),
  declared_at: z.number().int(),
  status: GoalStatusSchema,
  /** plain-language one-liner for the stranger (goals-front-door design); absent when never declared. */
  story: z.string().optional(),
  /** Latest outcome note (value-layer design): what changed for a user. Derived from the newest
   *  `meta.goal_outcome` signal — provenance free, survives skeleton re-declaration, anyone amends. */
  outcome: z.object({ text: z.string(), by: z.string(), at: z.number().int() }).optional(),
  /** Withdrawn from the board (goal-retract design): the newest `meta.goal_retract` beats the newest
   *  declaration by ts. Present = retracted (with provenance); a later re-declaration clears it.
   *  Default surfaces hide retracted Goals; nothing is deleted from the log. */
  retracted: z.object({ by: z.string(), at: z.number().int() }).optional(),
  /**
   * The Goal's **plan epoch** (ADR 111, ADR 088 increment 3) — a monotonic count of the direction-
   * changing acts that have landed on this Goal: every `defer` naming it (a re-sequence) and every
   * `steer` that names it via `meta.goal_id`. Derived from the durable act log, never stored (the
   * ADR 048 maxim) — the mirror of how `status` is a projection over lanes. `0` means nobody has
   * steered or deferred the Goal since it was declared. A lane opened when the Goal was on epoch N,
   * read back while the Goal is on epoch M > N, is building against a superseded plan — the staleness
   * §5 makes detectable when the interrupt line missed.
   */
  epoch: z.number().int().nonnegative(),
});
export type Goal = z.infer<typeof GoalSchema>;

/** `GET /teams/:slug/goals` — every declared Goal with derived status. */
export const GoalListSchema = z.object({
  goals: z.array(GoalSchema),
});
export type GoalList = z.infer<typeof GoalListSchema>;

/** Body for `POST /teams/:slug/goals` (`goal declare`) — thin sugar over a `message` act to `@team`. */
export const DeclareGoalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** plain-language one-liner for the stranger — what this goal means, not its title */
  story: GoalStorySchema.optional(),
  /** ADR 257: `'later'` shelves; omit for the ordinary case. A numeric rank is no longer accepted. */
  wave: z.literal('later').optional(),
  depends_on: z.array(z.string()).optional(),
});
export type DeclareGoal = z.infer<typeof DeclareGoalSchema>;

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
const STATUS_RANK: Record<GoalStatus, number> = { 'in-flight': 0, planned: 1, shipped: 2 };

export function compareGoals(
  a: Pick<Goal, 'wave' | 'status' | 'declared_at'>,
  b: Pick<Goal, 'wave' | 'status' | 'declared_at'>,
): number {
  return (
    Number(a.wave === 'later') - Number(b.wave === 'later') ||
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    b.declared_at - a.declared_at
  );
}

/** Body for `POST /teams/:slug/goals/outcome` — thin sugar over a `message` act to `@team`. */
export const PostGoalOutcomeSchema = GoalOutcomeSchema;

/** Body for `POST /teams/:slug/goals/retract` — thin sugar over a `message` act to `@team`. */
export const PostGoalRetractSchema = GoalRetractSchema;
