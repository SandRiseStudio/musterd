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
3. **The coordination layer is nearly empty.** Every tool above observes the _inside of one agent_. Observability of the space _between_ agents and humans — handoffs, help requests, blocking waits, ignored messages, coordination breakdowns — exists as research (MAST, LumiMAS, the AgentOps taxonomy papers), not as products. Per MAST (arXiv 2503.13657), ~79% of multi-agent failures happen in exactly that space — the space musterd's protocol already structures. This isn't only a research claim: even credible 2026 frameworks demonstrate the gap by _delegating coordination to the substrate_. Flue (Astro team) builds deep per-agent durability and per-agent gen_ai OTel, then relies on the platform ("Cloudflare DOs are single-threaded per instance") for single-active and models nothing between agents — it stops exactly where musterd starts. See `docs/design/landscape.md`.

Key references: [OTel GenAI semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/), [OTel agent span conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/), [OTel blog: GenAI observability](https://opentelemetry.io/blog/2026/genai-observability/), MAST (arXiv 2503.13657), AgentOps taxonomy (arXiv 2411.05285), LumiMAS (arXiv 2508.12412).

## 3. Position

**musterd does not compete with agent observability tools — it completes them.** They see inside each agent; musterd sees between them, and links the two via OTel trace context (ADR 011). This is a partnership story with the whole market, not a fight with any of it.

Two layers, with a hard line between them:

| Layer                             | What                                                                                                                                                                             | Build or buy                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **1. Operating musterd**          | OTel instrumentation of the server, CLI, and MCP adapter. Spans, metrics, structured logs.                                                                                       | **Build the emission** (thin, OTLP-out). **Buy the backend** — any OTLP-compatible tool the operator already has. |
| **2. Coordination observability** | MAST-aware insight derived from the act-typed message log; cross-agent trace linking. A product in its own right (see §5 and `docs/design/brand-coordination-observability.md`). | **Build.** Nobody else has the substrate.                                                                         |

### What we will not build (the buy side)

- Trace storage / a spans database — export OTLP, let Langfuse/Braintrust/Phoenix/Datadog/ClickHouse store it.
- Generic LLM-call dashboards, token/cost accounting, prompt management.
- An eval platform **in musterd core**. The eval + experiment _engine_ is **batond's** domain (§5, ADR 051), not the protocol's — musterd core still builds none of it.

If a future feature looks like one of these, the default answer is "integrate, don't build" — overriding that requires an ADR.

### The flywheel (ADR 051)

The strategy above extends to evals and experiments as one loop — **observe (trace) → hypothesize → experiment → compare → promote → observe** — without crossing the build/buy line:

- **Emit in musterd, engine in batond.** musterd emits the coordination trace; batond runs the eval + experiment engine over it.
- **OTel wire, Langfuse semantics.** Wire format stays OTel (ADR 011/015, portable). For the higher-level objects — **prompt-as-versioned-artifact, datasets, scores, experiments** — batond adopts **Langfuse's data model/vocabulary** (OSS, OTel-compatible, a connected MCP surface) rather than inventing its own, and builds the coordination-semantic layer _on top_ — it does not rebuild the trace/prompt/score stores.
- **Coordination-native moat, both ends.** The trace unit is the _team task_ (coordination acts + agent-turn detail on one timeline); the eval unit is the _team outcome_ (did the human+agent team hit the Goal's definition-of-done — ADR 048's derived status / ADR 050's projections _are_ the eval signal); experiments vary **team topology**, not just `model × prompt × harness`. No single-agent vendor can do any of these.
- **Prompts opt-in + versioned; meta-evals = judge calibration; model currency measured** (frontier API + open via NIM/Ollama, compared on the cost × latency × quality frontier); and the **harness-decay thesis** — measure scaffolding's diminishing returns so we know when to delete complexity models have absorbed.

The day-to-day discipline that keeps this real — every agent-facing feature ships with traces + an eval — is the **definition-of-done gate, ADR 052** (`07-conventions.md`).

## 4. Layer 1 — instrumenting musterd (v0.x, minimal)

> **Status: ✅ shipped for `@musterd/server` (2026-06-15, ADR 015).** The envelope span and the **full metric set below** — including the two observable gauges (`musterd.presence.active`, `musterd.inbox.lag`, DB-sampled on collection) — are implemented and off-by-default. The adapter's `meta.otel` emit/honor (§6 step 2) is also done.
>
> **The client telemetry SDK is shipped too (2026-07-05, ADR 089 — Layer 2 increment 1).** The bootstrap moved to a shared `@musterd/telemetry` package (`telemetryEnabled` + `startTelemetry(serviceName, resource attrs)` + a bounded shutdown/flush; the heavy SDK stays dynamically imported). The server delegates to it (`musterd-server`); the MCP adapter boots it (`musterd-mcp`, seat identity as resource attributes) and wraps every tool in a `musterd.tool.call` span, so the §6-step-2 emit fires **in production**; the CLI boots it (`musterd-cli`) around a `musterd.cli.command` span — carve-outs: `serve` (daemon owns the process) and `inbox --interrupt-check` (ADR 088's sub-50ms budget). Same posture everywhere: off by default, no phone-home.

### File tree `packages/telemetry/src/`

```
src/
  index.ts // the shared OTLP bootstrap (ADR 089): telemetryEnabled + startTelemetry(serviceName, attrs) + bounded shutdown/flush
```

> **Instrument-by-default for dogfood (ADR 082, 2026-07-01).** The dogfood daemon now boots this SDK to a local OTLP sink so the next session is measurable live (finding 001), emission staying pure-OTLP (a local collector is an interim stand-in for batond). The product default stays off / no-phone-home. The metric set grew (below), plus a structured HTTP request log on `daemon.log`. Setup: `docs/dogfood-telemetry.md`.

Scope: `@musterd/server` first; CLI and MCP adapter only get error/diagnostic logging until there's a reason for more.

### Spans

One span per Envelope on the single validate→persist→route path (`musterd.envelope.process`), with child spans only where work actually fans out (per-recipient delivery). Attributes use the five glossary terms, namespaced `musterd.*`, plus GenAI semconv attributes where they apply:

- `musterd.team`, `musterd.act`, `musterd.from`, `musterd.from.id`, `musterd.to.kind`, `musterd.envelope.id`, `musterd.thread` (when present)
- Never the `body` — message content is the operator's data, not telemetry. Content capture, if ever wanted, is a separate opt-in following the OTel GenAI events convention.

**Identity attribution — key on `*.id`, never the raw name (issue #107).** A seat's durable identity is its name (ADR 058: the `seats/<name>.toml` stem; there is no rename, and the member-row id re-mints on reset), so any per-agent aggregation keyed on the raw display name fragments the moment it spans teams, resets, or naming-convention drift (`Miley` on one team vs `miley` on another is one actor, double-counted). Every per-agent dimension therefore carries a **normalized** identity (`normalizeSeatName` = NFC + trim + lower-case) as the keying attribute (`musterd.from.id`, `musterd.member.id`) while the raw name stays a secondary, human-readable label (`musterd.from`, `musterd.member`). Cross-daemon actor linkage beyond casing (genuinely distinct people who happen to normalize alike) is a downstream/query-time concern — the one-team-one-daemon model has no shared cross-team uuid to emit.

### Metrics

- `musterd.envelopes` (counter; by team, act, to.kind)
- `musterd.delivery.latency` (histogram; send → deliver, live path)
- `musterd.inbox.lag` (gauge/histogram; per-member cursor age — how stale the slowest inbox is)
- `musterd.presence.active` (gauge; by surface), `musterd.presence.churn` (counter; attach/detach)
- `musterd.errors` (counter; by class: validation, version_mismatch, auth)
- `musterd.coordination.loop_latency` (histogram; accept/decline/resolve → the act they close — the §5b time-to-unblock, emitted first-party) — ADR 082
- `musterd.coordination.open_loops` (gauge; request_help/handoff not yet answered — the §5b "shouting into the void" detector, emitted first-party) — ADR 082
- `musterd.agent.tokens` (counter; opt-in self-reported `meta.usage`, by normalized seat id `musterd.member.id` / direction / model, raw name as a label — harness-agnostic, covers non-Claude agents) — ADR 082, issue #107

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
- unanswered `request_help` (the "shouting into the void" detector — MAST's _ignored agent input_)
- `wait` duration and what released it; the human "waiting-on" bottleneck view
- thread health: stalled threads, step repetition, circular handoffs (MAST's _coordination breakdown_ class)

All Goodhart and human-vs-agent measurement cautions in `docs/design/human-agent-dynamics.md` §4 apply with full force here — these are diagnostic instruments, not performance scores.

The substrate for these views is the **per-recipient delivery ledger** (ADR 090, L2 increment 2 — design frozen 2026-07-06): per (act, recipient), `logged → seen → answered` (+ a derived `stale` label), **derived from the log + inbox cursors + the interrupt audit, never a delivery table**, with attempt history (live-push outcome, interrupt raises) living in telemetry. It adds `musterd.coordination.seen_latency` — the read-side twin of `loop_latency`, generalizing ADR 088's raised→read pair to every directed act — and surfaces as `GET …/messages/:id/delivery`, `musterd report delivery`, and a ledger block on `team_report`.

### Standalone ambition

This layer should ship as its **own product** (working name **batond**, reversible — see `docs/design/brand-coordination-observability.md` §5): it ingests musterd logs natively but also plain OTel GenAI/agent spans, so teams not running musterd can still use the coordination lens. batond is also the **home of the eval + experiment engine** (ADR 051) — Langfuse-shaped scores/datasets/experiments plus the coordination-native additions (team-outcome evals, team-topology experiments) — built on a bought backend, never a from-scratch store. The protocol stays MIT and self-sufficient; the insight product must never become a requirement for using musterd.

**First non-musterd ingestion target: Flue.** Flue's `@flue/opentelemetry` emits `workflow → operation → turn → tool` gen*ai spans, and its `task` tool produces a parent→child agent tree — a minimal multi-agent topology batond can render with \_zero* musterd involved. That makes Flue the cleanest proof of the "native, not captive" claim (a real third-party framework, not a strawman) and de-risks the "captive to musterd" criticism before musterd ingestion exists. Mirror Flue's two ingestion-relevant hooks — `exportContent` (content redaction) and `resolveRootContext` (parent-trace stitching) — in batond's ingestion design. Caveat and moat: Flue has _no_ cross-agent attributes (no waits/contention/blocking) — deriving the between-view is the work, not a shortcut. See `docs/design/landscape.md` §3.

## 6. Sequencing

1. ~~**Now (v0.2/M-next):** Layer 1 server instrumentation (§4). ADR 011 accepted as a recommended convention.~~ ✅ **done (ADR 015)** — server envelope span + counters/histogram, off by default; ADR 011 accepted, server records `traceparent`. (Deferred within §4: the two observable gauges.)
2. ~~**With first SDK/adapters that own an OTel context:** emit/honor `meta.otel` in `@musterd/mcp` and examples.~~ ✅ **done** — the adapter emits its active trace context as `meta.otel` on `team_send` and links incoming `meta.otel` on `team_inbox_check` (ADR 011; `packages/mcp/src/otel.ts`). ✅ **Live in production since ADR 089** (2026-07-05): the shared `@musterd/telemetry` SDK boots in the adapter and the CLI, the adapter's `musterd.tool.call` span supplies the active context, and the CLI's `send` attaches `meta.otel` the same way — the cross-agent distributed trace exists end-to-end.
   2b. ~~**Instrument-by-default + the finding-001 gaps:**~~ ✅ **done (ADR 082, 2026-07-01)** — the dogfood daemon boots the SDK to a local sink; a structured HTTP request log; first-party coordination metrics (`loop_latency`, `open_loops`) + opt-in per-agent tokens (`meta.usage`). Two §5b views (time-to-unblock, the void-detector) landed early as _emitted metrics_ rather than waiting for derived views over the log.
3. ~~**With the report surfaces:** first derived coordination views (time-to-unblock, waiting-on,
   broadcast-journal density).~~ ✅ **done** — the server-side insight engine exposes them through
   `musterd report` and `team_report` (ADR 050 / PRs #82 and #84; ADR 091 for the MAST views). The
   remaining web-dashboard work is the insight rail in the roadmap's web insight-layer entry.
4. **Later, by explicit decision:** the standalone product (§5), once dogfooding proves which views matter.

## 7. Non-goals

- Observability of agent internals (reasoning steps, LLM calls) — that's the existing market's job; we link to it, we don't replicate it.
- Telemetry as a conformance requirement: SPEC.md stays silent on telemetry; all of this is implementation- and product-level.
- Any metric that ranks Members. See human-agent-dynamics §4.
