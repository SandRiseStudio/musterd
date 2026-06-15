import type { Envelope } from '@musterd/protocol';
import { PROTOCOL_VERSION } from '@musterd/protocol';
import { metrics, trace } from '@opentelemetry/api';
import {
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  recordError,
  resetTelemetryForTests,
  telemetryEnabled,
  withEnvelopeSpan,
} from './telemetry.js';

describe('telemetryEnabled (off by default)', () => {
  it('is off with no OTEL env', () => {
    expect(telemetryEnabled({})).toBe(false);
  });
  it('is on when an OTLP endpoint is present', () => {
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toBe(true);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://x' })).toBe(true);
  });
  it('stays off when the SDK is explicitly disabled, even with an endpoint', () => {
    expect(
      telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x', OTEL_SDK_DISABLED: 'true' }),
    ).toBe(false);
  });
});

function env(partial: Partial<Envelope>): Envelope {
  return {
    id: 'e1',
    v: PROTOCOL_VERSION,
    team: 'dawn',
    from: 'Ada',
    to: { kind: 'team' },
    act: 'status_update',
    body: 'secret content',
    ts: 1,
    ...partial,
  } as Envelope;
}

describe('envelope instrumentation', () => {
  const spans = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(0);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter });

  beforeAll(() => {
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }),
    );
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
    // Rebind the lazily-created instruments to the freshly-registered test providers.
    resetTelemetryForTests();
  });
  afterAll(() => {
    trace.disable();
    metrics.disable();
  });

  it('emits a process span with musterd.* attributes and never the body', () => {
    const result = withEnvelopeSpan(env({ thread: 't1' }), () => 42);
    expect(result).toBe(42);

    const finished = spans.getFinishedSpans();
    const span = finished.find((s) => s.name === 'musterd.envelope.process');
    expect(span).toBeTruthy();
    expect(span!.attributes['musterd.team']).toBe('dawn');
    expect(span!.attributes['musterd.act']).toBe('status_update');
    expect(span!.attributes['musterd.to.kind']).toBe('team');
    expect(span!.attributes['musterd.thread']).toBe('t1');
    // Content is the operator's data, not telemetry — it must never become a span attribute.
    expect(JSON.stringify(span!.attributes)).not.toContain('secret content');
  });

  it('records the sender traceparent (meta.otel) as a span attribute (ADR 011)', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    withEnvelopeSpan(env({ id: 'e2', meta: { otel: { traceparent: tp } } }), () => null);
    const span = spans.getFinishedSpans().find((s) => s.attributes['musterd.envelope.id'] === 'e2');
    expect(span!.attributes['musterd.otel.traceparent']).toBe(tp);
  });

  it('marks the span errored and rethrows when the work throws', () => {
    expect(() =>
      withEnvelopeSpan(env({ id: 'e3' }), () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const span = spans.getFinishedSpans().find((s) => s.attributes['musterd.envelope.id'] === 'e3');
    expect(span!.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('moves the envelopes counter and the errors counter', async () => {
    withEnvelopeSpan(env({ id: 'e4' }), () => null);
    recordError('version_mismatch');

    const { resourceMetrics } = await reader.collect();
    const all = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    const names = all.map((m) => m.descriptor.name);
    expect(names).toContain('musterd.envelopes');
    expect(names).toContain('musterd.errors');
    expect(names).toContain('musterd.delivery.latency');

    const envelopes = all.find((m) => m.descriptor.name === 'musterd.envelopes')!;
    const total = envelopes.dataPoints.reduce((n, dp) => n + (dp.value as number), 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });
});
