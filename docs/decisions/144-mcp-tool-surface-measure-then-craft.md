# 144 — The MCP tool surface as a designed product: measure it, then craft it

- Status: accepted — design frozen; increments 1–6 are the build arc (roadmap: `tool-call-telemetry` +
  `mcp-tool-surface`, both still sequenced behind the wave work)
- Date: 2026-07-15
- Builds on: [ADRs 029–031](029-role-template-format.md) (the per-seat adapter render this arc
  reshapes), [ADR 069](069-v0.3-governance-build-plan.md) (roles/capabilities — the axis to scope a
  surface by), [ADR 101](101-model-as-a-variable.md) (role templates / own-harness seam),
  [ADR 015](015-otel-layer1-server.md) + [ADRs 089–091](089-telemetry-l2-client-sdk.md) (the telemetry
  emission path increment 1 rides), [ADR 051](051-trace-eval-experiment-flywheel.md) (opt-in/redaction
  posture), [ADR 131](131-harness-residency-wake-ledger-host.md) (`residency.wake_cost` — the precedent
  that the ledger can carry a real measured cost)
- Contract: [mcp-tool-surface.md](../design/mcp-tool-surface.md) — the evidence base (field reports,
  tool-selection literature, the 2026-07-15 adjacent-systems sweep) and the increment map this ADR
  freezes.

## Context

musterd's MCP adapter is the whole surface an agent actually reads — not just what it **sends** (the
`team_*`/`lane_*` names, descriptions, and input schemas) but what it **reads back** (every result,
empty states included). That surface is a product artifact, and it has grown to 18 tools without ever
getting a deliberate design pass. The seed brief (contract doc) holds the full evidence; the debt in
one paragraph:

- **Namespace drift** — 12 tools share the `team_` prefix, 6 lane tools sit outside it: two conventions
  on one server, unexplained.
- **Heavy prose descriptions** — description regions weigh ~2.9K chars (`lanes.ts`), ~1.7K (`send.ts`),
  ~1.3K (`insights.ts`); `team_send` alone crams nine acts and their ADR references into one ~250-word
  paragraph, shipped on every call that loads the tool.
- **No discovery affordance** — all 18 schemas load on every call, whatever the seat's role; a read-only
  observer loads acting tools it can never use.
- **Uneven results** — `format.ts` already renders for an agent to read, and the good empty states name
  the next action ("no lanes — `lane_open` to declare your work"), but others are bare ("no members")
  and no audit holds the standard.

