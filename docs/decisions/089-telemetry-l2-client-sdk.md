# 089 — Telemetry Layer 2, increment 1: the client telemetry SDK

- Status: accepted
- Date: 2026-07-05

## Context

Layer 1 is verified emitting live (ADR 015 built it, ADR 082 turned it on for dogfood daemons), and
lab-notebook finding 002 proved the data is already useful: ~53 h of the local sink, mined by hand,
caught the broadcast-journal anti-pattern, an ~70 h unclosed directed loop, and the absent-human gap.
The identity-attribution prerequisite is fixed (issue #107: every per-agent dimension keys on the
normalized seat id, raw name as a label). That pulled **Telemetry Layer 2** to the head of Wave 5
(`ROADMAP.md`): the SDK + MAST-aware views that turn "grep a text log" into first-class coordination
observability.

Three gaps define the arc:

1. **Client-side emission is built but inert.** The adapter's ADR 011 plumbing
   (`packages/mcp/src/otel.ts`) attaches `meta.otel` on `team_send` and links sender traces on
   `team_inbox_check` — but only under a _host-provided_ trace context. No OTel SDK ever boots in the
   adapter or CLI process, so in production there is no active span, `meta.otel` is never attached,
   and the cross-agent distributed trace ADR 082 slice 4 deferred cannot exist. `observability.md` §4
   has carried "still to come: a full CLI/MCP telemetry SDK" since ADR 015.
2. **No per-recipient delivery status.** A directed act's journey (delivered → seen → answered) is
   reconstructed from gauges (`inbox.lag`, `open_loops`), not recorded per recipient. ADR 088's
   raised→read pair is the seed of exactly that signal; band.ai ships per-recipient
   `delivered / processing / processed / failed` with attempt history as first-class routing
   telemetry (`landscape.md` §5) — the one observability primitive worth mirroring.
3. **The MAST views are still `grep`.** Finding 002's queries (act mix, broadcast share, unanswered
   `request_help`, stalled threads) are exactly the §5b views `observability.md` promises — derived
   views over the message log, never stored beside it — but nothing serves them.

## Decision

Build Layer 2 in three increments; **this ADR freezes increment 1** and names the other two so the
arc is sequenced, not open-ended.

### Increment 1 (this ADR): `@musterd/telemetry` — one bootstrap, booted by every component

1. **A new workspace package `@musterd/telemetry`** owns the generic OTLP bootstrap extracted from
   `packages/server/src/telemetry.ts`: enablement (`telemetryEnabled` — on iff a standard
   `OTEL_EXPORTER_OTLP_*` env var is present and the SDK isn't disabled), `startTelemetry` (dynamic
   import of `@opentelemetry/sdk-node`, so a process with telemetry off never loads it),
   parameterized by **service name** and **resource attributes**, returning a bounded shutdown/flush.
   The server keeps its domain instruments and helpers but delegates its bootstrap here
   (`service.name=musterd-server`), so there is exactly one bootstrap in the codebase. Off by
   default, no phone-home — unchanged (ADR 015/082 posture; the product default does not flip).
2. **The MCP adapter boots it** (`service.name=musterd-mcp`) at startup, with the seat identity as
   resource attributes (`musterd.team`, `musterd.member.id` normalized per #107, `musterd.member`
   raw), and **wraps every registered tool in a `musterd.tool.call` span** at one choke point (the
   `registerTool` seam in `buildMcpServer`) — attributes: tool name, join state; never arguments or
   message bodies. This is the unlock: with an active span in the adapter process, the existing
   `withTraceContext`/`linkReceived` plumbing fires **in production** — a handoff's sender span and
   the recipient's inbox read become one linked cross-agent, cross-runtime trace (ADR 011's promise,
   ADR 082 slice 4's deferred item). The adapter flushes on the existing shutdown path.
3. **The CLI boots it** (`service.name=musterd-cli`) around command dispatch, wrapping each run in a
   `musterd.cli.command` span — attribute: the command word only, never argv (bodies, tokens and
   paths live there). Two carve-outs: `serve` never boots the CLI SDK (the daemon owns that process's
   telemetry and its service name), and `inbox --interrupt-check` skips it entirely (the ADR 088
   hot path has a sub-50ms budget; booting an SDK per tool-boundary probe would blow it). Because a
   CLI process is short-lived, shutdown force-flushes with a hard cap (~1 s race) — telemetry is
   best-effort and must never hold an exit hostage to a dead collector.

### Increment 2 (named, next): per-recipient delivery status

A delivery ledger per directed act — `delivered` (routed to the seat) → `seen` (the inbox read that
covered it; the read half of ADR 088's raised→read pair, with `interrupt-raised` as an attempt
event) → `answered` (the accept/decline/resolve that closes it) → `expired/failed`, with attempt
history. Generalizes the ADR 088 delivery-confirmation signal into the act layer; the band.ai borrow
(`landscape.md` §5). Surfaces on `team_status`/`report` and as span events/metrics. Needs its own
store/read-model design (per-recipient rows vs. derivation from cursors + audit) — frozen in its own
ADR when built.

### Increment 3 (named): MAST-aware views + the report surface

Finding 002's hand queries become first-class derived views over the message log (never stored
beside it, `observability.md` §5b): act-mix/broadcast-share (the coordination-density lens),
unanswered `request_help` (ignored-input), stalled threads and circular handoffs (coordination
breakdown), time-to-unblock — served via `musterd report coordination` and the web insight surface,
on the ADR 050 projection seam. The diagnostic-instruments-not-scores rule
(`human-agent-dynamics.md` §4) applies in full.

## Consequences

- The cross-agent distributed trace exists in production: sender tool span → `meta.otel` on the
  envelope → daemon envelope span (which already records `traceparent`) → recipient inbox link. The
  coordination-traces dataset (ADR 056) and batond ingestion get real multi-runtime traces to build
  on, not single-process ones.
- Adapter and CLI operational health (tool latency/error rates, command usage) becomes observable on
  the same sink as the daemon — three service names, one OTLP posture.
- One more workspace package to version/publish; the bootstrap dedupe pays for it (server, mcp and
  cli would otherwise each carry a copy that must stay in sync).
- The OTel SDK becomes a dependency of `@musterd/mcp` and `@musterd/cli` (dynamic-imported, never
  loaded when off) — an ADR 002 dependency-budget line item, justified the same way it was for the
  server (ADR 015: the one justified addition).
- Increments 2–3 stay honest: named with their design seams (ADR 088's raised→read, ADR 050's
  projections) instead of "later", each frozen by its own ADR before build.

## Observability & Evaluation

**Traces** — this ADR _is_ the trace work: `musterd.tool.call` (adapter) and `musterd.cli.command`
(CLI) spans, resource-attributed to the seat, linking through the daemon's `musterd.envelope.process`
span via `meta.otel`. Verified live on the dogfood sink (`docs/dogfood-telemetry.md`).

**Eval** — the headline metric: **trace-link rate** — the share of production directed acts whose
envelope carries `meta.otel` (measurable today from the sink's `musterd.otel.traceparent` attribute;
baseline before this ADR: 0%). Secondary: adapter tool-call error rate and CLI command latency now
exist as first-party series. Guard metric: `inbox --interrupt-check` wall time stays under its ADR
088 budget (the carve-out is load-bearing).

**Experiment** — replay the ADR 088 steering A/B (or any two-agent handoff task) with the client SDK
on vs. off and compare diagnosability: with it on, the handoff should appear as one linked trace
across both agents' runtimes on the local sink — the demo artifact for the batond thesis.
