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
 * Coordination-density (the P3 dogfood signal): does the team's recent traffic *coordinate*, or just
 * broadcast? A `status_update` fired at `@team` that no one threads or answers is a journal entry, not
 * coordination — 51% of the P3 session was exactly that. Over a recent window: how much traffic is
 * broadcast journal vs directed/threaded exchange. `flag` trips when it's journal-heavy and
 * exchange-light — "coordination that only looks collaborative." A signal only the act-typed log can
 * compute; a candidate metric for the standalone coordination-observability product. Goodhart-safe: it
 * measures the *shape* of coordination, never volume as a reward.
 */
export const CoordinationDensitySchema = z.object({
  /** The window this is computed over, in days. */
  window_days: z.number().int(),
  /** Total message acts in the window. */
  acts: z.number().int(),
  /** `status_update`s broadcast to `@team`/`@broadcast` — the journal. */
  journal: z.number().int(),
  /** Acts directed at a specific member — directed exchange. */
  directed: z.number().int(),
  /** Acts that are part of a thread (a reply) — threaded exchange. */
  threaded: z.number().int(),
  /** journal / acts (0 when no acts). */
  journal_ratio: z.number(),
  /** (directed ∪ threaded) / acts — real exchange (0 when no acts). */
  exchange_ratio: z.number(),
  /** True when journal-heavy and exchange-light over a non-trivial sample. */
  flag: z.boolean(),
});
export type CoordinationDensity = z.infer<typeof CoordinationDensitySchema>;

/**
 * One recipient's rung on the delivery ladder (ADR 090): `logged` (persisted to the inbox — in
 * musterd durability IS delivery, so there is no local `failed`) → `seen` (their read cursor crossed
 * the act) → `answered` (their accept/decline named it, or a resolve closed its thread). Derived from
 * the log + cursors + the interrupt audit — never stored.
 */
export const DeliveryRecipientSchema = z.object({
  seat: z.string(),
  /** Normalized seat id (issue #107) — the keying identity; `seat` is the display label. */
  seat_id: z.string(),
  state: z.enum(['logged', 'seen', 'answered']),
  /**
   * When their cursor crossed the act — watermark semantics (the cursor update's timestamp, shared
   * by every act that update crossed), NOT a per-message receipt. Null while unseen.
   */
  seen_by: z.number().int().nullable(),
  /** The closing act, when the loop closed. */
  answered: z.object({ act: z.string(), id: z.string(), ts: z.number().int() }).nullable(),
  /** ADR 088 interrupt raises recorded for this (act, recipient) — the attempt history. */
  interrupt_raises: z.number().int(),
});
export type DeliveryRecipient = z.infer<typeof DeliveryRecipientSchema>;

/** The per-act delivery ledger (ADR 090): one act's journey across every recipient. */
export const ActDeliverySchema = z.object({
  id: z.string(),
  act: z.string(),
  from: z.string(),
  to_kind: z.enum(['member', 'team', 'broadcast']),
  thread: z.string().nullable(),
  ts: z.number().int(),
  age_ms: z.number().int(),
  urgent: z.boolean(),
  recipients: z.array(DeliveryRecipientSchema),
});
export type ActDelivery = z.infer<typeof ActDeliverySchema>;

/**
 * Time-to-unblock (ADR 091): over loops closed in the window (accept/decline naming a
 * request_help/handoff, or a resolve on its thread), the distribution of open→close latency.
 * A team distribution, never a per-member score.
 */
export const TimeToUnblockSchema = z.object({
  closed: z.number().int(),
  median_ms: z.number().nullable(),
  p95_ms: z.number().nullable(),
});
export type TimeToUnblock = z.infer<typeof TimeToUnblockSchema>;

/** A thread that went quiet without a resolve (MAST coordination breakdown; ADR 091). */
export const StalledThreadSchema = z.object({
  thread: z.string(),
  acts: z.number().int(),
  last_act: z.string(),
  participants: z.number().int(),
  quiet_ms: z.number().int(),
});
export type StalledThread = z.infer<typeof StalledThreadSchema>;

/** A handoff chain that returned to a prior participant (MAST step repetition; ADR 091). */
export const CircularHandoffSchema = z.object({
  thread: z.string(),
  /** Handoffs seen on the thread up to and including the circular one. */
  hops: z.number().int(),
  /** When the chain closed the circle. */
  ts: z.number().int(),
});
export type CircularHandoff = z.infer<typeof CircularHandoffSchema>;

/**
 * The MAST block (ADR 091): the §5b failure detectors as one derived projection — time-to-unblock,
 * ignored request_help (the ADR 090 ledger filtered by age), stalled threads, circular handoffs.
 * Act-mix/broadcast-share stays in `coordination` (ADR 050). Diagnostic instruments, not scores.
 */
export const MastBlockSchema = z.object({
  window_days: z.number().int(),
  time_to_unblock: TimeToUnblockSchema,
  ignored_help: z.array(ActDeliverySchema),
  stalled_threads: z.array(StalledThreadSchema),
  circular_handoffs: z.array(CircularHandoffSchema),
});
export type MastBlock = z.infer<typeof MastBlockSchema>;

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
  /** Coordination-density: is recent traffic real exchange, or broadcast journal? */
  coordination: CoordinationDensitySchema,
  /**
   * The open directed ledger (ADR 090): loop-opening acts (request_help/handoff, plus urgent
   * directed acts) not yet answered — finding 002's "open_loops=1 for ~70 h" made answerable
   * (which act, whose inbox, seen or ignored).
   */
  open_directed: z.array(ActDeliverySchema),
  /** The MAST-aware failure detectors (ADR 091) — the thread-shaped views over the same log. */
  mast: MastBlockSchema,
});
export type Report = z.infer<typeof ReportSchema>;
