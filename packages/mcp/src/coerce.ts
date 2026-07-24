import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Deterministic input coercion (ADR 144 increment 4) — the "deterministic forgiveness" principle:
 * a call that misses the schema in a *mechanically knowable* way is repaired and succeeds, instead
 * of bouncing and costing the agent a turn. No model in the request path, ever (frozen principle):
 * every rule here is a pure, total function of the arguments.
 *
 * WHY THIS SEAM. The SDK validates `tools/call` arguments before any registered handler runs, so a
 * handler can never see — let alone forgive — a wrong field name; it only sees calls that already
 * passed. Coercion therefore has to rewrite `request.params.arguments` *ahead of* validation, which
 * makes this the mirror image of `repair.ts`: repair explains a bounce on the way out, coercion
 * prevents one on the way in. Rules are chosen from measured bounces (`tool_call_stats` +
 * transcript payloads over 2026-07-15..24), never from speculation — an unmeasured rule is a guess,
 * and a wrong repair is worse than none (ADR 144 inc 3).
 *
 * WHAT IS DELIBERATELY NOT FORGIVEN. Two shapes bounce on purpose, because any repair would have to
 * invent meaning the caller never expressed: a multi-recipient `to` (the wire carries exactly one
 * recipient — silently dropping the rest would lose a message), and a non-numeric `pr` such as
 * `"local"` (the caller means "no PR"; the fix is to omit it, and the description now says so).
 * Both keep their bounce + repair hint, which is the honest answer.
 *
 * COUNTING. Only *structural* repairs count as coercions (aliases, type and shape fixes) — those
 * are the mistakes worth measuring. Whitespace trimming is normalization, not a mistake, so it is
 * applied silently and never counted; otherwise the signal would drown in trailing newlines. The
 * count is what tells us, over the coming weeks, whether agents keep guessing a field name often
 * enough to justify a hard rename in a later increment (see the `coerced` outcome in
 * `toolTelemetry.ts`). Forgiveness without measurement is just drift.
 */

/** A rule mutates `args` in place and names itself when it fired; null when it did not apply. */
type Rule = (args: Record<string, unknown>) => string | null;

/**
 * Move a near-miss key onto the real one. Only fires when the real field is absent, so an explicit
 * correct value always wins over an alias — a caller that sends both meant the canonical one.
 */
function alias(from: string, to: string): Rule {
  return (args) => {
    if (!(from in args) || args[to] !== undefined) return null;
    args[to] = args[from];
    delete args[from];
    return `${from}→${to}`;
  };
}

/**
 * A count that arrived as a string: `"343"` and `"#343"` are unambiguous. Anything else (notably
 * `"local"`) is left alone to bounce — inventing a number there would attest a PR that never
 * existed, corrupting the merge audit trail.
 */
