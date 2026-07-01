# 082 — Instrument-by-default: boot OTel on dogfood daemons, a local OTLP collector as batond's stand-in

- Status: accepted
- Date: 2026-07-01

## Context

Lab-notebook finding 001 asked whether musterd's flagship multi-agent session (the P3 cutover — 4 agents,
~28 h, team `ritual`) was observable from musterd's **own** telemetry. The answer was **no**: the message
DB (171 acts) was the only full-fidelity trace, and everything else was reconstructed forensically after
the fact. Concretely:

- **OTel Layer 1 is built but was never booted.** `packages/server/src/telemetry.ts` (ADR 015) emits the
  envelope span + the full metric set, but the SDK only starts when `OTEL_EXPORTER_OTLP_ENDPOINT` (or a
  signal-specific variant) is set — it wasn't, so every span was a no-op and nothing exported.
- **`daemon.log` has no HTTP layer** — `route`/`ws_*`/`reap_*` only; no request/method/status/latency, and
  zero error/warn lines all session.
- **The audit log (ADR 071) records only _governed_ decisions** (reclaim/remove/grants/`send.denied`), so
  normal coordination left no audit trace.
- **No per-agent token/cost telemetry** — the cost split (coordination ≈ 1% of tokens, wasted work ≈ 37%
  of code) came from harness transcripts, and a non-Claude agent's is unrecoverable.
- **The coordination metrics we care about are computed by hand, never emitted.**

The posture in `observability.md` is deliberate: **build the emission (OTLP-out), buy the backend
("integrate, don't build")**, and stay off-by-default with **no phone-home** (emit only to an
operator-configured endpoint). Separately, **batond** — the coordination-observability standalone product
(the "second-product seed") — is the intended long-term home for coordination traces + evals, but today it
is only a name reservation. This ADR is the reprioritization's first build item (2026-07-01): remote join
(P4) deferred, telemetry-gaps pulled to the head of the build.

## Decision

**Turn instrumentation on for our own dogfood daemons, keep emission pure-OTLP, and treat the sink as a
replaceable stand-in for batond.**

1. **Instrument-by-default for _dogfood_ daemons — not a product default flip.** The dogfood daemon's
   environment (the macOS LaunchAgent that runs `serve`) sets `OTEL_EXPORTER_OTLP_ENDPOINT`, so every
   dogfood session exports live. The **product** default stays **off / no phone-home** (users opt in via
   the standard OTel env vars, `observability.md` §config, ADR 015) — "instrument-by-default" scopes to the
   daemons *we* run, so the next multi-agent session is measurable live instead of reconstructed.

2. **Sink = a local OTLP collector, framed as batond's interim stand-in.** The emission stays **pure
   OTLP** (already true — the L1 SDK is vendor-neutral), and the sink is a local collector
   (otel-collector → Jaeger/Tempo for traces, Prometheus/Grafana for metrics). batond later becomes just
   another `OTEL_EXPORTER_OTLP_ENDPOINT` — it **replaces the sink, not the instrumentation**. Rejected
   alternatives: **Langfuse** (its model is LLM traces/generations/scores; musterd emits *coordination*
   spans, so the fit is a dead-end), and **PostHog** (event/product-analytics, **not OTLP-native** — it
   would fork the emission path, and routing our own coordination metrics into a generic analytics tool
   undercuts the batond thesis). A local collector also honors the no-phone-home rule for the dogfood box.

3. **Close the finding-001 gaps as phased slices, in build order:**
   - **Slice 1 — instrument-by-default (this reprioritization's first buildable step):** point the dogfood
     daemon at a local collector, boot the L1 SDK, and verify the envelope span + counters/histogram export
     live (the `observability.md` §"Acceptance for the first milestone" test).
   - **Slice 2 — HTTP-layer structured logging:** request/method/route/status/latency on `daemon.log` (and
     a real `daemon.err.log`).
   - **Slice 3 — first-party coordination metrics:** emit the ones finding 001 reconstructed by hand —
     coordination-token ratio, wasted-work ratio, directed-act latency, resolve-rate, dup-rate — as OTel
     metrics. These are the product-differentiating signal and the first candidate coordination *evals*.
   - **Slice 4 — per-agent token/cost + a coordination audit/trace trail:** the hardest (token/cost needs
     harness cooperation; some agents are unrecoverable) — scoped last.

## Consequences

- The next dogfood session is measurable **live**, not by archaeology — the sharpest argument for the
  batond line ("our own flagship session was near-unobservable") stops being true of us.
- Pure-OTLP + a replaceable sink means **no re-instrumentation** when batond arrives; the local collector
  is a scaffold, not a commitment.
- The coordination metrics become **first-party emissions**, the concrete inputs to Telemetry L2, the
  coordination-traces dataset, and the MAST-in-the-wild thesis — emitted, not reconstructed.
- Cost is contained: slice 1 is the `observability.md` "day or two, not a project" milestone; the heavier
  slices (2–4) are independently shippable and independently valuable.
- Does **not** change the product's privacy posture — off-by-default + no phone-home stays; only the
  daemons we operate get an exporter.

## Observability & Evaluation

This ADR *is* the observability work, so the section is load-bearing rather than a formality.

**Traces** — the ADR-015 envelope span (`withEnvelopeSpan`, `act`/`team`/`traceparent` attributes) begins
exporting live to the local collector; slice 4 extends the trace across agents via the ADR 011
`traceparent` propagation the adapter already records, so a directed act → delivery → reply chain becomes a
single distributed trace.

**Eval** — the coordination metrics emitted in slice 3 (coordination-token ratio, wasted-work ratio,
directed-act latency, resolve-rate, dup-rate) are exactly the first coordination **evals** (ADR 051/052) —
diagnostic instruments, not performance scores (the human-vs-agent Goodhart cautions in
`human-agent-dynamics.md` §4 apply). The obs-evals gate (ADR 052) is satisfied by emitting them from day
one rather than reconstructing them.

**Experiment** — once the metrics are first-party, team-topology and coordination-protocol experiments
(the ADR 051 flywheel, batond's reason to exist) become measurable: e.g. does the lanes primitive
(Wave 3) actually cut the wasted-work ratio? That A/B is only possible if the ratio is emitted, which is
why telemetry-gaps sequences ahead of lanes.
