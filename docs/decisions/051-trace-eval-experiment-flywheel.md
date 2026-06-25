# 051 — The trace → eval → experiment flywheel: coordination-native, emit-in-musterd / engine-in-batond

- Status: proposed
- Date: 2026-06-24

## Context

A LangChain PM talk on LangSmith's experimentation engine prompted a 2026-06-24 brainstorm
(Nick's priorities) on making **traces, evals, and experiments** first-class to how musterd is
built. The existing observability strategy (`docs/design/observability.md`, ADR 011, ADR 015)
already drew the line: musterd emits thin OTel from the server hot path; it does **not** build trace
storage, LLM dashboards, prompt management, or an eval platform — those are bought/integrated, and the
*coordination* lens is the standalone product (working name **batond**, ADR-reversible). This ADR
extends that strategy to evals and experiments without crossing the build/buy line, and names the
flywheel that connects them.

The risk being avoided: rebuilding LangSmith/Langfuse (a crowded, converging single-agent market —
observability.md §2) instead of building the layer no agent-observability vendor has — the space
*between* agents and humans (MAST: ~79% of multi-agent failures live there).

## Problem

Decide where traces/evals/experiments live relative to the three-product frame (musterd / batond /
amprealize), what semantics and wire format they use, and what makes musterd's version defensible
rather than a worse clone of the incumbents — all without expanding musterd core's scope or breaking
the "integrate, don't build" default.

## Decision

- **One flywheel:** observe (trace) → hypothesize → experiment → compare → promote → observe. The four
  priorities from the brainstorm are stages of it, not separate features.
- **Emit in musterd, engine in batond.** musterd's job is to *emit the best coordination trace in
  existence* (Layer 1 + Layer 2, observability.md §4–5). The **eval + experiment engine is batond's
  domain** — it consumes the trace. musterd core builds no eval/experiment runner. This keeps
  observability.md's "we will not build an eval platform" non-goal intact for the **protocol/core**,
  and gives the eval/experiment work an explicit home (batond) rather than leaving it un-placed.
- **Adopt Langfuse semantics + OTel emission.** Wire format stays **OTel** (GenAI/agent semconv,
  per ADR 015/011 — portable to the whole market). For the higher-level objects — **prompt-as-versioned-artifact,
  datasets, scores, experiments** — adopt **Langfuse's data model and vocabulary** rather than inventing
  our own. Langfuse is OSS (ClickHouse-acquired Jan 2026), OTel-compatible, and already a connected MCP
  surface. batond builds the **coordination-semantic layer on top of** an OTel + Langfuse-shaped backend;
  it does **not** rebuild the trace store, prompt store, or score store.
- **The moat is coordination-native, on both ends:**
  - **Trace:** the unit is the *team task*, not one agent's chain. Spans include agent-turn detail
    (model id + params, tool calls, prompt-ref, tokens/cost/latency) **and** coordination events as
    spans — `claim`, `handoff`, `status_update`, `human_intervention`, `seat_displace` — which musterd
    already has as typed acts. Only musterd can put a human edit and an agent re-plan on one timeline.
  - **Eval:** the unit is the *team outcome* (did the human+agent team hit the Goal's definition-of-done),
    not "did this chain succeed." This is the Co-Gym thesis made measurable, and it composes directly
    with the Plan/Goal **derived-status** model (ADR 048) and the insight projections (ADR 050) —
    a Goal's DoD *is* an outcome-eval target; derived status *is* a programmatic eval signal. Evals are
    a scoring layer over planning primitives we already designed, not a new primitive.
  - **Experiment:** vary not just `model × prompt × agent-config × harness × eval`, but **team topology**
    (1 agent autonomous vs 2 agents + 1 human reviewer vs 3 agents). No incumbent models the team, so
    no incumbent can run that experiment.
- **Prompts in traces are opt-in and versioned.** Capture the prompt as a versioned artifact (hash +
  version, span references it — Langfuse semantics), never inlined per span. Content/prompt capture is
  **opt-in with redaction + retention policy** (extends observability.md §4's "never the body" stance and
  the off-loopback posture, ADR 040). Models, tools, and who-did-what are always captured; raw prompt
  text is gated.
- **Meta-evals = judge calibration.** "Evals for the evals" is concretely: maintain a small human-labeled
  golden set, measure judge↔human agreement, and alert on calibration drift — especially after a judge
  **model swap**. Report eval **variance** (run N times), never a single score.
- **Model currency as a measured practice, not a vibe.** Extend the harness-adapter muscle (ADR 029–031)
  to **model endpoints** — frontier via API, open via NVIDIA NIM (build.nvidia.com) / Ollama (the
  tiny-model dogfood track is the first open fixture). A standing eval suite that runs on each new model
  release turns "adopt model X?" into a data question, compared on the cost × latency × quality Pareto
  frontier.
- **Harness-decay thesis (the contrarian wedge).** As models improve, scaffolding yields diminishing
  returns — capability migrates from harness into model. batond's experiment engine should be able to
  *measure that decay*, telling us when to **delete** musterd/harness complexity. A coordination tool
  that helps remove complexity as models absorb it is a sharp, defensible position.

## Consequences

- No new build in musterd **core**: this is an emission + (batond) consumption story. The "integrate,
  don't build" default and observability.md's non-goals stand; the eval/experiment platform is **batond's**
  scope, explicitly, not the protocol's.
- Named seams, not built here: the coordination span taxonomy (Layer 2, ADR 015/telemetry-l2 roadmap
  item), batond's eval + experiment engine, the model-endpoint adapter layer, and the golden-set/judge
  calibration loop. Each gets its own ADR when built.
- Composes with **ADR 048** (Goal DoD → outcome eval), **ADR 050** (projections, cost-per-item seam →
  experiment cost axis), **ADR 011/015** (OTel emission), **ADR 029–031** (adapter pattern → model
  endpoints).
- The discipline that makes the flywheel real day-to-day — every feature ships with traces + an eval —
  is **ADR 052** (the definition-of-done gate). This ADR is the strategy; 052 is the gate.
- Langfuse becomes a named dependency-of-semantics for batond (not for musterd core). If a future need
  pushes core toward storing scores/prompts/experiments itself, that reversal needs its own ADR.
