# 194 — The flywheel lives in the research practice; batond is parked

- Status: accepted
- Date: 2026-07-31
- Supersedes: [ADR 051](051-trace-eval-experiment-flywheel.md)
- Design: [`docs/superpowers/specs/2026-07-31-flywheel-reevaluation-design.md`](../superpowers/specs/2026-07-31-flywheel-reevaluation-design.md)
- Number **194** — verified free after 193 on `origin/main` at ship time.

## Context

ADR 051 (2026-06-24) set strategy: observe → hypothesize → experiment → compare → promote → observe,
with **emit in musterd** and the **eval/experiment engine in batond**, on OTel wire + Langfuse
semantics. It stayed `proposed`. Meanwhile the emit side, insight/report, cookoff, telemetry L2, and
a human research loop (`docs/research/` findings → ADR/PR) all shipped **without** batond. Langfuse
was rejected as the dogfood OTLP sink (finding 001 / ADR 082). ADR 184 peeled dataset consent off 051
because 051 blocked the wrong surface. "Engine in batond" had become a parking lot for work that was
already a practice.

## Problem

Decide where compare → promote → observe lives now that the designed product (batond) never shipped
and the loop already runs by hand — without rebuilding an eval platform inside musterd core, and
without leaving the flywheel permanently "waiting on batond."

## Decision

### 1. Emit stays; core still builds no eval platform

musterd emits the coordination trace (OTel Layer 1 + Layer 2). musterd **core** still builds no
eval/experiment runner, trace store, prompt store, or score store. ADR 052 remains the day-to-day
discipline (every agent-facing ADR names Traces / Eval / Experiment or `n/a`).

### 2. Compare → promote → observe for musterd R&D = the research practice

For musterd's own learning loop, the home is **not** a product engine. It is the research practice
already running:

- **Hypothesize** — ADR / lane / goal
- **Run** — cookoff cells, dogfood seats, `scripts/research/*`, pinned manifests
- **Compare** — findings tables, `musterd archaeology`, sqlite, local OTLP sink, `musterd report`
- **Promote** — `docs/research/NNN-*.md` → ADR correction or product PR
- **Observe** — instrument-by-default dogfood telemetry → next arm

Hardening that practice (manifest template, compare checklist, promote checklist) is a design seam,
not a reason to invent batond. See the design doc linked above.

### 3. batond is parked, not required

**batond** remains a *possible later* standalone product: coordination lens over third-party OTel
(Flue-first intent), optional Langfuse-shaped scores/datasets for teams that want a platform. The npm
name reserve may stay. It is **not** the missing half of musterd's flywheel and must not gate
research, cookoff, or dataset release.

### 4. Drop load-bearing Langfuse semantics for the near term

OTel emission and the local dogfood sink stand. Adopting Langfuse data-model vocabulary for
datasets/scores/experiments is a batond-era choice if that product is ever built — not a prerequisite
for musterd R&D or for ADR 184 structural exports.

### 5. Dataset publication cites ADR 184

Open, redacted coordination-traces release is gated on [ADR 184](184-dataset-consent-and-redaction.md)
(accepted: structural-only v1). Not on this ADR, and not on superseded 051.

### 6. What this inherits from 051 (still true)

- Coordination-native moat: team-task traces, team-outcome questions, team-topology experiments
  (cookoff already proved the last without a platform).
- Pinned experiment manifests + baselines (ADR 052) as the reproducibility method.
- Harness-decay and model-currency remain *questions* the practice can run; they do not require an
  engine product first.
- Prompts in spans stay opt-in / never the body (observability.md §4) — emission posture, distinct from
  publication (ADR 184).

## Consequences

- ADR 051 is **superseded**. Cite this ADR for flywheel product boundary; cite ADR 184 for dataset
  publication; cite ADR 052 for the obs-evals gate; cite ADR 056 for research-as-practice produce/ingest.
- Roadmap item `eval-experiment-engine` means **parked batond product**, not "flywheel incomplete."
- Docs that said "named for batond" / "when batond lands" must triage to **research-practice arm** or
  **parked-batond** — stop implying an engine will absorb them.
- No new runtime dependency; no `packages/` change in the accepting commit.

## Observability & Evaluation

- **Traces.** n/a as a new emission — this ADR relocates a strategy boundary; existing OTel + report
  surfaces unchanged.
- **Eval.** Success = stale "wait for batond" / "gated on ADR 051" citations for the flywheel and
  dataset gate are gone from roadmap + research README + key design docs in the same change set;
  `format:check` / `roadmap:check` / `obs-evals:check` stay green.
- **Experiment.** Pre-registered for a later hardening lane: after manifest + promote checklists
  exist, the next cookoff or frontier-cadence run files a finding that cites a pinned manifest id and
  a promote checklist item — proving the practice is citable without a product engine. Baseline =
  finding 006 (cookoff) which ran without either.

## Related

- [ADR 051](051-trace-eval-experiment-flywheel.md) — superseded strategy (emit / batond engine).
- [ADR 052](052-traces-evals-first-class-gate.md) — obs-evals DoD gate.
- [ADR 056](056-research-as-first-class-practice.md) — produce/ingest research practice.
- [ADR 082](082-instrument-by-default-telemetry.md) — dogfood OTLP sink (batond stand-in retired as
  *required* destination).
- [ADR 122](122-cookoff-value-experiment.md) / [ADR 123](123-cookoff-measurement-protocol.md) —
  team-topology experiment without batond.
- [ADR 184](184-dataset-consent-and-redaction.md) — publication consent/redaction gate.
- [`docs/research/README.md`](../research/README.md) — lab notebook.
