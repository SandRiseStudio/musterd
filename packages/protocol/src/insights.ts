import { z } from 'zod';
import { GoalSchema } from './goals.js';
import { ToolCallMetricsSchema } from './tool-telemetry.js';

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
 * exchange-light — "coordination that only looks collaborative." Shipped in ADR 050 / PR #84, this is
 * a signal only the act-typed log can compute and a candidate metric for the standalone
 * coordination-observability product. Goodhart-safe: it measures the *shape* of coordination, never
 * volume as a reward.
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
 * A review/approval chain whose model diversity is worth the human's attention (ADR 101):
 * `flagged` = single-model-family end-to-end (all `claude-*`) — treat agreement as weak evidence;
 * `unverifiable` = a link in the chain carried no attested model, so diversity can't be judged
 * (honestly poisoned, never presumed diverse). Scoped to answered request_help/handoff chains only —
 * scarce by construction, matching the claim it makes. Warn-never-block: it informs the human's
 * weighting of the evidence, it never gates anything.
 */
export const DiversityFlagSchema = z.object({
  thread: z.string(),
  /** The chain's opening act (request_help | handoff | challenge) — the kind of agreement reached. */
  kind: z.string(),
  participants: z.number().int(),
  /** The distinct model families seen on the chain's acts (server-derived from attested ids). */
  families: z.array(z.string()),
  verdict: z.enum(['flagged', 'unverifiable']),
  /** When the chain closed (the answering act). */
  ts: z.number().int(),
});
export type DiversityFlag = z.infer<typeof DiversityFlagSchema>;

/**
 * The MAST block (ADR 091): the §5b failure detectors as one derived projection — time-to-unblock,
 * ignored request_help (the ADR 090 ledger filtered by age), stalled threads, circular handoffs,
 * plus the ADR 101 model-diversity flag over review/approval chains.
 * Act-mix/broadcast-share stays in `coordination` (ADR 050). Diagnostic instruments, not scores.
 */
export const MastBlockSchema = z.object({
  window_days: z.number().int(),
  time_to_unblock: TimeToUnblockSchema,
  ignored_help: z.array(ActDeliverySchema),
  stalled_threads: z.array(StalledThreadSchema),
  circular_handoffs: z.array(CircularHandoffSchema),
  diversity: z.array(DiversityFlagSchema),
});
export type MastBlock = z.infer<typeof MastBlockSchema>;

/**
 * Interrupt-line arc metrics (ADR 125 / ADR 088 increment 4) — steering latency, supersession
 * correctness, and stale-work-caught. Derived from the message + lane log; diagnostic, never a score.
 */
export const SteeringMetricsSchema = z.object({
  window_days: z.number().int(),
  /** Directed `steer` acts in the window. */
  steers: z.number().int(),
  /** Steers that got a subsequent act from the recipient. */
  acked: z.number().int(),
  /** Median steer→ack latency in ms; null when nothing acked. */
  latency_median_ms: z.number().nullable(),
  /** p95 steer→ack latency in ms; null when nothing acked. */
  latency_p95_ms: z.number().nullable(),
  /** Acts whose `in_reply_to` named a superseded steer — should be zero (ADR 103). */
  superseded_acts: z.number().int(),
  /** `stale_plan` / `stale_dependency` wake acts in the window. */
  stale_wakes: z.number().int(),
  /** Those wakes followed by an owner course-change (ADR 111). */
  stale_caught: z.number().int(),
});
export type SteeringMetrics = z.infer<typeof SteeringMetricsSchema>;

/** Per-seat wake economics (ADR 131 inc 5, finding c): spend against the seat's `budget_usd`
 *  report bound. `over_budget` FLAGS — nothing was stopped (no backend can kill a run on dollars;
 *  spend control stays cooldown/caps/watchdog). */
export const WakeSeatCostSchema = z.object({
  seat: z.string(),
  wakes: z.number().int(),
  /** Sum of attested wake spend; null when no wake in the window reported a cost. */
  cost_usd_total: z.number().nullable(),
  /** The seat's effective `budget_usd` report bound; null when unset. */
  budget_usd: z.number().nullable(),
  over_budget: z.boolean(),
});
export type WakeSeatCost = z.infer<typeof WakeSeatCostSchema>;

/**
 * Wake metrics (ADR 131 O&E, increment 5) — the headline pair (wake latency: directed-act ts →
 * woken seat's first authenticated act; answer rate: woken acts reaching `answered` in the ADR 090
 * ledger) plus the operational wake economics. Derived from `residency.*` audit rows joined to the
 * message log; diagnostic, never a score. Latency uses the message log as the "authenticated act"
 * proxy, consistent with the ADR 125 steering latency. Cost here is *operational wake spend* from
 * harness-reported totals — explicitly not the deferred cost-per-shipped-item seam.
 */
export const WakeMetricsSchema = z.object({
  window_days: z.number().int(),
  /** Distinct acts that produced at least one `residency.woke` in the window. */
  wakes: z.number().int(),
  /** Of those, resumed sessions (the fresh-first doctrine's upgrade axis). */
  resumed: z.number().int(),
  /** Failed actuations (`residency.wake_failed` rows — attempts, not distinct acts). */
  failed: z.number().int(),
  /** Deferred actuations (the local-session guard) — budget-neutral by construction. */
  deferred: z.number().int(),
  /** Acts declared terminally exhausted in the window. */
  exhausted: z.number().int(),
  /** Woken acts that reached `answered` in the delivery ledger (live read, not report-time). */
  answered: z.number().int(),
  /** answered / wakes; null when no wakes. */
  answer_rate: z.number().nullable(),
  /** Median directed-act→first-recipient-act latency over woken acts; null when unmeasurable. */
  latency_median_ms: z.number().nullable(),
  latency_p95_ms: z.number().nullable(),
  /** Sum/avg of attested wake spend; null when no cost was reported in the window. */
  cost_usd_total: z.number().nullable(),
  cost_usd_per_wake: z.number().nullable(),
  /** How many woke acts carried a cost — the honesty denominator for the averages. */
  cost_reported: z.number().int(),
  by_seat: z.array(WakeSeatCostSchema),
});
export type WakeMetrics = z.infer<typeof WakeMetricsSchema>;

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
  /** Interrupt-line metrics (ADR 125) — steering latency + stale-work-caught. */
  steering: SteeringMetricsSchema,
  /** Wake metrics (ADR 131 inc 5). Optional for back-compat with pre-inc-5 daemons — the server
   *  always sets it. */
  wake: WakeMetricsSchema.optional(),
  /** Tool-call telemetry (ADR 144 inc 1). Optional for back-compat with pre-inc-1 daemons — the
   *  server always sets it. */
  tool_calls: ToolCallMetricsSchema.optional(),
});
export type Report = z.infer<typeof ReportSchema>;
