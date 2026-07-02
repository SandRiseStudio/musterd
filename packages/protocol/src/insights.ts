import { z } from 'zod';
import { GoalSchema } from './goals.js';

/**
 * The insight layer (ADR 050, engine placement per ADR 084): leadership-grade **projections over the
 * act log — never stored, Goodhart-safe**. Computed once server-side (`GET /teams/:slug/report`) so the
 * CLI, MCP, and dashboard render one projection, never three divergent ones. Everything here is derived
 * from lanes + the message log; cost-per-shipped-item is deferred to the batond cost-ingestion seam.
 */

/**
 * Flow metrics over velocity (ADR 050 Part 5) — from lane timestamps (ADR 084), never message volume.
 * Nullable where undefined-for-empty (no closed lane yet → no cycle time). Goodhart guard: these count
 * outcomes and queues, not chatter.
 */
export const FlowMetricsSchema = z.object({
  /** Lanes reaching `done` in the last 7 days — throughput. */
  throughput_7d: z.number().int(),
  /** Mean `claimed_at → resolved_at` over done lanes with both stamps, in ms; null if none. */
  cycle_time_ms: z.number().nullable(),
  /** Work-in-progress: contending lanes (claimed/active/blocked). */
  wip: z.number().int(),
  /** Age of the oldest still-live lane (now − created_at), in ms; null if nothing live. */
  oldest_wip_age_ms: z.number().nullable(),
});
export type FlowMetrics = z.infer<typeof FlowMetricsSchema>;

/**
 * The waiting-on view (ADR 050 Part 6): who owes replies. `openActionNeeded` (ADR 024/025) aggregated
 * by the member a directed, unresolved ask targets — sorted oldest-first. Names the real bottleneck
 * ("waiting on nick — 8 threads, oldest 2d"). Goodhart-safe: it measures queues, never output.
 */
export const WaitingOnEntrySchema = z.object({
  member: z.string(),
  /** Distinct unresolved threads directed at this member. */
  threads: z.number().int(),
  /** Age of the oldest such ask, in ms. */
  oldest_age_ms: z.number().int(),
});
export type WaitingOnEntry = z.infer<typeof WaitingOnEntrySchema>;

/** A live lane flagged `blocked` — the report's exception list (exec altitude reads this). */
export const BlockedLaneSchema = z.object({
  id: z.string(),
  title: z.string(),
  owner_seat: z.string().nullable(),
  goal_id: z.string().nullable(),
});
export type BlockedLane = z.infer<typeof BlockedLaneSchema>;

/**
 * `GET /teams/:slug/report` — the whole projection, altitude-agnostic. The surfaces (CLI/MCP/dashboard)
 * pick what to emphasise per altitude (ic = the board, team = the digest, exec = milestones+exceptions);
 * the engine computes everything once. `generated_ts` stamps when the projection was taken.
 */
export const ReportSchema = z.object({
  team: z.string(),
  generated_ts: z.number().int(),
  flow: FlowMetricsSchema,
  waiting_on: z.array(WaitingOnEntrySchema),
  /** Declared Goals with derived status — the coarse board (planned/in-flight/shipped). */
  goals: z.array(GoalSchema),
  /** Live lanes in `blocked` state — the exceptions worth surfacing. */
  blocked: z.array(BlockedLaneSchema),
});
export type Report = z.infer<typeof ReportSchema>;
