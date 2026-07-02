# 015 — OpenTelemetry Layer 1: minimal native server instrumentation

- Status: accepted
- Date: 2026-06-15

## Context

`docs/design/observability.md` §4 sets the near-term observability goal: **minimal but native** instrumentation of `@musterd/server` — one span on the single hot path plus a small, standards-aligned metric set — designed in early rather than retrofitted. ADR 011 defined the `meta.otel` trace-context convention to record. This is the first instrumentation milestone (roadmap §E / observability.md §6 step 1).

## Decision

Add an env-gated OpenTelemetry layer to `@musterd/server` (`packages/server/src/telemetry.ts`):

- **One span per Envelope** — `musterd.envelope.process`, wrapping the shared validate→persist→route path (`routeEnvelope`). Attributes are namespaced `musterd.*`: `team`, `act`, `from`, `to.kind`, `envelope.id`, `thread` (when present), and `otel.traceparent` from `meta.otel` (ADR 011), joining the server span to the sender's cross-runtime trace. **Never the body** — content is the operator's data, not telemetry.
- **Metrics:** `musterd.envelopes` (counter; team/act/to.kind), `musterd.delivery.latency` (histogram, ms), `musterd.errors` (counter; by class, recorded at the transport boundary), `musterd.presence.churn` (counter; attach/detach by surface). *(Follow-on, same session: the two §4 observable gauges `musterd.presence.active` and `musterd.inbox.lag` — DB-sampled via `store/metrics.ts` + `registerRuntimeGauges` — were added too, completing the §4 metric set under this ADR.)*
- **Off by default.** Telemetry starts only when a standard OTLP endpoint env var is present (`OTEL_EXPORTER_OTLP_ENDPOINT` / `_TRACES_` / `_METRICS_`), and never when `OTEL_SDK_DISABLED=true`. No musterd-specific config; no phone-home — emits only to operator-configured endpoints.
- **Zero-cost when off.** Only `@opentelemetry/api` is imported eagerly (its calls are no-ops without a registered provider); the heavy `@opentelemetry/sdk-node` + OTLP exporters are **dynamically imported** inside `startTelemetry()` and load only when enabled. Instruments are created lazily so they bind to the real meter once the SDK registers a provider.

This touches ADR 002's dependency discipline; the OTel SDK is the one justified addition, exactly as observability.md §4 flagged. No SPEC change and no version bump — telemetry is implementation-level and SPEC.md stays silent on it (observability.md §7).

## Consequences

- Acceptance met: with `OTEL_EXPORTER_OTLP_ENDPOINT` pointed at any OTLP backend, a sent message produces the envelope span (correct `act`/`team`) and moves the counters. Verified by an in-memory-exporter test (span attributes, no body, traceparent, error status, counters) and a live SDK-boot smoke.
- ADR 011 promoted **proposed → accepted**: the server now records `traceparent` as a span attribute, its first implementation. `@musterd/mcp` emitting/honoring `meta.otel` remains the next step (observability.md §6 step 2).
- The Layer 2 coordination-observability views (`observability.md` §5, the **batond** thesis) are unchanged and unblocked by this. The §4 metric set is now complete (gauges included); the next observability step is a full CLI/MCP telemetry SDK.

> **Extended by ADR 082 (2026-07-01).** This SDK is now booted by default on the *dogfood* daemon (to a local OTLP sink), and the metric set grew beyond §4: coordination `loop_latency` + `open_loops`, the opt-in `agent.tokens` counter, and a structured HTTP request log. The product default stays off / no-phone-home.
- One server per process is assumed for the global SDK provider; `startTelemetry` is idempotent across multiple `createServer` calls in a process (returns the first start).
