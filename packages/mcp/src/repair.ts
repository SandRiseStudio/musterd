import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Repair hints on invalid-input bounces (ADR 144 increment 3). The SDK validates arguments before
 * any tool handler runs and returns the failure in-band (`MCP error -32602: Input validation
 * error: …` — see `toolTelemetry.ts`), so a handler can never soften its own bounce: this transport
 * seam is the only place a hint can be attached. The goal is that a confused agent reaches a valid
 * retry in one turn — "act must be one of …; closest to what you sent is `status_update`" — using
 * deterministic string work only, never a model in the request path (ADR 144 frozen principle).
 *
 * The SDK's bounce text embeds `ZodError.message`, which is the pretty-printed JSON array of zod
 * issues — parseable, so hints come from structured data (path / options / received), not from
 * scraping prose. Anything that doesn't parse gets a generic retry line rather than a wrong guess.
 */

/** The same anchor `toolTelemetry.ts` classifies bounces by — a handler's own prose can't spoof it. */
const BOUNCE_RE = /^(MCP error -32602: )?Input validation error:/;

/** The zod issue fields the hints read. Everything is optional-defensive: issue shapes vary by code. */
interface ZodIssueLike {
  code?: string;
  path?: (string | number)[];
  message?: string;
  options?: unknown[];
  expected?: string;
  received?: string;
}

/** Extract the zod issues array embedded in the SDK's bounce text; null when there isn't one. */
export function parseIssues(text: string): ZodIssueLike[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((i): i is ZodIssueLike => typeof i === 'object' && i !== null);
  } catch {
    return null;
  }
}

/** Plain Levenshtein — small strings (enum values), so the O(n·m) matrix is fine. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

/**
 * The nearest valid enum value to what was sent, or undefined when nothing is close enough to
 * assert — a bad suggestion is worse than none, so the distance must be under half the sent length.
 */
export function closestOption(received: string, options: unknown[]): string | undefined {
  const candidates = options.filter((o): o is string => typeof o === 'string');
  if (candidates.length === 0) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(received.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= Math.max(2, Math.floor(received.length / 2)) ? best : undefined;
}

function hintForIssue(issue: ZodIssueLike): string {
  const field = issue.path?.length ? issue.path.join('.') : 'input';
  if (issue.code === 'invalid_enum_value' && Array.isArray(issue.options)) {
    const opts = issue.options.filter((o): o is string => typeof o === 'string');
    let hint = `${field} must be one of ${opts.join('|')}`;
    const near =
      issue.received !== undefined ? closestOption(String(issue.received), opts) : undefined;
    if (near) hint += `; closest to what you sent is '${near}'`;
    return hint;
  }
  if (issue.code === 'invalid_type' && issue.received === 'undefined') {
    return `missing required field '${field}' (${issue.expected ?? 'value'})`;
  }
  if (issue.code === 'invalid_type') {
    return `'${field}' must be ${issue.expected ?? 'another type'} (got ${issue.received ?? 'something else'})`;
  }
  return `'${field}': ${issue.message ?? issue.code ?? 'invalid'}`;
}

/** How many issues a single repair line explains — beyond this the schema itself is the fix. */
const MAX_ISSUES = 3;

/**
 * The repair line for a bounce result's text, or '' when the text isn't a bounce. Pure — the
 * transport wrapper appends it; tests call it directly.
 */
export function bounceRepair(text: string): string {
  if (!BOUNCE_RE.test(text)) return '';
  const issues = parseIssues(text);
  const hints = issues?.slice(0, MAX_ISSUES).map(hintForIssue) ?? [];
  const body = hints.length ? hints.join('; ') : 'check the fields against the tool input schema';
  return `\nrepair: ${body} — fix and retry the same call`;
}

type RequestHandler = (request: unknown, extra: unknown) => unknown;

/** The Zod method literal off an SDK request schema — same defensive read as `toolTelemetry.ts`. */
function methodOf(schema: unknown): string | undefined {
  const value = (schema as { shape?: { method?: { value?: unknown } } } | undefined)?.shape?.method
    ?.value;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Patch the inner server's `setRequestHandler` so every `tools/call` bounce comes back with its
 * repair line appended. Must be installed before the first `registerTool`. Composes with
 * `instrumentToolTransport` (each wraps whatever is installed): the repair appends at the END of
 * the text, so telemetry's start-anchored bounce classifier still counts it as `invalid_input`.
 */
export function instrumentToolRepair(server: McpServer): void {
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
    const wrapped: RequestHandler = async (request, extra) => {
      const result = await handler(request, extra);
      const r = result as {
        isError?: unknown;
        content?: { type?: string; text?: unknown }[];
      } | null;
      const first = r?.content?.[0];
      if (r?.isError !== true || first?.type !== 'text') return result;
      const text = String(first.text ?? '');
      const repair = bounceRepair(text);
      if (!repair) return result;
      return { ...r, content: [{ ...first, text: text + repair }, ...r.content!.slice(1)] };
    };
    return original(schema, wrapped);
  };
}
