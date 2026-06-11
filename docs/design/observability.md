# musterd — Telemetry & observability

> **Living document.** Initial direction, not gospel. Substantive changes go through an ADR (`docs/decisions/`). Status: **draft**, 2026-06-11.

This doc sets the observability strategy for musterd: what we instrument from day one, what we deliberately do not build, and the longer-term product thesis — **coordination observability** — that turns musterd's message log into something no agent-observability vendor can offer.

---

## 1. Why now

Telemetry retrofitted onto a mature codebase is always worse than telemetry designed in: the span boundaries don't match the architecture, the interesting events were never emitted, and the migration touches everything. musterd is early enough to avoid that. The goal for v0.x is **minimal but native**: a thin, standards-aligned instrumentation layer on the server's single hot path, cheap enough to never slow development down, structured well enough to grow into the product vision in §5.

## 2. Market snapshot (mid-2026)

Three facts shape the strategy:

1. **The single-agent observability layer is crowded and converging.** LangSmith, Langfuse (acquired by ClickHouse, Jan 2026), Braintrust, Arize Phoenix/AX, Helicone, Galileo, Maxim, Laminar, plus Datadog/New Relic/Honeycomb LLM observability — all compete on tracing LLM calls, token/cost accounting, prompt management, and evals. This is commodity ground; we do not build here.
2. **OpenTelemetry is the settled standard.** The OTel GenAI semantic conventions exited experimental for client spans in early 2026; agent/framework span conventions are still experimental but stable in practice. Major frameworks (LangChain, CrewAI, AutoGen) emit OTel-compliant spans; every major backend ingests OTLP. Anything we emit in this format is portable to the entire market.
3. **The coordination layer is nearly empty.** Every tool above observes the *inside of one agent*. Observability of the space *between* agents and humans — handoffs, help requests, blocking waits, ignored messages, coordination breakdowns — exists as research (MAST, LumiMAS, the AgentOps taxonomy papers), not as products. Per MAST (arXiv 2503.13657), ~79% of multi-agent failures happen in exactly that space — the space musterd's protocol already structures.

