import {
  type Binding,
  bindingSeat,
  TRACE_DETAIL_MAX_BYTES,
  type TraceEvent,
  TraceEventKindSchema,
  type TraceEventKind,
  TraceEventSchema,
} from '@musterd/protocol';
import { resolveWorkspaceKey } from '@musterd/protocol/project';
import { HttpClient } from '../client.js';
import { resolveClaimWorkspace } from '../commands/helpers.js';
import { sessionDigest } from '../session/digest.js';

/**
 * Rail R1, the hook tap — the client half (ADR 445 §2, increment 1a). Turns a harness hook payload
 * into one structural `TraceEvent` and posts it to the seat's daemon, fire-and-forget.
 *
 * Three properties are load-bearing and each is enforced by construction, not by care:
 *
 * - **Structural only.** {@link parseTraceHook} reads names, ids, kinds and sizes out of the payload
 *   and nothing else; `tool_input`, `tool_response`, `prompt`, `error` and
 *   `last_assistant_message` are never read into a variable that reaches the event. Increment 1b
 *   adds the content part behind the credential scrub. Until then the protocol schema has no field
 *   for it, so even a bug here would meet a schema that strips it.
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

/**
 * Parse a Claude Code-shaped hook payload (the other harnesses' adapters normalize into this shape
 * before calling). `kind` overrides the payload's `hook_event_name` — for a hook that knows which
 * event registered it better than the payload does (the gate is always PreToolUse). Returns null
 * when there is nothing to record: no session id, or an event kind the tap does not know.
 */
export function parseTraceHook(raw: string, kind?: TraceEventKind): ParsedTraceHook | null {
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
  return ok.success ? ok.data : null;
}

/** The seat's own kill switch for the tap (ADR 445 §4): `MUSTERD_NO_TRACE=1` traces nothing. */
export function traceTapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MUSTERD_NO_TRACE'] !== '1';
}

/**
 * How deep this seat is traced, for the line `musterd status` prints (ADR 445 §4) — or null when the
 * tap would record nothing. Every condition is one the tap itself checks before it posts: the kill
 * switch, a binding that can attribute (agent key) and authenticate (seat credential), and a daemon
 * whose `/health` names a trace store to post into. Always `structural` until increment 1b adds the
 * content column behind `trace.content`.
 */
export function traceDepth(
  binding: Pick<Binding, 'agent_key' | 'seat_credential'> | null | undefined,
  health: { trace_schema?: number } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): 'structural' | null {
  if (!traceTapEnabled(env) || !binding?.agent_key || !binding.seat_credential) return null;
  return typeof health?.trace_schema === 'number' && health.trace_schema > 0 ? 'structural' : null;
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
): Promise<boolean> {
  if (events.length === 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const landed = await Promise.race<boolean>([
      http.postTraceEvents(team, { events: [...events] }).then(
        () => true,
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
    const parsed = parseTraceHook(raw, opts.kind);
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
    return await emitTraceEvents(http, opts.binding.team, events);
  } catch {
    return false;
  }
}
