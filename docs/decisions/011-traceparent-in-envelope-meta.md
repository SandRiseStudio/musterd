# 011 — W3C trace context rides in `Envelope.meta.otel`

- Status: proposed
- Date: 2026-06-11

## Context

OpenTelemetry is the settled telemetry standard for agent systems (GenAI semantic conventions stable for client spans since early 2026; agent spans experimental-but-stable). Every major agent runtime can emit OTel traces, but each agent's trace ends at its own process boundary: when agent A hands work to agent B through musterd, A's trace and B's trace are unrelated in any backend. Nobody can see the handoff as one causal chain.

SPEC.md §2 already gives us the extension point: `meta` is act-specific, and **unknown `meta` keys MUST be accepted and preserved**. So trace context can ride in Envelopes today with zero spec change.

## Problem

Without a convention, every client would invent its own key (`meta.traceparent`, `meta.trace_id`, `meta.otel_ctx`, …) and cross-agent trace linking — the single highest-leverage observability feature the protocol enables — would fragment before it exists.

## Decision

Define a **recommended convention** (not a v0.1 conformance requirement) for carrying [W3C Trace Context](https://www.w3.org/TR/trace-context/) in Envelopes:

```jsonc
"meta": {
  "otel": {
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "tracestate": "vendor=value"          // optional
  }
}
```

- **Senders** SHOULD attach their current active trace context as `meta.otel` when one exists.
- **Receivers** SHOULD use it as a span **link** (not parent) when starting work caused by the Envelope — the sender's trace likely lives in a different backend; a link records causality without claiming ownership.
- **Servers** MUST treat `meta.otel` as opaque passthrough (which the spec already guarantees) and SHOULD record `traceparent` as an attribute on their own envelope-processing spans, so server traces join the chain too.
- The key is namespaced under `otel` (not bare `traceparent`) to leave room for `tracestate` and future `baggage` without claiming more of the flat `meta` namespace.

First implementations: `@musterd/server` span attributes (observability design §4) and `@musterd/mcp` emit/honor.

## Consequences

- Cross-runtime, cross-vendor distributed tracing through the coordination layer — agent A's trace in one backend links to agent B's in another, through the handoff Envelope. As of mid-2026 no product offers this; it is the technical seed of the coordination-observability product (`docs/design/observability.md` §5).
- No spec change and no version bump now. If dogfooding proves the convention out, promote it to SHOULD language in SPEC.md at the next MINOR (v0.2/v0.3), which is additive and backward-compatible.
- Clients that ignore the convention lose nothing; Envelopes remain valid.
- Body/content privacy is unaffected — trace context carries ids, not data.
