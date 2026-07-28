import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * Repair hints on invalid-input bounces (ADR 144 increment 3). The SDK validates arguments before
 * any tool handler runs and returns the failure in-band (`MCP error -32602: Input validation
 * error: …` — see `toolTelemetry.ts`), so a handler can never soften its own bounce: this transport
 * seam is the only place a hint can be attached. The goal is that a confused agent reaches a valid
 * retry in one turn — "act must be one of …; closest to what you sent is `status_update`" — using
 * deterministic string work only, never a model in the request path (ADR 144 frozen principle).
 *
 * Hints come from structured zod issues, never from scraping the SDK's prose. Through SDK 1.29 the
 * bounce text embedded `ZodError.message` (the pretty-printed JSON issue array) and parsing it out
 * was enough; 1.30 reformats issues as human prose and the structured data vanished from the text —
 * a silent degradation to generic hints that the ADR 175 seam canary caught the day it was written.
 * So the primary source is now our own: each tool's zod shape is captured at registration and the
 * bounced arguments are re-validated here, reproducing the exact issues the SDK saw (same schema,
 * same input — the SDK mutated nothing). The embedded-JSON parse stays as the fallback for texts
 * that still carry it. Anything that yields no issues gets a generic retry line, never a wrong guess.
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
 * The zod shapes the tools registered with, captured by {@link instrumentToolRepair}'s
 * `registerTool` patch — the same capture-at-the-source pattern as `coerce.ts` (which owns the key
 * sets; this module needs the live zod types to re-run validation, and importing them from there
 * would close an import cycle — `coerce.ts` already imports {@link closestOption}).
 */
const SCHEMA_SHAPES = new Map<string, z.ZodRawShape>();

/** Re-validate bounced arguments against the tool's own captured shape: the exact issues the SDK
 * saw, as structured data. Null when the tool has no captured shape, the args aren't an object, or
 * — defensively — the re-parse doesn't fail (an async-refined schema, say, would diverge here). */
function reValidateIssues(tool: unknown, args: unknown): ZodIssueLike[] | null {
  try {
    if (typeof tool !== 'string') return null;
    const shape = SCHEMA_SHAPES.get(tool);
    if (!shape || typeof args !== 'object' || args === null || Array.isArray(args)) return null;
    const parsed = z.object(shape).safeParse(args);
    return parsed.success ? null : (parsed.error.issues as ZodIssueLike[]);
  } catch {
    return null;
  }
}

/**
 * The repair line for a bounce result's text, or '' when the text isn't a bounce. Pure given its
 * inputs — the transport wrapper passes the bounced call's tool + arguments so the issues can be
 * regenerated from the schema; tests may call it text-only, which exercises the embedded-JSON
 * fallback.
 */
export function bounceRepair(text: string, call?: { tool?: unknown; args?: unknown }): string {
  if (!BOUNCE_RE.test(text)) return '';
  // A bounce that already carries its own repair line wrote a better one than this can: the
  // unknown-key check in `coerce.ts` knows the valid key set, while there is no zod issue here to
  // parse — appending would only add a generic second hint under a specific first one.
  if (text.includes('\nrepair: ')) return '';
  const issues = reValidateIssues(call?.tool, call?.args) ?? parseIssues(text);
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

/** Capture each tool's zod shape as it registers, mirroring `captureSchemaKeys` in `coerce.ts`:
 * the source of truth stays where the schema is written. Best-effort — an unreadable config
 * registers untouched and its bounces fall back to the embedded-JSON parse. */
function captureSchemaShapes(server: McpServer): void {
  const original = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: unknown,
  ) => unknown;
  (server as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    cb: unknown,
  ) => {
    try {
      const shape = (config as { inputSchema?: unknown } | undefined)?.inputSchema;
      if (typeof shape === 'object' && shape !== null && !Array.isArray(shape)) {
        SCHEMA_SHAPES.set(name, shape as z.ZodRawShape);
      }
    } catch {
      // leave the tool's bounces on the fallback path rather than fail its registration
    }
    return original(name, config, cb);
  };
}

/**
 * Patch the inner server's `setRequestHandler` so every `tools/call` bounce comes back with its
 * repair line appended. Must be installed before the first `registerTool`. Composes with
 * `instrumentToolTransport` (each wraps whatever is installed): the repair appends at the END of
 * the text, so telemetry's start-anchored bounce classifier still counts it as `invalid_input`.
 */
export function instrumentToolRepair(server: McpServer): void {
  captureSchemaShapes(server);
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
      // The request carries what the SDK actually validated: coercion (installed innermost) has
      // already rewritten `params.arguments` in place, so re-validation sees the same input.
      const params = (request as { params?: { name?: unknown; arguments?: unknown } } | undefined)
        ?.params;
      const repair = bounceRepair(text, { tool: params?.name, args: params?.arguments });
      if (!repair) return result;
      return { ...r, content: [{ ...first, text: text + repair }, ...r.content!.slice(1)] };
    };
    return original(schema, wrapped);
  };
}
