import { z } from 'zod';
import { HarnessIdSchema } from './provisioning.js';
import {
  SessionDigestSchema,
  TRACE_EVENT_KINDS,
  TraceEventKindSchema,
  TraceOutcomeSchema,
} from './trace.js';
import { scrubCredentials } from './traceScrub.js';

/**
 * The structural-only trace row, as it crosses joiner → hub (ADR 453 §2).
 *
 * Leaving the content field out of the wire schema is not enough: the local ingest schema
 * (`TraceEventSchema`) takes any `detail` key with a 256-character string, and the id fields are
 * free strings, so a buggy producer could carry prose or a credential in them and a named-column
 * SELECT would forward it. So every field here is typed such that prose cannot fit: closed enums,
 * counts, flags, digests, and one bounded identifier (`tool_name`) that is normalized against the
 * harness's own tool namespace. The same table drives `dataset:export`'s structural allowlist, so
 * the public dataset and the sync channel share ONE definition of "structural".
 *
 * Enforced three ways (ADR 453 §2): the hub REJECTS a non-conforming batch (400, nothing written);
 * the joiner's pusher NORMALIZES before sending (nulls a bad field, drops a bad key, maps an
 * unknown enum to `other`) so a legacy row cannot wedge the cursor; local ingest normalizes the
 * same way and never rejects, because a tap must not lose a row over one odd field.
 */

/** The accepted sentinel for a normalized unknown (big-body, on acceptance): the hub takes `other`
 *  as "a value the producer did not recognise" and refuses any other non-namespace value. */
export const TRACE_OTHER = 'other';

/** A structural detail value type. `count` is a non-negative safe integer; `flag` a boolean; `enum`
 *  a closed producer allowlist; `model` the one pattern-typed field (a lowercase model id). */
export type TraceDetailValueType =
  | { type: 'count' }
  | { type: 'flag' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'model' };

const count: TraceDetailValueType = { type: 'count' };
const flag: TraceDetailValueType = { type: 'flag' };
const en = (values: readonly string[]): TraceDetailValueType => ({ type: 'enum', values });

/** The hooks musterd records a `HookOutcome` for (ADR 445 1a tail). */
export const TRACE_HOOKS = ['gate', 'interrupt', 'capture'] as const;
/** The harness event names a tap maps onto the column's spelling (Cursor's, kept in `hook_event`). */
export const TRACE_HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'afterShellExecution',
  'afterMCPExecution',
  'stop',
  'subagentStart',
  'subagentStop',
  'preCompact',
] as const;
export const TRACE_DECISIONS = ['allow', 'deny'] as const;
/** Claude Code's `SessionStart.source` values. */
export const TRACE_SOURCES = ['startup', 'resume', 'clear', 'compact'] as const;
/** `SessionEnd.reason` (Claude Code) plus the tail's two downgrade reasons (ADR 445 §2). */
export const TRACE_REASONS = [
  'clear',
  'logout',
  'prompt_input_exit',
  'bypass_permissions_disabled',
  'transcript_truncated',
  'parse_failure',
] as const;
export const TRACE_TRIGGERS = ['manual', 'auto'] as const;
/** The transcript parsers, version-stamped (ADR 445 §2): exactly what `cli trace/transcript.ts` stamps. */
export const TRACE_PARSERS = ['claude-code@1', 'codex@1'] as const;
/** Transcript record types the parsers emit as `unknown` (measured 2026-09-26 + the harness's
 *  documented families). A new one is added here in the change that starts emitting it. */
export const TRACE_UNKNOWN_TYPES = [
  'queue-operation',
  'pr-link',
  'cost-state',
  'file-history-delta',
  'summary',
  'system',
  'attachment',
  'progress',
  'last-prompt',
  'response_item.function_call',
  'response_item.function_call_output',
  'response_item.custom_tool_call',
  'response_item.custom_tool_call_output',
  'response_item.message',
  'response_item.reasoning',
  'response_item.web_search_call',
  'response_item.local_shell_call',
  'response_item.local_shell_call_output',
] as const;
/** Claude Code's built-in subagent types; a custom agent name normalizes to `other`. */
export const TRACE_AGENT_TYPES = ['Explore', 'Plan', 'general-purpose', 'fork'] as const;

/** The lowercase model-id shape. Every `TOKEN_PREFIXES` credential contains `_`, so none can match;
 *  `traceSync.test.ts` asserts that for every registered prefix. */
