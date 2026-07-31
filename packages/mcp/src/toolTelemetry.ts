import type { McpServer } from '@modelcontextprotocol/server';
import type {
  SurfaceRender,
  ToolCallEvent,
  ToolCallOutcome,
  ToolTelemetryReport,
} from '@musterd/protocol';
import type { MusterdClient } from './client.js';
import { wasCoerced } from './coerce.js';
import { TOOL_NAMES } from './toolNames.js';

/**
 * First-party tool-call telemetry (ADR 144 increment 1) — distinct from the OTel spans in
 * `telemetry.ts` (opt-in, exported): this always accumulates and flushes to the team daemon, so
 * `musterd report` can answer "which tools does each role call, at what cost, with what bounce
 * rate" without an OTel collector. Redaction posture is the same hard line: tool names, outcomes,
 * durations, and byte counts only — never tool arguments or message bodies.
 *
 * The hook is the SDK's `tools/call` request handler, one level ABOVE the per-tool span wrapper:
 * the SDK validates input before any registered callback runs, so an invalid-input bounce never
 * reaches the handlers `instrumentTools` wraps — this transport-level seam is the only place the
 * bounce class (the headline eval) is visible. The same seam captures `tools/list`, whose exact
 * rendered listing is the seat's surface weight.
 */

/** Tool names outside our registered surface collapse to one bucket — a hallucinated tool name
 * must not mint an aggregation key per typo. */
const KNOWN_TOOLS: ReadonlySet<string> = new Set<string>(TOOL_NAMES);
const UNKNOWN_TOOL = '(unknown)';

/** The SDK reports an input-schema bounce as an in-band error result (it never reaches the tool
 * handler): the validation McpError (InvalidParams, -32602) is caught inside the SDK's tools/call
 * handler and stringified, so at this seam the text reads `MCP error -32602: Input validation
 * error: …`. Anchored to the start so a handler's own prose can't spoof the bounce class.
 * @internal exported as a canary anchor only — `sdkSeams.test.ts` asserts the real SDK's bounce
 * prose still matches, so an SDK bump that changes the wording fails loudly instead of silently
 * reclassifying every bounce as a generic `error` (ADR 175). `repair.ts` keeps its own copy. */
export const BOUNCE_RE = /^(MCP error -32602: )?Input validation error:/;

/**
 * Classify a fulfilled `tools/call` result: the SDK's validation bounce, the in-band failure
 * conventions (`isError`, `textResult('error: …')`), or success. Mirrors `toolErrorText` in
 * `telemetry.ts` — kept separate because this one also names the bounce class.
 */
export function classifyToolResult(result: unknown): ToolCallOutcome {
  if (typeof result !== 'object' || result === null) return 'ok';
  const r = result as { isError?: unknown; content?: { type?: string; text?: unknown }[] };
  const text = r.content?.[0]?.type === 'text' ? String(r.content[0].text ?? '') : '';
  if (r.isError === true) return BOUNCE_RE.test(text) ? 'invalid_input' : 'error';
  return text.startsWith('error:') ? 'error' : 'ok';
}

interface Cell {
  tool: string;
  outcome: ToolCallOutcome;
  calls: number;
  total_duration_ms: number;
  max_duration_ms: number;
}

/**
 * Accumulates (tool, outcome) deltas between flushes and attests the rendered-surface weight once
 * per session. Bounded by construction: the keyspace is registered-tools × 4 outcomes (+ the
 * unknown bucket), so a failed flush can re-merge without growth. Everything here is best-effort
 * observability — nothing throws into the tool path.
 */
export class ToolCallRecorder {
  private cells = new Map<string, Cell>();
  private listTools: (() => unknown) | null = null;
  private surface: SurfaceRender | null = null;
  private surfaceSent = false;

  record(tool: string, outcome: ToolCallOutcome, durationMs: number): void {
    const name = KNOWN_TOOLS.has(tool) ? tool : UNKNOWN_TOOL;
    // NUL delimiter as \u0000 escape — a literal \x00 makes grep/file silent on this file (ADR 195).
    const key = `${name}\u0000${outcome}`;
    const ms = Math.max(0, Math.round(durationMs));
    const cell = this.cells.get(key);
    if (cell) {
      cell.calls += 1;
      cell.total_duration_ms += ms;
      cell.max_duration_ms = Math.max(cell.max_duration_ms, ms);
    } else {
      this.cells.set(key, {
        tool: name,
        outcome,
        calls: 1,
        total_duration_ms: ms,
        max_duration_ms: ms,
      });
    }
  }

  /** Wired by {@link instrumentToolTransport}: invokes the SDK's own `tools/list` handler, so the
   * weight is measured from the exact listing the harness receives. */
  captureListHandler(invoke: () => unknown): void {
    this.listTools = invoke;
  }

  /** Anything to send? (Used by tests; flush() re-checks.) */
  get dirty(): boolean {
    return this.cells.size > 0 || (!this.surfaceSent && this.listTools !== null);
  }

  private async computeSurface(): Promise<SurfaceRender | null> {
    if (!this.listTools) return null;
    const res = (await this.listTools()) as
      | { tools?: { name?: unknown; description?: unknown }[] }
      | undefined;
    if (!res?.tools) return null;
    const breakdown = res.tools.slice(0, 64).map((t) => ({
      tool: (typeof t.name === 'string' && t.name ? t.name : UNKNOWN_TOOL).slice(0, 64),
      bytes: Buffer.byteLength(JSON.stringify(t), 'utf8'),
      description_bytes: Buffer.byteLength(
        typeof t.description === 'string' ? t.description : '',
        'utf8',
      ),
    }));
    const bytes = breakdown.reduce((n, b) => n + b.bytes, 0);
    return {
      tools: res.tools.length,
      bytes,
      est_tokens: Math.round(bytes / 4),
      breakdown,
    };
  }

