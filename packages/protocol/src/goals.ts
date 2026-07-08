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

export const GoalDeclareMetaSchema = z.object({
  goal: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    /** Build-order lane, mirroring roadmap.data.ts's Wave — a plain rank, or 'later' (sorts last). */
    wave: z.union([z.number().int(), z.literal('later')]).optional(),
    /** Goal ids this Goal is blocked on — `nextGoal` skips a candidate until all of these ship. */
    depends_on: z.array(z.string()).optional(),
  }),
});
export type GoalDeclareMeta = z.infer<typeof GoalDeclareMetaSchema>;

/** A declared Goal with its derived status attached (ADR 048 as amended by 084) — the read projection. */
export const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  wave: z.union([z.number().int(), z.literal('later')]).nullable(),
  depends_on: z.array(z.string()),
  declared_by: z.string(),
  declared_at: z.number().int(),
  status: GoalStatusSchema,
  /**
   * The Goal's **plan epoch** (ADR 109, ADR 088 increment 3) — a monotonic count of the direction-
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
  wave: z.union([z.number().int(), z.literal('later')]).optional(),
  depends_on: z.array(z.string()).optional(),
});
export type DeclareGoal = z.infer<typeof DeclareGoalSchema>;
