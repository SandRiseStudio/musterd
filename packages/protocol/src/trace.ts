import { z } from 'zod';
import { HarnessIdSchema } from './provisioning.js';

/**
 * Agent-trace capture, rail R1 — the hook tap (ADR 445 §2, increment 1a). Every hook a harness fires
 * on a seat's session forwards one `TraceEvent` to the seat's own daemon, which stores it in
 * `trace.db` (a separate file beside `musterd.db`, ADR 445 §3). This is research substrate under
 * ADR 082, not a product surface: off unless a daemon runs the tap, and never leaving the machine
 * except through ADR 184's publication gate.
 *
 * **Structural by default.** The top-level fields are names, ids, kinds, timings and sizes. What a
 * hook actually saw — a tool's input and output, a prompt, an assistant message — lives only in the
 * optional `content` part (increment 1b), which exists on the wire only behind the credential scrub
 * and the team's `trace.content` policy. The session id never crosses
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
  // Rail R2, the transcript tail (ADR 445 §2, increment 2) — lowercase on purpose: these are
  // transcript records the tail parsed, not hook events a harness fired, and the spelling is what
  // keeps the two rails apart in one column. `unknown` is the tolerance contract: a record the
  // parser does not recognise is emitted with its size, never dropped silently.
  'reasoning',
  'assistant_text',
  'usage',
  'unknown',
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
 * The content part (ADR 445 §3, increment 1b) — what a hook saw, not just its shape. Every string
 * here has been through `scrubCredentials` (`traceScrub.ts`) at the hook before it was posted, and goes through
 * it again at ingest; `redactions` is the hook's count. Bounded as a whole to
 * {@link TRACE_CONTENT_MAX_BYTES} (the wake transcript bound, ADR 445 §3), with `truncated` set when
 * the hook had to cut. Sent only when the team's `trace.content` policy is `on` and the daemon is on
 * this machine; written only when the daemon's own read of that policy agrees. Structured values
 * (a tool's input object) travel as their JSON text.
 */
export const TRACE_CONTENT_MAX_BYTES = 262_144;
export const TRACE_CONTENT_FIELDS = [
  'prompt',
  'tool_input',
  'tool_response',
  'error',
  'assistant',
  'reasoning',
] as const;
export type TraceContentField = (typeof TRACE_CONTENT_FIELDS)[number];
export const TraceContentSchema = z
  .object({
    prompt: z.string().optional(),
    tool_input: z.string().optional(),
    tool_response: z.string().optional(),
    error: z.string().optional(),
    /** Claude Code's `last_assistant_message` on Stop / SubagentStop; a transcript `assistant_text`
     *  record's text on rail R2. */
    assistant: z.string().optional(),
    /** Rail R2 only (increment 2): the text of a `reasoning` transcript record — Claude Code's
     *  `thinking` blocks, Codex's reasoning summaries. Hooks never carry this field. */
    reasoning: z.string().optional(),
    redactions: z.number().int().min(0),
    truncated: z.boolean(),
  })
  .refine(
    (c) =>
      TRACE_CONTENT_FIELDS.reduce(
        (n, f) => n + (c[f] === undefined ? 0 : Buffer.byteLength(c[f], 'utf8')),
        0,
      ) <= TRACE_CONTENT_MAX_BYTES,
    { message: `content exceeds ${TRACE_CONTENT_MAX_BYTES} bytes` },
  );
export type TraceContent = z.infer<typeof TraceContentSchema>;

/**
 * The team's trace policy (ADR 445 §3–§4), stored under `policy.trace`. `content: off` (the default)
 * means the content column is never written; structural rows are recorded either way.
 */
export const TRACE_CONTENT_MODES = ['off', 'on'] as const;
export const TracePolicySchema = z.object({
  content: z.enum(TRACE_CONTENT_MODES).default('off'),
});
export type TracePolicy = z.infer<typeof TracePolicySchema>;

/**
 * Where a workspace caches the content mode its daemon last replied with — `.musterd/<this>`,
 * beside the binding. Written by the CLI's tap, read by the tap and by both `traced:` lines.
 */
export const TRACE_POLICY_FILE = 'trace-policy.json';

/**
 * Where the transcript tail (rail R2, increment 2) keeps its per-session read cursor —
 * `.musterd/<this>`, beside the binding. One JSON object, sessions keyed by digest; machine-local
 * and disposable, never committed (it names transcript paths on this machine).
 */
export const TRACE_TAIL_FILE = 'trace-tail.json';

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
  /** Increment 1b — present only when the tap was told content is on (see TraceContentSchema). */
  content: TraceContentSchema.optional(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

/** Hooks post one event at a time today; the cap is the ceiling a future batching tap may use. */
export const TRACE_MAX_BATCH = 256;

/** `POST /teams/:slug/trace/events` — the seat is the authenticated caller, never a body field. */
export const TraceEventBatchSchema = z.object({
  events: z.array(TraceEventSchema).min(1).max(TRACE_MAX_BATCH),
});
export type TraceEventBatch = z.infer<typeof TraceEventBatchSchema>;

/**
 * Counts, plus the team's content mode — which is how a tap learns the policy with no extra round
 * trip: it caches this beside the binding and sends content from the next hook on. A daemon before
 * 1b omits `content`, which a tap reads as `off`.
 */
export const TraceIngestResponseSchema = z.object({
  accepted: z.number().int().min(0),
  content: z.enum(TRACE_CONTENT_MODES).optional(),
});
export type TraceIngestResponse = z.infer<typeof TraceIngestResponseSchema>;

/**
 * One stored row of a session's trace, as `GET /teams/:slug/trace/sessions/:digest` returns it
 * (increment 2, the read behind `musterd trace show`). Deliberately looser than
 * {@link TraceEventSchema}: rows were written by whatever tap and daemon existed at the time, and a
 * reader renders history — it must not refuse a row an older (or newer) writer stored. `content` is
 * the stored fields object; present only for the caller ADR 128 scopes it to.
 */
export const TraceSessionEventSchema = z.object({
  seq: z.number().int().min(0),
  ts: z.number().int().min(0),
  received_at: z.number().int().min(0),
  seat: z.string(),
  harness: z.string(),
  kind: z.string(),
  tool_name: z.string().nullish(),
  tool_use_id: z.string().nullish(),
  agent_id: z.string().nullish(),
  parent_agent_id: z.string().nullish(),
  duration_ms: z.number().nullish(),
  outcome: z.string().nullish(),
  detail: z.record(z.string(), z.unknown()).nullish(),
  content: z.record(z.string(), z.unknown()).nullish(),
  redactions: z.number().nullish(),
  truncated: z.boolean(),
  /** When the 30-day content lifecycle nulled `content` (ADR 445 increment 3a); absent from a daemon
   *  before it, null while content is live or was never captured. */
  content_pruned_at: z.number().int().min(0).nullish(),
});
export type TraceSessionEvent = z.infer<typeof TraceSessionEventSchema>;
export const TraceSessionResponseSchema = z.object({
  events: z.array(TraceSessionEventSchema),
});
export type TraceSessionResponse = z.infer<typeof TraceSessionResponseSchema>;
