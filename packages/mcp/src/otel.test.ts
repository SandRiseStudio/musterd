import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatTraceContext, linkReceived, remoteSpanContext, withTraceContext } from './otel.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

describe('formatTraceContext / remoteSpanContext (pure W3C round-trip)', () => {
  it('formats a valid span context into a traceparent', () => {
    expect(formatTraceContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })).toEqual({
      traceparent: TRACEPARENT,
    });
  });

  it('drops an all-zero (invalid) span context', () => {
    expect(
      formatTraceContext({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }),
    ).toBeUndefined();
  });

  it('parses meta.otel.traceparent back into a remote span context', () => {
    const sc = remoteSpanContext({ otel: { traceparent: TRACEPARENT } });
    expect(sc).toMatchObject({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
      isRemote: true,
    });
  });

  it('returns undefined for missing/malformed trace context', () => {
    expect(remoteSpanContext(null)).toBeUndefined();
    expect(remoteSpanContext({})).toBeUndefined();
    expect(remoteSpanContext({ otel: { traceparent: 'garbage' } })).toBeUndefined();
  });
});

describe('emit + honor with a live provider', () => {
  const spans = new InMemorySpanExporter();
  let provider: BasicTracerProvider;

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    trace.setGlobalTracerProvider(provider);
  });
  afterAll(() => {
    context.disable();
    trace.disable();
  });

  it('emit: withTraceContext attaches the active span as meta.otel (ADR 011 sender)', () => {
    trace.getTracer('test').startActiveSpan('work', (span) => {
      const sc = span.spanContext();
      const meta = withTraceContext({ progress: 0.5 });
      expect(meta).toMatchObject({ progress: 0.5 });
      expect((meta as { otel: { traceparent: string } }).otel.traceparent).toBe(
        `00-${sc.traceId}-${sc.spanId}-01`,
      );
      span.end();
    });
  });

  it('emit: respects an explicitly-supplied meta.otel and does not override it', () => {
    trace.getTracer('test').startActiveSpan('work', (span) => {
      const explicit = { otel: { traceparent: TRACEPARENT } };
      expect(withTraceContext({ ...explicit })).toEqual(explicit);
      span.end();
    });
  });

  it('emit: no active span → meta is left untouched', () => {
    expect(withTraceContext({ a: 1 })).toEqual({ a: 1 });
    expect(withTraceContext(null)).toBeNull();
  });

  it('honor: linkReceived records a span linked to the sender trace (ADR 011 receiver)', () => {
    spans.reset();
    linkReceived([
      { meta: { otel: { traceparent: TRACEPARENT } } },
      { meta: null }, // no context — ignored
    ]);
    const received = spans.getFinishedSpans().find((s) => s.name === 'musterd.inbox.received');
    expect(received).toBeTruthy();
    expect(received!.links).toHaveLength(1);
    expect(received!.links[0]!.context.traceId).toBe(TRACE_ID);
  });

  it('honor: no trace context in any message → no span is created', () => {
    spans.reset();
    linkReceived([{ meta: null }, { meta: { progress: 1 } }]);
    expect(
      spans.getFinishedSpans().find((s) => s.name === 'musterd.inbox.received'),
    ).toBeUndefined();
  });
});
