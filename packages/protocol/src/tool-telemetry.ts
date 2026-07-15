import { z } from 'zod';

/**
 * Tool-call telemetry (ADR 144 increment 1): the adapter's batched report of its own MCP tool
 * invocations, plus the per-seat rendered-surface weight. This is the measure-then-craft
 * instrument — every later surface increment (renames, description rewrites, coercion) reads its
 * before/after from what lands here. Redaction posture (ADR 051): tool names, outcomes, and byte
 * counts only — never tool arguments or message bodies.
 */

/** The outcome classes the report engine aggregates by. `invalid_input` is the bounce class —
 * the harness's arguments failed the tool's input schema, so the handler never ran. */
export const TOOL_CALL_OUTCOMES = ['ok', 'error', 'invalid_input'] as const;
export const ToolCallOutcomeSchema = z.enum(TOOL_CALL_OUTCOMES);
export type ToolCallOutcome = z.infer<typeof ToolCallOutcomeSchema>;

/**
 * One accumulated (tool, outcome) cell of an adapter's flush window — a delta, not a total. Tool
 * calls are an order of magnitude chattier than coordination acts, so the adapter accumulates and
 * the server upserts hourly buckets (`tool_call_stats`); no row anywhere is one-per-call.
 */
export const ToolCallEventSchema = z.object({
  tool: z.string().min(1).max(64),
  outcome: ToolCallOutcomeSchema,
  /** Calls accumulated in this cell since the last flush. */
  calls: z.number().int().min(1),
  /** Wall-clock sum over those calls, in ms (transport-level: includes any deferred autojoin). */
  total_duration_ms: z.number().int().min(0),
  /** The slowest single call in the window, in ms. */
  max_duration_ms: z.number().int().min(0),
});
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

/** One tool's share of the rendered surface — for the inc-2 before/after on description rewrites. */
export const SurfaceToolWeightSchema = z.object({
  tool: z.string().min(1).max(64),
  /** The tool's full rendered listing entry (name + description + schemas), UTF-8 bytes. */
  bytes: z.number().int().min(0),
  /** The description region alone — the lever inc 2 moves. */
  description_bytes: z.number().int().min(0),
});
export type SurfaceToolWeight = z.infer<typeof SurfaceToolWeightSchema>;

/**
 * The rendered-surface weight: what this seat's `tools/list` actually weighs, measured once per
 * adapter session from the exact listing the harness receives. Lands as an append-only
 * `mcp.surface_rendered` audit row (the `residency.wake_cost` precedent — a measured cost the
 * ledger can carry), so the history survives for before/after evals.
 */
export const SurfaceRenderSchema = z.object({
  /** Tools rendered to this seat. */
  tools: z.number().int().min(0),
  /** Whole-listing weight in UTF-8 bytes. */
  bytes: z.number().int().min(0),
  /** Rough context cost (bytes / 4) — comparable across increments, not a billing figure. */
  est_tokens: z.number().int().min(0),
  breakdown: z.array(SurfaceToolWeightSchema).max(64).optional(),
});
export type SurfaceRender = z.infer<typeof SurfaceRenderSchema>;

/** `POST /teams/:slug/telemetry/tool-calls` — the adapter's periodic flush. The seat comes from
 * the authenticated request and the caller's role is stamped server-side at ingest (the
 * `from_provenance` rule: a caller cannot supply either). `surface` rides the first flush only. */
export const ToolTelemetryReportSchema = z.object({
  events: z.array(ToolCallEventSchema).max(256),
  surface: SurfaceRenderSchema.optional(),
});
export type ToolTelemetryReport = z.infer<typeof ToolTelemetryReportSchema>;

// ── Report-engine projections (`Report.tool_calls`) ────────────────────────────────────────────

/** One tool's aggregate over the report window — the "is it earning its bytes" row. */
export const ToolUsageRowSchema = z.object({
  tool: z.string(),
  calls: z.number().int(),
  /** Handler-level failures (in-band `error:` results and thrown errors). */
  errors: z.number().int(),
  /** Invalid-input bounces — the headline eval is this over calls. */
  bounces: z.number().int(),
  /** bounces / calls; null when the tool saw no calls in the window. */
  bounce_rate: z.number().nullable(),
  avg_duration_ms: z.number().nullable(),
  max_duration_ms: z.number().nullable(),
  /** Calls per caller role — "which tools does each role actually call". Unroled seats count
   * under `"unroled"`. */
  by_role: z.record(z.string(), z.number().int()),
});
export type ToolUsageRow = z.infer<typeof ToolUsageRowSchema>;

/** A seat's most recent attested rendered-surface weight (from `mcp.surface_rendered`). */
export const SeatSurfaceWeightSchema = z.object({
  seat: z.string(),
  ts: z.number().int(),
  tools: z.number().int(),
  bytes: z.number().int(),
  est_tokens: z.number().int(),
});
export type SeatSurfaceWeight = z.infer<typeof SeatSurfaceWeightSchema>;

/**
 * The tool-call block of the insight report (ADR 144 inc 1): per-tool usage/bounce/latency over
 * the window plus the latest rendered-surface weight per seat. Diagnostic instruments for the
 * surface redesign, never a score.
 */
export const ToolCallMetricsSchema = z.object({
  window_days: z.number().int(),
  calls: z.number().int(),
  bounces: z.number().int(),
  /** Sorted by calls, descending. */
  tools: z.array(ToolUsageRowSchema),
  /** Latest attested weight per seat (not window-bound — an attestation, like `presence.build`). */
  surface: z.array(SeatSurfaceWeightSchema),
});
export type ToolCallMetrics = z.infer<typeof ToolCallMetricsSchema>;
