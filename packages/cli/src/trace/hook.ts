import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Binding,
  bindingSeat,
  scrubCredentials,
  scrubToText,
  TRACE_CONTENT_FIELDS,
  TRACE_CONTENT_MAX_BYTES,
  TRACE_DETAIL_MAX_BYTES,
  TRACE_POLICY_FILE,
  type TraceContent,
  type TraceContentField,
  type TraceEvent,
  TraceEventKindSchema,
  type TraceEventKind,
  TraceEventSchema,
} from '@musterd/protocol';
import { resolveWorkspaceKey } from '@musterd/protocol/project';
import { fmtBytes } from '../args.js';
import { HttpClient } from '../client.js';
import { resolveClaimWorkspace } from '../commands/helpers.js';
import { isLoopbackServer } from '../host/registry.js';
import { sessionDigest } from '../session/digest.js';

/**
 * Rail R1, the hook tap — the client half (ADR 445 §2, increment 1a). Turns a harness hook payload
 * into one structural `TraceEvent` and posts it to the seat's daemon, fire-and-forget.
 *
 * Three properties are load-bearing and each is enforced by construction, not by care:
 *
 * - **Structural by default; content only behind three gates.** {@link parseTraceHook} reads names,
 *   ids, kinds and sizes. The content part (increment 1b) is read only when the team's
 *   `trace.content` is `on` (learned from the daemon's last ingest reply, cached beside the
 *   binding), the daemon is this machine's own (loopback), and every string has been through the
 *   credential scrub — in that order, before anything leaves this process.
 * - **The session id never crosses.** The event carries `sessionDigest(agent_key, session_id)`, the
 *   same keyed HMAC the residency ledger uses (ADR 131 §5), so a trace joins a wake and a residency
 *   row without either side holding the raw id.
 * - **Fail-open and bounded.** {@link emitTraceEvents} races the POST against a short budget and
 *   swallows every outcome. A hook that can slow or fail the tool call it observes is a regression,
 *   not an instrument (ADR 150's guard metric); an unreachable daemon costs one bounded wait and a
 *   dropped event, never a failed call.
 */

/** The structural view of one harness hook payload — what the tap is allowed to know. */
export interface ParsedTraceHook {
  kind: TraceEventKind;
  session_id: string;
  /** The harness the payload's own spelling names, when it names one ({@link inferTraceHarness}). */
  harness?: string;
  tool_name?: string;
  tool_use_id?: string;
  agent_id?: string;
  parent_agent_id?: string;
  outcome?: TraceEvent['outcome'];
  detail?: NonNullable<TraceEvent['detail']>;
  /** Only when the caller asked for content — already scrubbed and bounded. */
  content?: TraceContent;
}

/** Fields whose SIZE is structural and whose CONTENT is not — recorded as `<name>_bytes` only. */
const SIZED_FIELDS: Record<string, string> = {
  prompt: 'prompt_bytes',
  tool_input: 'tool_input_bytes',
  tool_response: 'tool_response_bytes',
  error: 'error_bytes',
  last_assistant_message: 'assistant_bytes',
};

/** Small enumerated facts a kind carries that are safe to keep verbatim (bounded, non-prose). */
const ENUM_FIELDS: readonly string[] = ['trigger', 'source', 'reason', 'agent_type', 'matcher'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Cursor's hook events, onto the Claude Code spelling the column uses (ADR 445 §2 R1). Cursor fires
 * `afterShellExecution` / `afterMCPExecution` beside (and on cursor-agent, instead of) `postToolUse`,
 * so all three record as `PostToolUse` — the source name rides in `detail.hook_event`, which is what
 * lets a reader de-duplicate an IDE session that fired two of them for one call.
 */
const CURSOR_KINDS: Record<string, TraceEventKind> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  afterShellExecution: 'PostToolUse',
  afterMCPExecution: 'PostToolUse',
  stop: 'Stop',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  preCompact: 'PreCompact',
};

