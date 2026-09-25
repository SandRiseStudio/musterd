import { z } from 'zod';
import { HarnessIdSchema } from './provisioning.js';

/**
 * Agent-trace capture, rail R1 — the hook tap (ADR 445 §2, increment 1a). Every hook a harness fires
 * on a seat's session forwards one `TraceEvent` to the seat's own daemon, which stores it in
 * `trace.db` (a separate file beside `musterd.db`, ADR 445 §3). This is research substrate under
 * ADR 082, not a product surface: off unless a daemon runs the tap, and never leaving the machine
 * except through ADR 184's publication gate.
 *
 * **Structural only — by construction.** This module has no field for a tool's input, a tool's
 * response, a prompt, or an assistant message. Increment 1b adds the content part BEHIND the
 * credential scrub and the `trace.content` team setting; until then a client that sends one meets a
 * schema that strips it, so the row structurally cannot carry it. The session id never crosses
 * either: `session_digest` is the ADR 131 §5 keyed HMAC, same as the residency ledger.
 */

/**
 * The hook events of ADR 445 §2 R1, in Claude Code's spelling — the other harnesses' hook adapters
 * map their own names onto these (Codex `PostToolUse`, Cursor `postToolUse`/`afterShellExecution`,
 * Grok `Stop`), so one column reads the same across harnesses. `HookOutcome` is musterd recording
 * one of ITS OWN hooks (gate, interrupt probe, capture): which hook, its exit code and duration —
 * the harness's own hook spans are beta-gated and Claude-only, so the tap carries them itself.
 */
export const TRACE_EVENT_KINDS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Notification',
  'HookOutcome',
] as const;
export const TraceEventKindSchema = z.enum(TRACE_EVENT_KINDS);
export type TraceEventKind = z.infer<typeof TraceEventKindSchema>;

/** How the observed thing ended, when the hook knows. `denied` is a gate deny; `timeout` a hook
 *  that hit its own budget; `unknown` is honest absence, never defaulted to `ok`. */
export const TRACE_OUTCOMES = ['ok', 'error', 'denied', 'timeout', 'unknown'] as const;
export const TraceOutcomeSchema = z.enum(TRACE_OUTCOMES);
export type TraceOutcome = z.infer<typeof TraceOutcomeSchema>;

/** A seat's session, named the way the residency ledger names it (ADR 131 §5): the keyed, truncated
 *  HMAC of the harness session id. Equal across one session's events, irreversible without the
 *  workspace's agent key. */
export const SessionDigestSchema = z.string().regex(/^[0-9a-f]{8,32}$/);

/** Bounded structural detail — the small facts a kind carries that have no column of their own
 *  (`{hook, exit_code}` on a HookOutcome, `{trigger}` on a PreCompact, `{prompt_bytes}` on a
 *  UserPromptSubmit). Scalars only and capped in serialized size, so it cannot become the content
 *  column by another name. */
export const TRACE_DETAIL_MAX_BYTES = 1024;
export const TraceDetailSchema = z
  .record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean(), z.null()]))
  .refine((d) => Buffer.byteLength(JSON.stringify(d), 'utf8') <= TRACE_DETAIL_MAX_BYTES, {
    message: `detail exceeds ${TRACE_DETAIL_MAX_BYTES} bytes`,
  });

/**
 * One structural trace event. `seq` is NOT on the wire: the daemon assigns the monotonic sequence
 * per (team, session) on insert, because a hook is a one-shot process with no shared counter and a
 * client-assigned sequence would either collide or need a lock file per tool call.
 */
export const TraceEventSchema = z.object({
  /** The harness that fired the hook — the ADR 281 open, bounded id (`claude-code`, `codex`, …). */
  harness: HarnessIdSchema,
  session_digest: SessionDigestSchema,
  /** When the hook fired, epoch ms on the producing machine. */
  ts: z.number().int().min(0),
  kind: TraceEventKindSchema,
  /** The harness's tool name as fired (`Bash`, `Edit`, `mcp__musterd__team_send`) — a name, never
   *  its arguments. */
  tool_name: z.string().min(1).max(128).optional(),
  /** The harness's per-call id, the join key to rail R2's transcript record (ADR 445 §2). */
  tool_use_id: z.string().min(1).max(128).optional(),
  /** The subagent that made the call, when the hook envelope carries one (ADR 163). */
  agent_id: z.string().min(1).max(128).optional(),
  parent_agent_id: z.string().min(1).max(128).optional(),
  duration_ms: z.number().int().min(0).optional(),
  outcome: TraceOutcomeSchema.optional(),
  detail: TraceDetailSchema.optional(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

/** Hooks post one event at a time today; the cap is the ceiling a future batching tap may use. */
export const TRACE_MAX_BATCH = 256;

/** `POST /teams/:slug/trace/events` — the seat is the authenticated caller, never a body field. */
export const TraceEventBatchSchema = z.object({
  events: z.array(TraceEventSchema).min(1).max(TRACE_MAX_BATCH),
});
export type TraceEventBatch = z.infer<typeof TraceEventBatchSchema>;

/** Counts only. The tap is fire-and-forget; nothing downstream reads more than this. */
export const TraceIngestResponseSchema = z.object({
  accepted: z.number().int().min(0),
});
export type TraceIngestResponse = z.infer<typeof TraceIngestResponseSchema>;