function numericString(field: string): Rule {
  return (args) => {
    const v = args[field];
    if (typeof v !== 'string') return null;
    const t = v.trim().replace(/^#/, '');
    if (!/^\d+$/.test(t)) return null;
    args[field] = Number(t);
    return `${field}:string→number`;
  };
}

/**
 * A recipient that came back in wire shape or as a list. Agents read `Recipient` objects out of
 * results and inbox payloads (`{kind:'member',name:'nick'}`) and echo them into the next send, and
 * multi-agent harnesses reach for arrays; both are mechanically unambiguous for one recipient.
 * An empty list means "no one in particular" — dropping the field lets the schema default to
 * `@team`, which is what the caller meant.
 */
function recipientShape(field: string): Rule {
  return (args) => {
    const v = args[field];
    if (Array.isArray(v)) {
      if (v.length === 0) {
        delete args[field];
        return `${field}:[]→default`;
      }
      if (v.length === 1 && typeof v[0] === 'string') {
        args[field] = v[0];
        return `${field}:[one]→string`;
      }
      return null; // 2+ recipients: no single-recipient repair exists — bounce with the hint.
    }
    if (v !== null && typeof v === 'object') {
      const r = v as { kind?: unknown; name?: unknown };
      if (r.kind === 'team') {
        args[field] = '@team';
        return `${field}:Recipient→string`;
      }
      if (r.kind === 'broadcast') {
        args[field] = '@broadcast';
        return `${field}:Recipient→string`;
      }
      if (r.kind === 'member' && typeof r.name === 'string') {
        args[field] = r.name;
        return `${field}:Recipient→string`;
      }
    }
    return null;
  };
}

/** Headline budget — the protocol's cap, mirrored here so derivation lands inside it. */
const HEADLINE_MAX = 120;

/**
 * Derive the memory headline from the body's first line when it was omitted — the single most
 * common shape in the measured data (every `team_memory_save` bounce: a long, carefully-written
 * `body` rejected over a missing one-line subject).
 *
 * Safe to truncate here, and *only* here: the body keeps every word, so a clipped headline loses
 * nothing — it is a display pointer into text the seat still has. An explicitly-provided headline
 * over the cap is NOT truncated; that would silently discard what the caller actually wrote, so it
 * bounces with a repair hint instead. Same limit, opposite answer, because the data loss differs.
 */
const deriveHeadline: Rule = (args) => {
  if (args['headline'] !== undefined) return null;
  const body = args['body'];
  if (typeof body !== 'string') return null;
  const first = body
    .split('\n')
    .map((l) => l.replace(/^\s*[#*>\-\s]+/, '').trim())
    .find((l) => l.length > 0);
  if (!first) return null;
  args['headline'] = first.length <= HEADLINE_MAX ? first : clip(first, HEADLINE_MAX);
  return 'headline←body';
};

/** Clip to `max` characters on a word boundary where one is close, with an ellipsis to show it. */
function clip(s: string, max: number): string {
  const hard = s.slice(0, max - 1);
  const cut = hard.lastIndexOf(' ');
  return (cut > max * 0.6 ? hard.slice(0, cut) : hard).trimEnd() + '…';
}

/**
 * The measured rule table. `lane`/`lane_id` → `id` is the big one: 70% of every bounce in the
 * window, from five distinct seats across two harnesses — including a seat that hit it on its first
 * day, which is what makes it a standing tax rather than one agent's habit. The cause is our own
 * vocabulary: results and prose say "lane", the input schema says `id`. Aliasing (rather than
 * renaming the parameter) keeps the surface stable for every connected agent and every doc, and the
 * `coerced` counter now measures whether the wrong guess persists — if it does, a later increment
 * can rename on evidence. That is the measure-then-craft order; renaming first would be the guess.
 */
const RULES: Record<string, Rule[]> = {
  lane_claim: [alias('lane', 'id'), alias('lane_id', 'id')],
  lane_handoff: [alias('lane', 'id'), alias('lane_id', 'id'), recipientShape('to')],
  lane_update: [alias('lane', 'id'), alias('lane_id', 'id')],
  lane_resolve: [alias('lane', 'id'), alias('lane_id', 'id'), numericString('pr')],
  team_send: [
    recipientShape('to'),
    alias('text', 'body'),
    alias('content', 'body'),
    alias('message', 'body'),
  ],
  team_memory_save: [alias('note', 'body'), alias('content', 'body'), deriveHeadline],
};

/** Leading/trailing whitespace is never meaningful in these arguments — normalize, don't count. */
function trimStrings(args: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t !== v) args[k] = t;
    }
  }
}

/**
 * Apply the table for `tool`. Returns the repaired arguments and the rules that fired — the caller
 * decides what to do with the fact that it fired. Pure with respect to the input object: callers
 * get a new object, so a no-op coercion can be detected by an untouched original.
 */
export function coerceToolArgs(
  tool: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; applied: string[] } {
  const out = { ...args };
  trimStrings(out);
  const applied: string[] = [];
  for (const rule of RULES[tool] ?? []) {
    const name = rule(out);
    if (name) applied.push(name);
  }
  return { args: out, applied };
}

/**
 * Requests whose arguments this layer repaired. A WeakSet keyed on the request object is what makes
 * the handoff to telemetry concurrency-safe: several `tools/call` requests can be in flight, and
 * each carries its own identity, so no shared "last coerced" flag can be attributed to the wrong
 * call. Entries vanish with the request — nothing to evict.
 */
const coercedRequests = new WeakSet<object>();

/** Did this in-flight request need repair? Read by `toolTelemetry.ts` to class the outcome. */
export function wasCoerced(request: unknown): boolean {
  return typeof request === 'object' && request !== null && coercedRequests.has(request);
}

/**
 * Patch the inner server's `setRequestHandler` so `tools/call` arguments are repaired before the
 * SDK validates them. Must be installed before the first `registerTool`. Composes with the other
 * two seam wrappers — install order in `index.ts` puts telemetry outermost (it must see the final
 * result), then repair, then this innermost, so a coerced call reaches validation already valid and
 * is recorded as `coerced` rather than `invalid_input`.
 *
 * Best-effort by construction: a malformed request, a missing arguments object, or a throwing rule
 * passes straight through to the SDK untouched. Coercion must never be the reason a call fails.
 */
export function instrumentToolCoercion(server: McpServer): void {
  const inner = server.server;
  const original = inner.setRequestHandler.bind(inner) as (
    schema: unknown,
    handler: RequestHandler,
  ) => unknown;
  (inner as { setRequestHandler: unknown }).setRequestHandler = (
    schema: unknown,
    handler: RequestHandler,
  ) => {
    if (methodOf(schema) !== 'tools/call') return original(schema, handler);
    const wrapped: RequestHandler = (request, extra) => {
      try {
        const params = (request as { params?: { name?: unknown; arguments?: unknown } } | undefined)
          ?.params;
        const tool = params?.name;
        const args = params?.arguments;
        if (
          typeof tool === 'string' &&
          RULES[tool] &&
          typeof args === 'object' &&
          args !== null &&
          !Array.isArray(args)
        ) {
          const { args: fixed, applied } = coerceToolArgs(tool, args as Record<string, unknown>);
          if (applied.length > 0) {
            params!.arguments = fixed;
            if (typeof request === 'object' && request !== null) coercedRequests.add(request);
          }
        }
      } catch {
        // fall through with the original arguments — never fail a call over its own repair
      }
      return handler(request, extra);
    };
    return original(schema, wrapped);
  };
}

type RequestHandler = (request: unknown, extra: unknown) => unknown;

/** The Zod method literal off an SDK request schema — same defensive read as the sibling wrappers. */
function methodOf(schema: unknown): string | undefined {
  const value = (schema as { shape?: { method?: { value?: unknown } } } | undefined)?.shape?.method
    ?.value;
  return typeof value === 'string' ? value : undefined;
}