/**
 * Which harness a payload's spelling names — the same field-name rule `session start` has used since
 * ADR 352: Grok writes `sessionId` / `hookEventName`, Cursor writes `conversation_id`. Claude Code and
 * Codex share a spelling, so a Claude-shaped payload names no harness and the caller's word (or the
 * `claude-code` default) stands. Needed where the hook process cannot tell from its env which harness
 * spawned it — the gate on Grok, measured recording `claude-code` before this.
 */
export function inferTraceHarness(o: Record<string, unknown>): string | undefined {
  if (str(o['sessionId']) || str(o['hookEventName'])) return 'grok';
  if (str(o['conversation_id'])) return 'cursor';
  return undefined;
}

/** Where a payload keeps each content field: the Claude Code / Codex names, then Cursor's shell and
 *  MCP event names (`command` / `output` / `result_json` are top-level only on Cursor's events). */
const CONTENT_SOURCES: Record<TraceContentField, readonly string[]> = {
  prompt: ['prompt'],
  tool_input: ['tool_input', 'toolInput', 'command'],
  tool_response: ['tool_response', 'toolResponse', 'output', 'result_json'],
  error: ['error'],
  assistant: ['last_assistant_message'],
  // Rail R2 only (increment 2): no hook payload carries reasoning — the transcript tail does.
  reasoning: [],
};

/** Cut a string to at most `max` UTF-8 bytes without leaving half a character behind. */
function cutBytes(s: string, max: number): string {
  return Buffer.from(s, 'utf8')
    .subarray(0, max)
    .toString('utf8')
    .replace(/\uFFFD+$/, '');
}

/**
 * The content part of a hook payload — scrubbed, then bounded (ADR 445 §3). The scrub runs on each
 * field BEFORE the cut, so a credential can never survive by being split across the bound. A field
 * far over the bound is first pre-cut at twice it (the scrub is a regex pass, and a 50 MB tool
 * response must not cost the tool call it rides on); what the pre-cut discards lies past the final
 * bound anyway. The fields share one budget, in {@link TRACE_CONTENT_FIELDS} order. Returns
 * undefined when the payload carries no content field at all.
 */
export function extractTraceContent(o: Record<string, unknown>): TraceContent | undefined {
  let budget = TRACE_CONTENT_MAX_BYTES;
  let redactions = 0;
  let truncated = false;
  const out: Partial<Record<TraceContentField, string>> = {};
  for (const field of TRACE_CONTENT_FIELDS) {
    const source = CONTENT_SOURCES[field].find((k) => o[k] !== undefined && o[k] !== null);
    if (source === undefined) continue;
    const v = o[source];
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    // Normally the leaves are scrubbed before the value is stringified (scrubToText — the scrub
    // sees real newlines, not `\n` escapes). Over twice the bound, the JSON text is pre-cut and
    // scrubbed as text instead; the scrub's escape-aware boundary is what covers that path.
    let scrubbed;
    if (text.length > 2 * TRACE_CONTENT_MAX_BYTES) {
      scrubbed = scrubCredentials(text.slice(0, 2 * TRACE_CONTENT_MAX_BYTES));
      truncated = true;
    } else {
      scrubbed = scrubToText(v);
    }
    redactions += scrubbed.redactions;
    let kept = scrubbed.text;
    if (Buffer.byteLength(kept, 'utf8') > budget) {
      kept = cutBytes(kept, budget);
      truncated = true;
    }
    budget -= Buffer.byteLength(kept, 'utf8');
    out[field] = kept;
  }
  if (Object.keys(out).length === 0) return undefined;
  return { ...out, redactions, truncated };
}

/**
 * Parse a Claude Code-shaped hook payload (the other harnesses' adapters normalize into this shape
 * before calling). `kind` overrides the payload's `hook_event_name` — for a hook that knows which
 * event registered it better than the payload does (the gate is always PreToolUse). Returns null
 * when there is nothing to record: no session id, or an event kind the tap does not know.
 */