export const TRACE_MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** One key's type, shared by every kind that carries it. */
const DETAIL_TYPES: Record<string, TraceDetailValueType> = {
  prompt_bytes: count,
  tool_input_bytes: count,
  tool_response_bytes: count,
  error_bytes: count,
  assistant_bytes: count,
  reasoning_bytes: count,
  bytes: count,
  exit_code: count,
  suppressed: count,
  input_tokens: count,
  output_tokens: count,
  cache_read_tokens: count,
  cache_creation_tokens: count,
  reasoning_tokens: count,
  total_tokens: count,
  tool_uses: count,
  raised: flag,
  deaf: flag,
  encrypted: flag,
  stop_hook_active: flag,
  downgraded: flag,
  parse_error: flag,
  hook: en(TRACE_HOOKS),
  hook_event: en(TRACE_HOOK_EVENTS),
  decision: en(TRACE_DECISIONS),
  source: en(TRACE_SOURCES),
  reason: en(TRACE_REASONS),
  trigger: en(TRACE_TRIGGERS),
  parser: en(TRACE_PARSERS),
  type: en(TRACE_UNKNOWN_TYPES),
  agent_type: en(TRACE_AGENT_TYPES),
  model: { type: 'model' },
};

const HOOK_COMMON = ['hook_event', 'tool_input_bytes', 'tool_response_bytes', 'error_bytes'];
const R2_COMMON = ['parser'];

/**
 * Which `detail` keys each kind may carry (ADR 453 §2) — the set the taps and parsers write today,
 * measured on the dogfood trace store on 2026-09-26. A key not listed for its kind is dropped.
 */
export const TRACE_DETAIL_KEYS_BY_KIND: Record<
  (typeof TRACE_EVENT_KINDS)[number],
  readonly string[]
> = {
  SessionStart: ['hook_event', 'source'],
  SessionEnd: ['hook_event', 'reason'],
  UserPromptSubmit: ['hook_event', 'prompt_bytes'],
  PreToolUse: [...HOOK_COMMON, 'matcher_bytes'],
  PostToolUse: HOOK_COMMON,
  PostToolUseFailure: HOOK_COMMON,
  Stop: ['hook_event', 'assistant_bytes', 'stop_hook_active'],
  SubagentStart: ['hook_event', 'agent_type'],
  SubagentStop: ['hook_event', 'assistant_bytes', 'stop_hook_active', 'agent_type'],
  PreCompact: ['hook_event', 'trigger'],
  Notification: ['hook_event'],
  HookOutcome: ['hook', 'exit_code', 'decision', 'raised', 'deaf'],
  reasoning: [...R2_COMMON, 'reasoning_bytes', 'encrypted'],
  assistant_text: [...R2_COMMON, 'assistant_bytes'],
  usage: [
    ...R2_COMMON,
    'model',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
    'reasoning_tokens',
    'total_tokens',
    'tool_uses',
  ],
  unknown: [...R2_COMMON, 'bytes', 'type', 'suppressed', 'downgraded', 'reason', 'parse_error'],
};

/** Every structural detail key, across kinds — what `dataset:export` allowlists. */
export const TRACE_STRUCTURAL_DETAIL_KEYS: ReadonlySet<string> = new Set(
  Object.values(TRACE_DETAIL_KEYS_BY_KIND).flat(),
);

function valueSchema(t: TraceDetailValueType): z.ZodTypeAny {
  switch (t.type) {
    case 'count':
      return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
    case 'flag':
      return z.boolean();
    case 'enum':
      return z.enum([TRACE_OTHER, ...t.values] as [string, ...string[]]);
    case 'model':
      return z.string().regex(TRACE_MODEL_RE);
  }
}

/** The closed, per-kind `detail` schema: each listed key with its one type, no others. */
export function traceStructuralDetailSchema(kind: (typeof TRACE_EVENT_KINDS)[number]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const key of TRACE_DETAIL_KEYS_BY_KIND[kind]) {
    const t = DETAIL_TYPES[key];
    if (t) shape[key] = valueSchema(t).optional();
  }
  return z.object(shape).strict();
}

/**
 * Normalize a stored/observed detail object to its kind's structural shape — the pusher's and
 * local ingest's move (never reject). A key outside the kind's list is dropped; a count/flag of the
 * wrong type is dropped; an enum value not on the list becomes `other`; a model id that fails the
 * pattern is dropped. Returns the shape plus how many values were changed or removed.
 */