  /**
   * Flush accumulated deltas (and, on the first successful send, the surface attestation) to the
   * daemon. No-op until the session has a seat to attribute to; a send failure re-merges the
   * batch for the next tick. Never throws.
   */
  async flush(client: MusterdClient): Promise<void> {
    if (!client.member) return;
    if (!this.surfaceSent && !this.surface) {
      try {
        this.surface = await this.computeSurface();
      } catch {
        this.surface = null; // retried next flush
      }
    }
    const surface = this.surfaceSent ? null : this.surface;
    if (this.cells.size === 0 && !surface) return;
    const batch = this.cells;
    this.cells = new Map();
    const events: ToolCallEvent[] = [...batch.values()];
    const report: ToolTelemetryReport = { events, ...(surface ? { surface } : {}) };
    try {
      await client.reportToolTelemetry(report);
      if (surface) this.surfaceSent = true;
    } catch {
      // Re-merge so the next tick retries — bounded, see the class doc.
      for (const [key, cell] of batch) {
        const live = this.cells.get(key);
        if (!live) {
          this.cells.set(key, cell);
        } else {
          live.calls += cell.calls;
          live.total_duration_ms += cell.total_duration_ms;
          live.max_duration_ms = Math.max(live.max_duration_ms, cell.max_duration_ms);
        }
      }
    }
  }
}

/** The method a `setRequestHandler` call registers for. SDK v2 (spec 2026-07-28) keys the handler
 * by method STRING; v1 keyed it by a zod request schema whose literal lived at
 * `schema.shape.method.value` — kept as the fallback read so the wrappers survive either arity.
 * Defensive: anything unexpected reads as "not ours" and passes through untouched. That
 * defensiveness is also a silent failure mode: if an SDK bump reshapes this again, all three seam
 * wrappers degrade to pass-through and telemetry/repair/coercion just stop.
 * @internal exported as a canary anchor only — `sdkSeams.test.ts` pins it against the SDK's real
 * request schemas so the detachment is a red test, not a quiet telemetry gap (ADR 175). */
export function methodOf(schemaOrMethod: unknown): string | undefined {
  if (typeof schemaOrMethod === 'string') return schemaOrMethod;
  const value = (schemaOrMethod as { shape?: { method?: { value?: unknown } } } | undefined)?.shape
    ?.method?.value;
  return typeof value === 'string' ? value : undefined;
}

type RequestHandler = (request: unknown, extra: unknown) => unknown;

/**
 * Patch the inner server's `setRequestHandler` so the SDK's `tools/call` handler (validation
 * included) runs timed and classified, and its `tools/list` handler is captured for the surface
 * weight. Must be installed before the first `registerTool` (which is what makes the SDK install
 * those handlers). Duration is transport-level wall-clock — a deferred autojoin on the first call
 * is attributed to that call, same as its span.
 */
export function instrumentToolTransport(server: McpServer, recorder: ToolCallRecorder): void {
  const inner = server.server;
  const original = inner.setRequestHandler.bind(inner) as (...args: unknown[]) => unknown;
  // Variadic pass-through: v2 registers `(method, handler)` and has a 3-arg custom-schema form;
  // v1 registered `(schema, handler)`. The handler is always the LAST argument either way.
  (inner as { setRequestHandler: unknown }).setRequestHandler = (...args: unknown[]) => {
    const method = methodOf(args[0]);
    const handler = args[args.length - 1] as RequestHandler;
    if (typeof handler !== 'function') return original(...args);
    if (method === 'tools/list') {
      recorder.captureListHandler(() => handler({ method: 'tools/list', params: {} }, {}));
      return original(...args);
    }
    if (method !== 'tools/call') return original(...args);
    const wrapped: RequestHandler = async (request, extra) => {
      const name = (request as { params?: { name?: unknown } } | undefined)?.params?.name;
      const tool = typeof name === 'string' ? name : UNKNOWN_TOOL;
      const start = Date.now();
      try {
        const result = await handler(request, extra);
        // A success that only happened because the coercion layer (installed inside this wrapper)
        // repaired the arguments is recorded as `coerced`, not `ok`: forgiveness we can't see is
        // indistinguishable from a surface that never had the defect (ADR 144 inc 4).
        const outcome = classifyToolResult(result);
        recorder.record(
          tool,
          outcome === 'ok' && wasCoerced(request) ? 'coerced' : outcome,
          Date.now() - start,
        );
        return result;
      } catch (err) {
        // Protocol-level throw (the SDK converts most failures in-band; this is the rare rest).
        recorder.record(tool, 'error', Date.now() - start);
        throw err;
      }
    };
    return original(...args.slice(0, -1), wrapped);
  };
}

/**
 * The flush loop: periodic (unref'd — never holds the process open) plus a final flush from the
 * returned stop fn, which the entrypoint awaits in its graceful teardown. 30s default: chatty
 * enough that a short session still lands its calls, quiet enough to stay one small POST.
 */
export function startToolTelemetryFlush(
  client: MusterdClient,
  recorder: ToolCallRecorder,
  opts: { intervalMs?: number } = {},
): () => Promise<void> {
  const timer = setInterval(() => void recorder.flush(client), opts.intervalMs ?? 30_000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    return recorder.flush(client);
  };
}