export function parseTraceHook(
  raw: string,
  kind?: TraceEventKind,
  opts: { content?: boolean } = {},
): ParsedTraceHook | null {
  let o: Record<string, unknown>;
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== 'object' || json === null) return null;
    o = json as Record<string, unknown>;
  } catch {
    return null;
  }
  const sessionId = str(o['session_id']) ?? str(o['sessionId']) ?? str(o['conversation_id']);
  if (!sessionId) return null;
  const sourceEvent = str(o['hook_event_name']) ?? str(o['hookEventName']);
  const kindParsed = TraceEventKindSchema.safeParse(
    kind ?? (sourceEvent ? (CURSOR_KINDS[sourceEvent] ?? sourceEvent) : undefined),
  );
  if (!kindParsed.success) return null;
  const k = kindParsed.data;

  const detail: Record<string, string | number | boolean | null> = {};
  for (const [field, name] of Object.entries(SIZED_FIELDS)) {
    const v = o[field];
    if (v === undefined || v === null) continue;
    detail[name] = Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
  }
  for (const field of ENUM_FIELDS) {
    const v = str(o[field]);
    if (v) detail[field] = v.slice(0, 64);
  }
  if (typeof o['stop_hook_active'] === 'boolean')
    detail['stop_hook_active'] = o['stop_hook_active'];
  if (sourceEvent && sourceEvent !== k) detail['hook_event'] = sourceEvent.slice(0, 64);

  const out: ParsedTraceHook = { kind: k, session_id: sessionId };
  const inferred = inferTraceHarness(o);
  if (inferred) out.harness = inferred;
  const tool = str(o['tool_name']) ?? str(o['toolName']);
  if (tool) out.tool_name = tool.slice(0, 128);
  const toolUse = str(o['tool_use_id']) ?? str(o['toolUseId']);
  if (toolUse) out.tool_use_id = toolUse.slice(0, 128);
  const agent = str(o['agent_id']) ?? str(o['subagent_id']);
  if (agent) out.agent_id = agent.slice(0, 128);
  const parent = str(o['parent_agent_id']);
  if (parent) out.parent_agent_id = parent.slice(0, 128);
  if (k === 'PostToolUse') out.outcome = 'ok';
  if (k === 'PostToolUseFailure') out.outcome = 'error';
  if (Object.keys(detail).length > 0) {
    // Keep the detail inside the wire bound even for a payload with every sized field present:
    // drop enum fields first, then sizes, rather than let the schema refuse the whole event.
    while (Buffer.byteLength(JSON.stringify(detail), 'utf8') > TRACE_DETAIL_MAX_BYTES) {
      const key = Object.keys(detail).pop();
      if (!key) break;
      delete detail[key];
    }
    if (Object.keys(detail).length > 0) out.detail = detail;
  }
  if (opts.content) {
    const content = extractTraceContent(o);
    if (content) out.content = content;
  }
  return out;
}

/**
 * Build the wire event for a parsed hook. Needs the binding for the digest key and returns null
 * when the workspace has no agent key (an unbound folder traces nothing — there is no seat to
 * attribute to) or the result somehow fails its own schema (belt and braces: the daemon parses too).
 */
export function buildTraceEvent(
  binding: Binding,
  parsed: ParsedTraceHook,
  harness: string,
  now: number = Date.now(),
): TraceEvent | null {
  if (!binding.agent_key) return null;
  const { session_id, harness: _inferred, ...rest } = parsed;
  const candidate = {
    harness,
    session_digest: sessionDigest(binding.agent_key, session_id),
    ts: now,
    ...rest,
  };
  const ok = TraceEventSchema.safeParse(candidate);
  if (ok.success) return ok.data;
  // A content part the schema refuses must not cost the structural row it rode on.
  if (candidate.content === undefined) return null;
  const { content: _dropped, ...structural } = candidate;
  const retry = TraceEventSchema.safeParse(structural);
  return retry.success ? retry.data : null;
}

/** The seat's own kill switch for the tap (ADR 445 §4): `MUSTERD_NO_TRACE=1` traces nothing. */
export function traceTapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MUSTERD_NO_TRACE'] !== '1';
}

/**
 * The team's `trace.content` as this workspace last heard it from its daemon. `off` when never
 * heard, unreadable, or anything but `on` — the safe reading of every miss.
 */
