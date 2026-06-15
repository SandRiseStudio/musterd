import { type SpanContext, trace } from '@opentelemetry/api';

/**
 * Cross-runtime trace propagation through the coordination protocol (ADR 011; observability.md §6
 * step 2). The adapter is not itself instrumented yet (§4 defers adapter telemetry), so these are
 * the **convention plumbing**: they activate whenever a real OTel trace context is present in the
 * adapter's process (a host- or future-adapter-provided span). With no active context / no provider,
 * they are inert — `meta.otel` is simply not attached, and the receive-side link is a no-op span.
 *
 * We format/parse the W3C `traceparent` directly (the format is fixed and tiny) to keep the adapter's
 * dependency to just `@opentelemetry/api` — no `@opentelemetry/core`.
 */

const TRACEPARENT_VERSION = '00';
const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);

export interface OtelCarrier {
  traceparent: string;
  tracestate?: string;
}

/** Format a span context as a W3C traceparent (+ tracestate), or undefined if it isn't valid. */
export function formatTraceContext(sc: SpanContext): OtelCarrier | undefined {
  if (!isValidTraceId(sc.traceId) || !isValidSpanId(sc.spanId)) return undefined;
  const flags = (sc.traceFlags & 0xff).toString(16).padStart(2, '0');
  const traceparent = `${TRACEPARENT_VERSION}-${sc.traceId}-${sc.spanId}-${flags}`;
  const tracestate = sc.traceState?.serialize();
  return tracestate ? { traceparent, tracestate } : { traceparent };
}

/**
 * Attach the adapter's current active trace context to a meta object as `meta.otel` (ADR 011 sender
 * SHOULD), unless one is already present (an explicitly-supplied `meta.otel` is respected) or there
 * is no active context. Returns the meta to send.
 */
export function withTraceContext(
  meta: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (meta && isObject(meta['otel'])) return meta; // caller set it explicitly — don't override
  const span = trace.getActiveSpan();
  if (!span) return meta;
  const carrier = formatTraceContext(span.spanContext());
  if (!carrier) return meta;
  return { ...(meta ?? {}), otel: carrier };
}

/** Parse `meta.otel.traceparent` into a remote SpanContext suitable for use as a span link. */
export function remoteSpanContext(meta: unknown): SpanContext | undefined {
  const otel = isObject(meta) ? meta['otel'] : undefined;
  const tp = isObject(otel) && typeof otel['traceparent'] === 'string' ? otel['traceparent'] : '';
  const m = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(tp);
  if (!m) return undefined;
  const [, traceId, spanId, flags] = m;
  if (!isValidTraceId(traceId!) || !isValidSpanId(spanId!)) return undefined;
  return {
    traceId: traceId!,
    spanId: spanId!,
    traceFlags: parseInt(flags!, 16) & 0xff,
    isRemote: true,
  };
}

/**
 * Receiver side (ADR 011 SHOULD): for incoming messages carrying `meta.otel`, record a span that
 * **links** to each sender's trace — causality without claiming ownership (the sender's trace lives
 * in a different backend). A no-op when nothing carries trace context or no provider is registered.
 */
export function linkReceived(messages: { meta?: unknown }[]): void {
  const links = messages
    .map((m) => remoteSpanContext(m.meta))
    .filter((c): c is SpanContext => c !== undefined)
    .map((context) => ({ context }));
  if (links.length === 0) return;
  trace.getTracer('musterd-mcp').startSpan('musterd.inbox.received', { links }).end();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isValidTraceId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id) && id !== INVALID_TRACE_ID;
}

function isValidSpanId(id: string): boolean {
  return /^[0-9a-f]{16}$/.test(id) && id !== INVALID_SPAN_ID;
}
