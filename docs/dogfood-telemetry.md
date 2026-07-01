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

## Coordination metrics (slice 3 — the server-derivable half)

The route path now emits first-party what finding 001 had to reconstruct:

- **`musterd.coordination.loop_latency`** (histogram, ms, by closing `musterd.act`) — accept/decline
  measured against the request_help/handoff they answer (`meta.in_reply_to`); resolve against its
  thread root. This is the "directed-act latency" + resolve-side of the finding.
- **`musterd.coordination.open_loops`** (gauge) — request_help/handoff acts not yet answered by an
  accept/decline, sampled on each metric collection.
- Act mix / resolve-rate are already derivable from the per-act `musterd.envelopes` counter.

Not emittable server-side (needs harness/git data → slice 4): coordination-token ratio, wasted-work
ratio, dup-rate.

## HTTP request log (slice 2)

Every HTTP request now logs a structured `http_request` line — `method` / `path` / `status` / `ms` —
info on 2xx/3xx, **warn on 4xx, error on 5xx** (errors land in `daemon.err.log`, which finding 001
found empty by design). Path only, never query/headers (no secrets); healthy `/health` polls are
skipped so the CLI guard doesn't drown the log.

## Per-agent token usage (slice 4 — the in-band half)

Any sender can self-report its harness token usage by attaching **`meta.usage`** to any act:

```jsonc
{ "act": "status_update", "body": "…", "meta": { "usage": { "input_tokens": 12000, "output_tokens": 800, "model": "claude-opus-4-8" } } }
```

The route path emits it as **`musterd.agent.tokens`** (counter, by `musterd.member` /
`musterd.token.direction` / `musterd.model`). Opt-in and harness-agnostic — in-band self-report is the
only path that covers non-Claude harnesses (finding 001: a Cursor/GLM agent's transcript was
unrecoverable). Numbers only; junk is ignored.

## Not yet closed (ADR 082 follow-ups)

An automatic usage emitter (hook/wrapper that reads harness transcripts and attaches `meta.usage`);
the git-side metrics (wasted-work ratio, dup-rate — lanes territory); a cross-agent distributed trace
over ADR 011 traceparent propagation.
