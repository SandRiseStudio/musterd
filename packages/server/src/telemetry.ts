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
  loopLatency: Histogram;
  agentTokens: Counter;
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
    loopLatency: meter.createHistogram('musterd.coordination.loop_latency', {
      description:
        'Time to close a coordination loop: accept/decline → the request_help/handoff it answers, resolve → its thread root (finding 001 "directed-act latency", ADR 082 slice 3)',
      unit: 'ms',
    }),
    agentTokens: meter.createCounter('musterd.agent.tokens', {
      description:
        'Self-reported harness token usage (meta.usage on any act), by member/direction/model (ADR 082 slice 4)',
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

/**
 * Record a closed coordination loop (ADR 082 slice 3): `closingAct` is accept/decline (answering a
 * request_help/handoff via meta.in_reply_to) or resolve (closing its thread root). Emitted first-party
 * instead of being reconstructed from the message DB (finding 001's "directed-act latency").
 */
export function recordLoopClosure(closingAct: string, latencyMs: number): void {
  ix().loopLatency.record(latencyMs, { 'musterd.act': closingAct });
}

/**
 * Record self-reported token usage a sender attached as `meta.usage` (ADR 082 slice 4):
 * `{ input_tokens?, output_tokens?, model? }`. Opt-in and harness-agnostic — any agent that knows
 * its own usage can report it in-band, which is the only path that covers non-Claude harnesses
 * (finding 001: riley's transcript was unrecoverable). Numbers only; nothing else is read.
 */
export function recordTokenUsage(env: Envelope): void {
  const usage = (env.meta as { usage?: unknown } | null | undefined)?.usage;
  if (typeof usage !== 'object' || usage === null) return;
  const u = usage as { input_tokens?: unknown; output_tokens?: unknown; model?: unknown };
  const model = typeof u.model === 'string' ? { 'musterd.model': u.model } : {};
  for (const [dir, val] of [
    ['input', u.input_tokens],
    ['output', u.output_tokens],
  ] as const) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      ix().agentTokens.add(val, {
        'musterd.member': env.from,
        'musterd.token.direction': dir,
        ...model,
      });
    }
  }
}

/** Count a presence attach/detach for churn (observability.md §4). */
export function recordPresenceChurn(event: 'attach' | 'detach', surface?: string): void {
  ix().presenceChurn.add(1, {
    'musterd.presence.event': event,
    ...(surface ? { 'musterd.surface': surface } : {}),
  });
}

/** Snapshot supplier for the observable gauges — injected so telemetry stays free of SQL/ctx. */
export interface RuntimeSampler {
  presenceBySurface: () => { surface: string; count: number }[];
  inboxLagMs: () => number;
  /** Directed acts (request_help/handoff) not yet answered by an accept/decline (ADR 082 slice 3). */
  openLoops: () => number;
}

/**
 * Register the observable gauges sampled on each metric collection (observability.md §4):
 * `musterd.presence.active` (live presences by surface) and `musterd.inbox.lag` (how stale the
 * slowest inbox is). No-op without a registered provider — the callback never fires (no DB sampling)
 * when telemetry is off, so this is safe to call unconditionally.
 */
export function registerRuntimeGauges(sampler: RuntimeSampler): void {
  const meter = metrics.getMeter(SCOPE);
  const active = meter.createObservableGauge('musterd.presence.active', {
    description: 'Live presences, by surface',
  });
  const lag = meter.createObservableGauge('musterd.inbox.lag', {
    description: 'Age of the slowest inbox (oldest unread message)',
    unit: 'ms',
  });
  const openLoops = meter.createObservableGauge('musterd.coordination.open_loops', {
    description:
      'request_help/handoff acts not yet answered by an accept/decline (ADR 082 slice 3)',
  });
  meter.addBatchObservableCallback(
    (obs) => {
      for (const row of sampler.presenceBySurface()) {
        obs.observe(active, row.count, { 'musterd.surface': row.surface });
      }
      obs.observe(lag, sampler.inboxLagMs());
      obs.observe(openLoops, sampler.openLoops());
    },
    [active, lag, openLoops],
  );
}
