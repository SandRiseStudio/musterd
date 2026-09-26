import { z } from 'zod';

/**
 * `musterd report trace` (ADR 445 increment 4, human-gated; opened 2026-09-26). Three views over
 * `trace_events`' structural columns — never content — as `GET /teams/:slug/report/trace` returns
 * them. ADR 128 scoping applies: an admin sees every seat; a seat sees only its own rows, so the
 * numbers a non-admin reads are its own.
 */

/** ADR 445 §Observability's coverage eval, per harness: R1 `PostToolUse` rows over the tool calls
 *  R2's `usage` rows say happened. Null ratio = R2 saw no tool calls (nothing to divide by). */
export const TraceCoverageRowSchema = z.object({
  harness: z.string(),
  sessions: z.number().int().min(0),
  /** Sessions carrying at least one R2 (transcript) row. */
  sessions_with_r2: z.number().int().min(0),
  post_tool_use: z.number().int().min(0),
  /** Sum of `usage.tool_uses` — R2's count of tool calls the model made. */
  r2_tool_uses: z.number().int().min(0),
  coverage: z.number().min(0).nullable(),
});

export const TraceToolMixRowSchema = z.object({
  harness: z.string(),
  tool: z.string(),
  calls: z.number().int().min(0),
  errors: z.number().int().min(0),
  avg_duration_ms: z.number().int().min(0).nullable(),
});

/** Tokens a seat spent while a lane was its open work (`usage` rows inside the claim window). */
export const TraceLaneCostRowSchema = z.object({
  lane: z.string(),
  title: z.string(),
  state: z.string(),
  seat: z.string(),
  goal_id: z.string().nullable(),
  turns: z.number().int().min(0),
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_read_tokens: z.number().int().min(0),
});

export const TraceReportSchema = z.object({
  window_days: z.number().int().min(1),
  /** Seats the caller could read (all, or just their own — ADR 128). */
  seats: z.array(z.string()),
  coverage: z.array(TraceCoverageRowSchema),
  tool_mix: z.array(TraceToolMixRowSchema),
  lane_cost: z.array(TraceLaneCostRowSchema),
  /** `usage` rows that fell in no lane's window for their seat — shown, never folded in. */
  unattributed: z.object({
    turns: z.number().int().min(0),
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    cache_read_tokens: z.number().int().min(0),
  }),
});
export type TraceReport = z.infer<typeof TraceReportSchema>;

export const TRACE_REPORT_MAX_DAYS = 90;
export const TRACE_REPORT_DEFAULT_DAYS = 7;
export const TRACE_TOOL_MIX_TOP = 15;
