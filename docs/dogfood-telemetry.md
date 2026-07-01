# Dogfood telemetry — instrument-by-default (ADR 082, slice 1)

The dogfood daemon boots OpenTelemetry by default so the **next multi-agent session is measurable live**
instead of reconstructed forensically (lab-notebook finding 001). Layer 1 (ADR 015) already emits the
envelope span + coordination metrics; this wires it to a local sink on the machine that runs the daemon.

> **Scope.** This is the *dogfood* posture — the daemons we operate. The **product** default stays
> off / no-phone-home (users opt in via the standard OTel env vars, `observability.md` §config). The
> sink here is the throwaway **interim stand-in for batond** (ADR 082): emission is pure OTLP, so batond
> — or any real collector — replaces the *endpoint*, never the instrumentation.

## What's wired (machine-local, not committed)

Two LaunchAgents under `~/Library/LaunchAgents/` (macOS):

| LaunchAgent | Role |
| --- | --- |
| `studio.sandrise.musterd.plist` | the daemon; its `EnvironmentVariables` now set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (and `OTEL_METRIC_EXPORT_INTERVAL=5000` for a snappy dogfood cadence) |
| `studio.sandrise.musterd-otel-sink.plist` | runs [`scripts/dev-otel-sink.mjs`](../scripts/dev-otel-sink.mjs) — a minimal OTLP/HTTP receiver on `:4318` that logs spans + metric data points to `~/.musterd/otel-sink.log` |

The daemon's L1 SDK (`packages/server/src/telemetry.ts`) uses the **OTLP/HTTP (JSON)** exporters, so it
POSTs to `.../v1/traces` and `.../v1/metrics` — which the dev sink parses directly (no protobuf, no
external dependency).

## Verify it's live

```sh
# 1. daemon booted telemetry?
grep telemetry_on ~/.musterd/daemon.log        # → endpoint=http://localhost:4318

# 2. route an act, then watch the sink capture the span + counters
musterd send --act status_update 'telemetry check'
tail -f ~/.musterd/otel-sink.log
#   span "musterd.envelope.process" musterd.team=… musterd.act=status_update musterd.from=…
#   metric "musterd.envelopes" points=[1]   (+ presence.active, delivery.latency, presence.churn, inbox.lag)
```

Reload after editing the daemon plist so launchd picks up the new env:
`launchctl unload <plist> && launchctl load <plist>` (bounces the daemon — heads-up teammates first;
a standing grant re-occupies seats zero-touch).

## Swapping in a real collector / batond

Point the daemon's `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP backend and stop the dev-sink LaunchAgent:

- **All-in-one (traces + metrics + UI), when Docker is running:**
  `docker run -p 4317:4317 -p 4318:4318 -p 3000:3000 grafana/otel-lgtm` → Grafana on `:3000`.
- **batond** (the coordination-observability product, ADR 082 / `observability.md` §5): becomes just
  another OTLP endpoint — no re-instrumentation.

Rejected as the primary sink (ADR 082): **Langfuse** (its LLM-trace/generation model doesn't fit
coordination spans) and **PostHog** (event-analytics, not OTLP-native, and funneling our own coordination
metrics into a generic analytics tool undercuts the batond thesis).

## Not yet closed (later slices, ADR 082)

Slice 1 is emission-on. Still open from finding 001: HTTP-layer structured logging on `daemon.log`
(slice 2); first-party emission of the derived coordination metrics — coordination-token ratio,
wasted-work ratio, resolve-rate, dup-rate (slice 3); per-agent token/cost + a cross-agent coordination
trace (slice 4).