The ecosystem is scrutinizing exactly this (tool descriptions as the dominant context cost; accuracy
degrading past ~15–20 tools; harness-side deferred loading cutting 50+ tools from ~72K to ~8.7K tokens
_and raising accuracy_; MCP spec issue #2808 proposing namespacing + discovery-tier schemas). And we
cannot see any of it in our own data: the audit ledger is coordination-level, the `messages` table
records acts not invocations, and nothing anywhere records which tool was called, how long it took,
whether it bounced, or what its schema weighs.

## Problem

Two roadmap items were captured for this on 2026-07-14 (`tool-call-telemetry`, `mcp-tool-surface`) as
evidence-backed seeds. What is missing is the frozen shape: which increments, in what order, under what
principles — so the work can be picked up increment-by-increment without re-deriving the design, and so
the redesign is measurable rather than vibes-driven.

## Decision

### 1. Instrument before renovating (increment 1 = `tool-call-telemetry`)

One telemetry event per MCP tool invocation — tool name, wall-clock duration, outcome (ok / error /
invalid-input bounce), caller role, seat — plus an estimated per-seat **rendered-surface weight**
(schema + description bytes at connect), aggregated in the report engine alongside the existing
coordination reports. It rides the ADR 015/089–091 emission path and honors the ADR 051 opt-in and
redaction posture (tool names and shapes, never message bodies).

Tool calls are far chattier than coordination acts, so whether raw per-call rows belong in the audit
ledger or in a dedicated aggregate (the resident-loop carve-out instinct: never one audit row per tick)
is the increment's call — the frozen part is the event's fields and that the report engine can answer
"which tools does each role actually call, at what cost, with what bounce rate."

Measurement is sequenced **first** so every later increment has a before/after — but it does not gate
increment 2 (a naming audit needs no counters), and its value outlives the redesign (cost accounting,
coordination density, the MAST-in-the-wild dataset).

### 2. Names & descriptions (increment 2)

Audit all 18 tool names to one stated convention — resolving the `team_*`/`lane_*` split is the first
deliverable: either lanes fold into the shared prefix or the sub-surface split is deliberate and
documented (tracking MCP spec #2808's namespacing proposal before picking). Rewrite every description
for concision; the field evidence says descriptions, not parameter structure, are the biggest lever.
With harnesses building retrieval-style deferred tool loading, names and descriptions that **retrieve
well** are the durable server-side investment.

### 3. Results & empty states as an audited standard (increment 3)

Every tool result — success, empty, and error — must be informative, intuitive, and **action-naming**
for an agent, held by an audit across all tools rather than ad hoc. Bare states ("no members") come up
to the level the good ones set; error and not-ready results say what to do next, including **repair
hints** on invalid input ("act must be one of …; closest to what you sent is `status_update`") so a
confused agent reaches a valid retry in one turn. Result **shape** is decided deliberately per tool:
programmatic callers want structured returns with a documented output schema, conversational callers
want prose naming the next action — default structured-first with the next-action hint as a field,
never one shape winning by accident.

### 4. Schemas & tool shape (increment 4)

Tighten input schemas; add worked `input_examples` where parameters are complex (the measured
alternative to longer prose — `team_send`'s nine acts are the first customer); implement
**deterministic lenient coercion** in handlers (accept aliases, trim, sensible defaults) so near-miss
input conforms instead of bouncing. Split/merge decisions (is `team_send` nine acts behind one tool, or
acts as tools?) are made **here, from increment-1 data**, under the default that coarse +
well-described beats many fine tools for context economy; a split must be argued from measured
confusion, not taste. No model in the request path: the server-side conforming-agent idea lands as this
deterministic layer now; the model-in-the-path variant stays a researchable extension (§ Observability
& Evaluation).

### 5. Scope by role (increment 5)

The adapter renders only the tools a seat's role can meaningfully use — an observer never loads acting
tools. Structural least privilege, enforced at render, expressed as **declarative role→tool data** the
render consumes (the policy/enforcement decoupling pattern, without taking a policy-engine dependency).
The rendered surface is **stable within a session**: scope at connect (cacheable), never mutate the
tool list mid-session (cache-hostile). A role change between sessions simply re-renders on the next
connect.

### 6. Discovery / lazy disclosure (increment 6, conditional)

A small always-on surface plus a retrieval-style discovery affordance, so the catalog can grow without
taxing every call. Explicitly **conditional**: harnesses are shipping this natively (deferred loading +
tool search) and the MCP spec may adopt discovery-tier schemas (#2808) — if that lands broadly,
increment 6 collapses into "names/descriptions that retrieve well" (increment 2) plus adopting the spec
mechanism, and we build no bespoke `get_more_tools`. Re-evaluate against the harness landscape when
increments 2–5 are done.

### Principles frozen across the arc

- The surface is a **designed product artifact** — both halves, send and read-back, held to a standard.
- **Measure, then craft** — every craft increment lands with its before/after from increment 1.
- **Deterministic forgiveness** — coercion + repair hints in code; no model in the request path.
- **Stability over dynamism** — a seat's surface is fixed for the session; scoping happens at render.
- **Coarse by default** — tool splits must be argued from measured confusion.
- **Retrievability is the durable work** — the ecosystem is moving selection into the harness; our job
  is a surface worth selecting from.

## Consequences

- The two roadmap items stay on the map with this ADR as their freezing design; they remain sequenced
  behind the wave work (reserved) until the owner pulls them forward — the arc is shaped so increment 1
  and increment 2 are each a small, independent PR when that happens.
- Increment 1 adds telemetry fields/aggregates only — no wire bump, no schema migration is frozen here;
  if the increment chooses ledger rows they are additive verbs in the existing audit shape.
- Increments 2 and 4 change tool names, descriptions, and schemas — a **breaking surface change for
  connected agents**. They ship with the guidance-surface drift checks (`guidance:check`, ADR 085) and
  primer/skill updates in the same PR, and renames land as rename-with-alias where the coercion layer
  (increment 4) can absorb the old name.
- Increment 5 makes the per-seat render diverge by role for the first time; the ADR 060 provisioning
  verify and `init --check` drift detector must learn that two seats legitimately see different tool
  lists.
- Deliberate deferrals, named: model-in-the-path input conforming (researchable, Track B tiny-model
  fixture candidate); external-tool governance (Scalekit-style brokering, enterprise-managed MCP
  authorization) — landscape material, not this arc; programmatic-calling-specific affordances beyond
  documented output schemas.

## Observability & Evaluation

**Traces** — increment 1 _is_ the instrument: one `musterd.mcp.tool_call` event per invocation (tool,
duration, outcome incl. invalid-input bounce class, caller role, seat) plus a per-seat rendered-surface
weight at connect, aggregated in the report engine; ADR 051 posture (opt-in, no message bodies). Until
it lands, the only cost precedent in the ledger is `residency.wake_cost` — the gap is the point.

**Eval** — headline: **rendered-surface weight per seat** (bytes/est-tokens at connect) and
**invalid-input bounce rate per tool** (bounces per hundred calls, and whether the first retry after a
repair hint succeeds). Secondary: **action-naming coverage** — an audited checklist over all tools ×
{success, empty, error} results, brought to and held at 100%. Dataset: the dogfood team's live tool
calls. Baseline: captured by increment 1 before increment 2 touches anything; the hand-measured
description-region weights in the contract doc (~2.9K/~1.7K/~1.3K chars) are the provisional numbers it
replaces.

**Experiment** — per-increment before/after on the headline metrics (increment 2: description rewrite
vs bounce + selection patterns; increments 3–4: repair hints + coercion vs one-turn-retry success). One
pre-registered conditional: if a tool still shows a material bounce rate after increments 3–4, run the
model-in-the-path conformer against the deterministic layer on that tool (latency, cost, conformance
rate) — the Track B tiny-model fixture is the candidate runtime; otherwise the deterministic layer is
declared sufficient and the extension stays shelved.
