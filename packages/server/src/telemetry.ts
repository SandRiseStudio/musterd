import { normalizeSeatName, type Envelope } from '@musterd/protocol';
import {
  resetTelemetryForTests as resetSdkForTests,
  startTelemetry as startSdk,
} from '@musterd/telemetry';
import { type Counter, type Histogram, metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { log } from './log.js';

/**
 * OpenTelemetry Layer 1 — minimal, native instrumentation of the server (observability.md §4; ADR
 * 015). One span per Envelope on the validate→persist→route path plus a small, standards-aligned
 * metric set. The bootstrap itself lives in `@musterd/telemetry` (ADR 089) — shared with the MCP
 * adapter and the CLI — and keeps the ADR 015 posture: **off by default** (starts only when a
 * standard OTLP endpoint env var is present), no phone-home. When off, the `@opentelemetry/api`
 * calls below are cheap no-ops, so the hot path pays effectively nothing.
 */

const SCOPE = 'musterd';

export { telemetryEnabled } from '@musterd/telemetry';

/**
 * Start the shared telemetry SDK as `musterd-server`, returning a shutdown hook (flushes
 * exporters). No-op + instant resolve when disabled; idempotent across multiple servers in one
 * process (the shared bootstrap starts once per process).
 */
export async function startTelemetry(
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  const handle = await startSdk({ serviceName: 'musterd-server', env });
  if (handle.active && !startLogged) {
    startLogged = true;
    log.info({ msg: 'telemetry_on', endpoint: handle.endpoint });
  }
  return () => handle.shutdown();
}
let startLogged = false;

/** Reset the start guard. Tests only — lets a suite register a fresh in-memory provider. */
export function resetTelemetryForTests(): void {
  resetSdkForTests();
  startLogged = false;
  instruments = null;
}

interface Instruments {
  envelopes: Counter;
  deliveryLatency: Histogram;
  errors: Counter;
  presenceChurn: Counter;
  loopLatency: Histogram;
  agentTokens: Counter;
  interruptCheck: Counter;
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
        'Self-reported harness token usage (meta.usage on any act), by normalized seat id (musterd.member.id, issue #107) / direction / model — musterd.member carries the raw display name (ADR 082 slice 4)',
    }),
    interruptCheck: meter.createCounter('musterd.interrupt.check', {
      description:
        'Tool-boundary interrupt-line probes, by result (silent | raised) — the mid-loop reachability primitive (ADR 088). result=raised is the delivery half of the steering-latency eval.',
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
    // Identity: key aggregation on the normalized seat name (issue #107), never the raw display name —
    // `Miley`/`miley` across teams/resets is one actor, and the raw name double-counts. The raw name
    // stays as a secondary, human-readable label.
    span.setAttribute('musterd.from', env.from);
    span.setAttribute('musterd.from.id', normalizeSeatName(env.from));
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
        // Key on the normalized seat id so per-agent token totals don't fragment across teams/resets
        // (issue #107); keep the raw name as a secondary label.
        'musterd.member.id': normalizeSeatName(env.from),
        'musterd.member': env.from,
        'musterd.token.direction': dir,
        ...model,
      });
    }
  }
}

/**
 * Count one tool-boundary interrupt-line probe by outcome (ADR 088): `silent` (nothing waiting — the
 * common, free path) or `raised` (an interrupt-class act was surfaced). The `raised` rate over sent
 * urgent acts is the delivery half of the steering-latency headline eval.
 */
export function recordInterruptCheck(result: 'silent' | 'raised'): void {
  ix().interruptCheck.add(1, { 'musterd.interrupt.result': result });
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
