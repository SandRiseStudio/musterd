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
  recordLoopClosure,
  recordTokenUsage,
  registerRuntimeGauges,
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

  it('observes the runtime gauges (presence.active by surface, inbox.lag) on collect', async () => {
    registerRuntimeGauges({
      presenceBySurface: () => [
        { surface: 'cli', count: 1 },
        { surface: 'claude-code', count: 2 },
      ],
      inboxLagMs: () => 12_000,
      openLoops: () => 3,
    });

    const { resourceMetrics } = await reader.collect();
    const all = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);

    const active = all.find((m) => m.descriptor.name === 'musterd.presence.active')!;
    expect(active).toBeTruthy();
    const bySurface = Object.fromEntries(
      active.dataPoints.map((dp) => [dp.attributes['musterd.surface'], dp.value]),
    );
    expect(bySurface).toEqual({ cli: 1, 'claude-code': 2 });

    const lag = all.find((m) => m.descriptor.name === 'musterd.inbox.lag')!;
    expect(lag.dataPoints[0]!.value).toBe(12_000);

    const loops = all.find((m) => m.descriptor.name === 'musterd.coordination.open_loops')!;
    expect(loops.dataPoints[0]!.value).toBe(3);
  });

  it('records coordination loop latency by closing act (ADR 082 slice 3)', async () => {
    recordLoopClosure('accept', 250);
    recordLoopClosure('resolve', 1_000);

    const { resourceMetrics } = await reader.collect();
    const all = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    const hist = all.find((m) => m.descriptor.name === 'musterd.coordination.loop_latency')!;
    expect(hist).toBeTruthy();
    const byAct = Object.fromEntries(
      hist.dataPoints.map((dp) => [dp.attributes['musterd.act'], dp.value]),
    ) as Record<string, { count: number; sum: number }>;
    expect(byAct['accept']!.count).toBe(1);
    expect(byAct['accept']!.sum).toBe(250);
    expect(byAct['resolve']!.sum).toBe(1_000);
  });

  it('records self-reported meta.usage tokens by member/direction; ignores junk (ADR 082 slice 4)', async () => {
    recordTokenUsage(
      env({
        id: 'e5',
        meta: { usage: { input_tokens: 100, output_tokens: 40, model: 'claude-opus-4-8' } },
      }),
    );
    recordTokenUsage(env({ id: 'e6', meta: { usage: { input_tokens: 'lots' } } })); // ignored
    recordTokenUsage(env({ id: 'e7' })); // no usage — ignored

    const { resourceMetrics } = await reader.collect();
    const all = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    const tokens = all.find((m) => m.descriptor.name === 'musterd.agent.tokens')!;
    expect(tokens).toBeTruthy();
    const byDir = Object.fromEntries(
      tokens.dataPoints.map((dp) => [dp.attributes['musterd.token.direction'], dp]),
    );
    expect(byDir['input']!.value).toBe(100);
    expect(byDir['output']!.value).toBe(40);
    expect(byDir['input']!.attributes['musterd.member']).toBe('Ada');
    expect(byDir['input']!.attributes['musterd.model']).toBe('claude-opus-4-8');
  });
});