Key references: [OTel GenAI semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/), [OTel agent span conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/), [OTel blog: GenAI observability](https://opentelemetry.io/blog/2026/genai-observability/), MAST (arXiv 2503.13657), AgentOps taxonomy (arXiv 2411.05285), LumiMAS (arXiv 2508.12412).

## 3. Position

**musterd does not compete with agent observability tools — it completes them.** They see inside each agent; musterd sees between them, and links the two via OTel trace context (ADR 011). This is a partnership story with the whole market, not a fight with any of it.

Two layers, with a hard line between them:

| Layer | What | Build or buy |
|-------|------|--------------|
| **1. Operating musterd** | OTel instrumentation of the server, CLI, and MCP adapter. Spans, metrics, structured logs. | **Build the emission** (thin, OTLP-out). **Buy the backend** — any OTLP-compatible tool the operator already has. |
| **2. Coordination observability** | MAST-aware insight derived from the act-typed message log; cross-agent trace linking. A product in its own right (see §5 and `docs/design/brand-coordination-observability.md`). | **Build.** Nobody else has the substrate. |

### What we will not build (the buy side)

- Trace storage / a spans database — export OTLP, let Langfuse/Braintrust/Phoenix/Datadog/ClickHouse store it.
- Generic LLM-call dashboards, token/cost accounting, prompt management.
- An eval platform.

If a future feature looks like one of these, the default answer is "integrate, don't build" — overriding that requires an ADR.

## 4. Layer 1 — instrumenting musterd (v0.x, minimal)

Scope: `@musterd/server` first; CLI and MCP adapter only get error/diagnostic logging until there's a reason for more.

### Spans

One span per Envelope on the single validate→persist→route path (`musterd.envelope.process`), with child spans only where work actually fans out (per-recipient delivery). Attributes use the five glossary terms, namespaced `musterd.*`, plus GenAI semconv attributes where they apply:

- `musterd.team`, `musterd.act`, `musterd.from`, `musterd.to.kind`, `musterd.envelope.id`, `musterd.thread` (when present)
- Never the `body` — message content is the operator's data, not telemetry. Content capture, if ever wanted, is a separate opt-in following the OTel GenAI events convention.

### Metrics

- `musterd.envelopes` (counter; by team, act, to.kind)
- `musterd.delivery.latency` (histogram; send → deliver, live path)
- `musterd.inbox.lag` (gauge/histogram; per-member cursor age — how stale the slowest inbox is)
- `musterd.presence.active` (gauge; by surface), `musterd.presence.churn` (counter; attach/detach)
- `musterd.errors` (counter; by class: validation, version_mismatch, auth)

### Configuration

- **Off by default.** Enabled via standard OTel env vars (`OTEL_EXPORTER_OTLP_ENDPOINT` etc.) — present means on. No musterd-specific telemetry config in v0.x.
- No vendor SDKs; `@opentelemetry/sdk-node` + OTLP exporter only (dependency-budget note: this touches ADR 002's dependency discipline; the OTel SDK is the one justified addition).
- **No phone-home, ever.** musterd emits telemetry only to endpoints the operator configures. If product-usage analytics are ever wanted, that is a separate, explicit, opt-in decision with its own ADR.

### Acceptance for the first milestone

Run the server with `OTEL_EXPORTER_OTLP_ENDPOINT` pointed at any OTLP backend; send a team message via the CLI; see the envelope span with correct act/team attributes and the counters move. That's it — a day or two of work, not a project.

## 5. Layer 2 — coordination observability (the product thesis)

The message log is already structured telemetry: typed acts with timestamps, threads, and durable identity are precisely the events MAST says you need to diagnose coordination failure. Two pillars:

### a. Cross-agent trace propagation (ADR 011)

Clients carry W3C trace context in `meta.otel`. When agent A hands off to agent B, B's trace — in whatever backend B's runtime uses — links back to A's through the Envelope. Cross-runtime, cross-vendor distributed tracing through a coordination protocol; no spec change needed because unknown `meta` keys are already preserved.

### b. MAST-aware insight over the log

Derived **views over the message log — never stored beside it** (same principle as the board/insight layer in `ROADMAP.md`):

- time-to-unblock (`request_help` → `accept`/resolution)
- handoff acceptance/decline rates, handoff latency
- unanswered `request_help` (the "shouting into the void" detector — MAST's *ignored agent input*)
- `wait` duration and what released it; the human "waiting-on" bottleneck view
- thread health: stalled threads, step repetition, circular handoffs (MAST's *coordination breakdown* class)

All Goodhart and human-vs-agent measurement cautions in `docs/design/human-agent-dynamics.md` §4 apply with full force here — these are diagnostic instruments, not performance scores.

### Standalone ambition

This layer should ship as its **own product** (working name **batond**, reversible — see `docs/design/brand-coordination-observability.md` §5): it ingests musterd logs natively but also plain OTel GenAI/agent spans, so teams not running musterd can still use the coordination lens. The protocol stays MIT and self-sufficient; the insight product must never become a requirement for using musterd.

## 6. Sequencing

1. **Now (v0.2/M-next):** Layer 1 server instrumentation (§4). ADR 011 accepted as a recommended convention.
2. **With first SDK/adapters that own an OTel context:** emit/honor `meta.otel` in `@musterd/mcp` and examples.
3. **With the web dashboard:** first derived coordination views (time-to-unblock, waiting-on), per the roadmap's insight-layer entry.
4. **Later, by explicit decision:** the standalone product (§5), once dogfooding proves which views matter.

## 7. Non-goals

- Observability of agent internals (reasoning steps, LLM calls) — that's the existing market's job; we link to it, we don't replicate it.
- Telemetry as a conformance requirement: SPEC.md stays silent on telemetry; all of this is implementation- and product-level.
- Any metric that ranks Members. See human-agent-dynamics §4.