export function normalizeTraceDetail(
  kind: (typeof TRACE_EVENT_KINDS)[number],
  detail: Record<string, unknown> | null | undefined,
): { detail: Record<string, string | number | boolean> | null; normalized: number } {
  if (!detail || typeof detail !== 'object') return { detail: null, normalized: 0 };
  const allowed = TRACE_DETAIL_KEYS_BY_KIND[kind];
  const out: Record<string, string | number | boolean> = {};
  let normalized = 0;
  for (const [key, v] of Object.entries(detail)) {
    const t = allowed.includes(key) ? DETAIL_TYPES[key] : undefined;
    if (!t) {
      normalized++;
      continue;
    }
    switch (t.type) {
      case 'count':
        if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) out[key] = v;
        else normalized++;
        break;
      case 'flag':
        if (typeof v === 'boolean') out[key] = v;
        else normalized++;
        break;
      case 'enum':
        if (typeof v === 'string' && t.values.includes(v)) out[key] = v;
        else if (typeof v === 'string' && v === TRACE_OTHER) out[key] = v;
        else {
          out[key] = TRACE_OTHER;
          normalized++;
        }
        break;
      case 'model':
        if (typeof v === 'string' && TRACE_MODEL_RE.test(v)) out[key] = v;
        else normalized++;
        break;
    }
  }
  return { detail: Object.keys(out).length > 0 ? out : null, normalized };
}

// ── tool_name: a name, bounded to the harness's own namespace ──────────────────────────────────

/** One token, no whitespace, quotes or slashes — the outer bound on any tool name. */
export const TRACE_TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** An MCP tool as the harnesses spell it: `mcp__<server>__<tool>`. Server segments carry `_` and
 *  `-` in the wild (`codex_apps`, `plugin_chrome-devtools-mcp_chrome-devtools`). */
export const TRACE_MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

/**
 * Each harness's built-in tool names — the values measured on the dogfood store 2026-09-26 plus
 * the harness's documented set. A name outside the list that is not an `mcp__…` tool normalizes
 * to `other`. A new built-in is added here in the change that starts emitting it.
 */
export const TRACE_TOOL_NAMESPACES: Record<string, readonly string[]> = {
  'claude-code': [
    'Agent',
    'Artifact',
    'ArtifactComments',
    'ArtifactData',
    'AskUserQuestion',
    'Bash',
    'BashOutput',
    'CronCreate',
    'CronDelete',
    'CronList',
    'DesignSync',
    'Edit',
    'EndConversation',
    'EnterPlanMode',
    'EnterWorktree',
    'ExitPlanMode',
    'ExitWorktree',
    'FetchInboxMessage',
    'Glob',
    'Grep',
    'KillShell',
    'LS',
    'ListAgents',
    'ListMcpResourcesTool',
    'Monitor',
    'MultiEdit',
    'NotebookEdit',
    'PushNotification',
    'Read',
    'ReadMcpResourceDirTool',
    'ReadMcpResourceTool',
    'ReadNotifications',
    'RemoteTrigger',
    'ReportFindings',
    'ScheduleWakeup',
    'SendFeedback',
    'SendMessage',
    'SendUserFile',
    'Skill',
    'SlashCommand',
    'SubagentHandback',
    'Task',
    'TaskStop',
    'TodoRead',
    'TodoWrite',
    'ToolSearch',
    'WebFetch',
    'WebSearch',
    'Workflow',
    'Write',
  ],
  codex: [
    'Bash',
    'Shell',
    'apply_patch',
    'exec_command',
    'write_stdin',
    'update_plan',
    'view_image',
    'web_search',
    'webrun',
    'clocksleep',
    'clockcurr_time',
  ],
  cursor: [
    'Bash',
    'Shell',
    'Read',
    'Write',
    'Edit',
    'Delete',
    'Grep',
    'Glob',
    'Search',
    'ListDir',
    'WebSearch',
    'WebFetch',
    'Task',
    'Todo',
  ],
  grok: [
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'glob',
    'grep',
    'list_dir',
    'web_search',
    'browse',
  ],
};

/**
 * A tool name in the harness's namespace, or `other` (ADR 453 §2). `null` in → `null` out (an
 * event with no tool has no name to normalize). The precise claim the hub can make: `tool_name`
 * carries at most a single-token identifier from the harness's own namespace.
 */
export function structuralToolName(
  harness: string,
  name: string | null | undefined,
): { name: string | null; normalized: boolean } {
  if (name === null || name === undefined || name === '') return { name: null, normalized: false };
  if (!TRACE_TOOL_NAME_RE.test(name)) return { name: TRACE_OTHER, normalized: true };
  if (name === TRACE_OTHER) return { name, normalized: false };
  if (TRACE_MCP_TOOL_RE.test(name)) return { name, normalized: false };
  const ns = TRACE_TOOL_NAMESPACES[harness];
  if (ns?.includes(name)) return { name, normalized: false };
  return { name: TRACE_OTHER, normalized: true };
}

