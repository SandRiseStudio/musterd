import type { Envelope } from '@musterd/protocol';
import { type Counter, type Histogram, metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { log } from './log.js';

/**
 * OpenTelemetry Layer 1 — minimal, native instrumentation of the server (observability.md §4; ADR
 * 015). One span per Envelope on the validate→persist→route path plus a small, standards-aligned
 * metric set. **Off by default**: it only starts when a standard OTLP endpoint env var is present,
 * and emits only to operator-configured endpoints (no phone-home). When off, the `@opentelemetry/api`
 * calls below are cheap no-ops, so the hot path pays effectively nothing.
 */

const SCOPE = 'musterd';

/** Telemetry is on iff the operator points us at an OTLP endpoint (and hasn't disabled the SDK). */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['OTEL_SDK_DISABLED'] === 'true') return false;
  return Boolean(
    env['OTEL_EXPORTER_OTLP_ENDPOINT'] ||
    env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ||
    env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
  );
}

let started: Promise<() => Promise<void>> | null = null;

/**
 * Start the OTel NodeSDK if enabled, returning a shutdown hook (flushes exporters). No-op + instant
 * resolve when disabled. The heavy SDK is dynamically imported so a server with telemetry off never
 * loads it. Idempotent across multiple servers in one process (returns the same start).
 */
export function startTelemetry(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  if (started) return started;
  if (!telemetryEnabled(env)) {
    started = Promise.resolve(async () => {});
    return started;
  }
  started = (async () => {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'musterd-server' }),
      traceExporter: new OTLPTraceExporter(),
      metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
    });
    sdk.start();
    log.info({
      msg: 'telemetry_on',
      endpoint:
        env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
        env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ??
        env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
    });
    return async () => {
      await sdk.shutdown();
    };
  })();
  return started;
}

/** Reset the start guard. Tests only — lets a suite register a fresh in-memory provider. */
export function resetTelemetryForTests(): void {
  started = null;
  instruments = null;
}

interface Instruments {
  envelopes: Counter;
  deliveryLatency: Histogram;
  errors: Counter;
  presenceChurn: Counter;
}

// Created lazily on first use (i.e. after startTelemetry has registered a provider) so the
// instruments bind to the real meter rather than the no-op meter present at module load.
let instruments: Instruments | null = null;
function ix(): Instruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter(SCOPE);
  instruments = {
    envelopes: meter.createCounter('musterd.envelopes', {
      description: 'Envelopes processed, by team/act/recipient kind',
    }),
    deliveryLatency: meter.createHistogram('musterd.delivery.latency', {
      description: 'Time to persist + route an envelope on the live path',
      unit: 'ms',
    }),
    errors: meter.createCounter('musterd.errors', {
      description: 'Protocol/transport errors, by class',
    }),
    presenceChurn: meter.createCounter('musterd.presence.churn', {
      description: 'Presence attach/detach events, by surface',
    }),
  };
  return instruments;
}

const tracer = trace.getTracer(SCOPE);

/** W3C trace context a sender rode in `meta.otel` (ADR 011) — recorded as a span attribute. */
function traceparentOf(env: Envelope): string | undefined {
  const otel = (env.meta as { otel?: { traceparent?: unknown } } | null | undefined)?.otel;
  return typeof otel?.traceparent === 'string' ? otel.traceparent : undefined;
}

/**
 * Wrap the envelope process path in a `musterd.envelope.process` span and emit the envelopes counter
 * + delivery-latency histogram. Never the body — content is the operator's data, not telemetry (§4).
 * Errors mark the span; the error *count* is recorded at the transport boundary (`recordError`).
 */
export function withEnvelopeSpan<T>(env: Envelope, fn: () => T): T {
  const t0 = Date.now();
  return tracer.startActiveSpan('musterd.envelope.process', (span) => {
    span.setAttribute('musterd.team', env.team);
    span.setAttribute('musterd.act', env.act);
    span.setAttribute('musterd.from', env.from);
    span.setAttribute('musterd.to.kind', env.to.kind);
    span.setAttribute('musterd.envelope.id', env.id);
    if (env.thread) span.setAttribute('musterd.thread', env.thread);
    const tp = traceparentOf(env);
    if (tp) span.setAttribute('musterd.otel.traceparent', tp);
    try {
      const result = fn();
      const attrs = {
        'musterd.team': env.team,
        'musterd.act': env.act,
        'musterd.to.kind': env.to.kind,
      };
      ix().envelopes.add(1, attrs);
      ix().deliveryLatency.record(Date.now() - t0, { 'musterd.act': env.act });
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Count one error by protocol class (validation, version_mismatch, auth, …). Transport-boundary. */
export function recordError(errorClass: string): void {
  ix().errors.add(1, { 'musterd.error.class': errorClass });
}

/** Count a presence attach/detach for churn (observability.md §4). */
export function recordPresenceChurn(event: 'attach' | 'detach', surface?: string): void {
  ix().presenceChurn.add(1, {
    'musterd.presence.event': event,
    ...(surface ? { 'musterd.surface': surface } : {}),
  });
}