export function readTraceContentMode(dir: string): 'on' | 'off' {
  try {
    const json: unknown = JSON.parse(
      readFileSync(join(dir, '.musterd', TRACE_POLICY_FILE), 'utf8'),
    );
    return (json as { content?: unknown }).content === 'on' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/** Record the mode an ingest reply carried. Written only on a change; silent on every failure. */
export function writeTraceContentMode(dir: string, mode: 'on' | 'off'): void {
  if (readTraceContentMode(dir) === mode) return;
  try {
    writeFileSync(
      join(dir, '.musterd', TRACE_POLICY_FILE),
      JSON.stringify({ content: mode, at: Date.now() }) + '\n',
    );
  } catch {
    /* a missing .musterd/ is an unbound folder — nothing to remember */
  }
}

/** Whether this workspace's hooks would send content: the team said `on`, and the daemon is local. */
export function traceContentEnabled(binding: Pick<Binding, 'server'>, dir: string): boolean {
  return readTraceContentMode(dir) === 'on' && isLoopbackServer(binding.server);
}

/**
 * How deep this seat is traced, for the line `musterd status` prints (ADR 445 §4) — or null when the
 * tap would record nothing. Every condition is one the tap itself checks before it posts: the kill
 * switch, a binding that can attribute (agent key) and authenticate (seat credential), and a daemon
 * whose `/health` names a trace store to post into. `structural+content` when, given the workspace
 * `dir`, the hooks would also send content ({@link traceContentEnabled}).
 */
export function traceDepth(
  binding: Pick<Binding, 'agent_key' | 'seat_credential' | 'server'> | null | undefined,
  health: { trace_schema?: number } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  dir?: string,
): 'structural' | 'structural+content' | null {
  if (!traceTapEnabled(env) || !binding?.agent_key || !binding.seat_credential) return null;
  if (typeof health?.trace_schema !== 'number' || health.trace_schema <= 0) return null;
  return dir !== undefined && traceContentEnabled(binding, dir)
    ? 'structural+content'
    : 'structural';
}

/**
 * The `traced:` line `musterd status` prints, sized when the daemon reports the store's bytes
 * (ADR 445 increment 3a — the store grows fast, and this is where a human on the machine sees it).
 */
export function tracedLine(
  depth: 'structural' | 'structural+content',
  health: { trace_db_bytes?: number } | null | undefined,
): string {
  const bytes = health?.trace_db_bytes;
  return typeof bytes === 'number' && bytes >= 0
    ? `traced: ${depth} · trace.db ${fmtBytes(bytes)}`
    : `traced: ${depth}`;
}

/** How long a hook may wait on the daemon before the event is dropped. The gate's own budget class. */
export const TRACE_POST_BUDGET_MS = 1_500;

/**
 * A presence-neutral client for the tap, from the binding alone. Seat credential, no session lease:
 * the route is leaseless by design (a SessionStart hook posts before the session has joined), and
 * sending a lease this one-shot cannot renew would only add a way to be refused.
 */
export function traceClient(binding: Binding, dir: string): HttpClient | null {
  const seat = bindingSeat(binding);
  const key = binding.seat_credential;
  if (!seat || !key) return null;
  return new HttpClient({
    server: binding.server,
    team: binding.team,
    workspace: resolveClaimWorkspace(process.env, dir),
    workspaceKey: resolveWorkspaceKey(process.env, dir),
    key,
    seat,
    surface: 'cli',
    claimSeatPerRequest: false,
  }).presenceNeutral();
}

/**
 * Post events, bounded and silent. Resolves within `budgetMs` whatever the daemon does; the only
 * effect of a failure is a dropped event. Returns whether the post landed, for the caller's own
 * counter — never for control flow.
 */
export async function emitTraceEvents(
  http: HttpClient,
  team: string,
  events: readonly TraceEvent[],
  budgetMs: number = TRACE_POST_BUDGET_MS,
  /** Told the team's content mode when the post lands (a pre-1b daemon's reply reads as `off`). */
  onMode?: (mode: 'on' | 'off') => void,
): Promise<boolean> {
  if (events.length === 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const landed = await Promise.race<boolean>([
      http.postTraceEvents(team, { events: [...events] }).then(
        (res) => {
          try {
            onMode?.(res.content ?? 'off');
          } catch {
            /* the mode cache is a convenience; a failure there never fails the tap */
          }
          return true;
        },
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
        timer.unref?.();
      }),
    ]);
    return landed;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One of musterd's OWN hooks, measured (ADR 445 §2's `HookOutcome`): which hook, how it ended, what
 * it cost. The harness's hook spans are beta-gated and Claude-only, so the tap carries its own.
 * `duration_ms` defaults to the hook process's whole life so far — node boot included, because that
 * is the cost the tool call it rides on actually paid.
 */
export interface HookOutcomeFact {
  hook: 'gate' | 'interrupt' | 'capture' | 'observe';
  exit_code?: number;
  outcome?: TraceEvent['outcome'];
  duration_ms?: number;
  /** Bounded scalar facts about the run (`decision`, `raised`) — never a line the hook printed. */
  detail?: Record<string, string | number | boolean | null>;
}

/**
 * The `HookOutcome` event for a hook run, attributed to the same session and — when the observed
 * event had one — the same tool call, so the cost joins the call on `tool_use_id`.
 */
export function buildHookOutcomeEvent(
  observed: TraceEvent,
  fact: HookOutcomeFact,
  now: number = Date.now(),
): TraceEvent | null {
  const candidate = {
    harness: observed.harness,
    session_digest: observed.session_digest,
    ts: now,
    kind: 'HookOutcome' as const,
    ...(observed.tool_name ? { tool_name: observed.tool_name } : {}),
    ...(observed.tool_use_id ? { tool_use_id: observed.tool_use_id } : {}),
    duration_ms: fact.duration_ms ?? Math.round(process.uptime() * 1000),
    ...(fact.outcome ? { outcome: fact.outcome } : {}),
    detail: { hook: fact.hook, exit_code: fact.exit_code ?? 0, ...fact.detail },
  };
  const ok = TraceEventSchema.safeParse(candidate);
  return ok.success ? ok.data : null;
}

/**
 * The one-call form every hook site uses: parse → build → post, from a raw payload and the
 * workspace's binding. Never throws; never blocks past the budget; returns false on every miss.
 *
 * `harness` is the caller's word when it has one (Codex shares Claude Code's spelling, so only the
 * caller can say); otherwise the payload's spelling decides, then `claude-code`. `outcome` adds the
 * hook's own `HookOutcome` to the SAME post — one round trip per hook process, however many events.
 * `observed: false` records only the outcome, for a hook whose observed event another musterd hook
 * on the same harness event already records (Grok's PreToolUse interrupt probe beside the gate).
 */
export async function tapHook(
  raw: string,
  opts: {
    binding: Binding | null;
    dir: string;
    harness?: string | undefined;
    kind?: TraceEventKind;
    outcome?: HookOutcomeFact;
    observed?: boolean;
    env?: NodeJS.ProcessEnv;
  },
): Promise<boolean> {
  try {
    if (!traceTapEnabled(opts.env)) return false;
    if (!opts.binding) return false;
    // Content rides only the observed event, and only past the policy + loopback gates.
    const content = opts.observed !== false && traceContentEnabled(opts.binding, opts.dir);
    const parsed = parseTraceHook(raw, opts.kind, { content });
    if (!parsed) return false;
    const harness = opts.harness ?? parsed.harness ?? 'claude-code';
    const event = buildTraceEvent(opts.binding, parsed, harness);
    if (!event) return false;
    const events: TraceEvent[] = opts.observed === false ? [] : [event];
    if (opts.outcome) {
      const outcome = buildHookOutcomeEvent(event, opts.outcome);
      if (outcome) events.push(outcome);
    }
    const http = traceClient(opts.binding, opts.dir);
    if (!http) return false;
    const dir = opts.dir;
    return await emitTraceEvents(http, opts.binding.team, events, TRACE_POST_BUDGET_MS, (mode) =>
      writeTraceContentMode(dir, mode),
    );
  } catch {
    return false;
  }
}