/** The wire-side check the hub runs: in the namespace, an MCP tool, or exactly `other`. */
export function isStructuralToolName(harness: string, name: string): boolean {
  return structuralToolName(harness, name).normalized === false && TRACE_TOOL_NAME_RE.test(name);
}

// ── the wire ───────────────────────────────────────────────────────────────────────────────────

/** A ULID, as `ingestTraceEvents` mints row ids. */
export const TraceRowIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
/** An opaque harness id as it crosses: a keyed digest, 24 hex characters, never the raw id. */
export const TraceIdDigestSchema = z.string().regex(/^[0-9a-f]{24}$/);
export const TRACE_ID_DIGEST_LEN = 24;
/** A seat name on the wire (resolved to a member at the hub, §3). */
export const TraceSeatNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);

const nonNegInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * One structural row on the wire. `detail` is validated per kind by {@link SyncTraceRowSchema}'s
 * superRefine, since zod cannot express "this key set depends on that field" in one object.
 */
export const SyncTraceRowSchema = z
  .object({
    id: TraceRowIdSchema,
    seat: TraceSeatNameSchema,
    session_digest: SessionDigestSchema,
    seq: nonNegInt,
    ts: nonNegInt,
    received_at: nonNegInt,
    harness: HarnessIdSchema,
    kind: TraceEventKindSchema,
    tool_name: z.string().regex(TRACE_TOOL_NAME_RE).nullable(),
    tool_use_id: TraceIdDigestSchema.nullable(),
    agent_id: TraceIdDigestSchema.nullable(),
    parent_agent_id: TraceIdDigestSchema.nullable(),
    duration_ms: nonNegInt.nullable(),
    outcome: TraceOutcomeSchema.nullable(),
    detail: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    // The credential detector at the wire (ADR 453 §2): every string field, whatever its pattern
    // already excludes. A seat name or tool name that the scrub would redact is refused outright.
    for (const field of ['seat', 'tool_name'] as const) {
      const v = row[field];
      if (typeof v === 'string' && scrubCredentials(v).redactions > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} carries a credential-shaped value`,
        });
      }
    }
    if (row.tool_name !== null && !isStructuralToolName(row.harness, row.tool_name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tool_name'],
        message: `tool_name is not in the ${row.harness} namespace (normalize to "${TRACE_OTHER}")`,
      });
    }
    if (row.detail !== null) {
      const r = traceStructuralDetailSchema(row.kind).safeParse(row.detail);
      if (!r.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['detail'],
          message: `detail is not structural for kind ${row.kind}: ${r.error.issues[0]?.message ?? ''}`,
        });
      }
    }
  });
export type SyncTraceRow = z.infer<typeof SyncTraceRowSchema>;

export const SYNC_TRACE_MAX_BATCH = 1000;

/** `POST /teams/:slug/sync/trace` — the joiner's `msnode_` is the caller; rows name their seats. */
export const SyncTracePushRequestSchema = z
  .object({
    rows: z.array(SyncTraceRowSchema).min(1).max(SYNC_TRACE_MAX_BATCH),
  })
  .strict();
export type SyncTracePushRequest = z.infer<typeof SyncTracePushRequestSchema>;

/** Per-row refusal codes: the seat is bound to another node (ADR 360, per row on this surface). */
export const SYNC_TRACE_REFUSAL_CODES = ['bound_elsewhere'] as const;

export const SyncTracePushResponseSchema = z.object({
  /** New rows written. */
  accepted: z.number().int().min(0),
  /** Rows the hub already held under the same `id` — a re-push. */
  ignored: z.number().int().min(0),
  /** Rows that hit `UNIQUE (team, session_digest, seq)` under a DIFFERENT id — a digest collision,
   *  counted apart so it cannot hide inside the re-push count. */
  collided: z.number().int().min(0),
  /** Rows refused one by one; the batch went on and the cursor advances past them. */
  refused: z.array(z.object({ id: TraceRowIdSchema, code: z.enum(SYNC_TRACE_REFUSAL_CODES) })),
});
export type SyncTracePushResponse = z.infer<typeof SyncTracePushResponseSchema>;

/** The batch-holding refusals (409): transient, the pusher retries the same batch next tick. */
export const SYNC_TRACE_HOLD_REASONS = ['unresolved_seat', 'unbound_seat'] as const;
export type SyncTraceHoldReason = (typeof SYNC_TRACE_HOLD_REASONS)[number];
