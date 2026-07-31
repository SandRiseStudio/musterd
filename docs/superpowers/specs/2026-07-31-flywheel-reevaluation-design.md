# Flywheel reevaluation — design

Date: 2026-07-31. Brainstorm between nick and ryder. Becomes ADR 194 (supersedes 051) +
accepted ADR 184 (structural-only prose). Number to re-verify against `origin/main` at PR time.

## Why reevaluate

ADR 051 (2026-06-24, still `proposed`) drew emit-in-musterd / engine-in-batond. Since then the
emit side, insight/report surfaces, cookoff, and a human research loop all shipped **without**
batond. Langfuse was rejected as the dogfood sink. The "engine in batond" line became a parking
lot for compare → promote → observe. ADR 184 already peeled dataset consent off 051 because 051
was blocking the wrong surface.

## Decisions

### 1. Product boundary (ADR 194 supersedes 051)

| Keep | Change |
| --- | --- |
| musterd **emits** coordination traces (OTel); core builds no eval platform / score store / prompt store | Compare → promote → observe for **musterd’s own R&D** lives in the **research practice** (findings, cookoff manifests, ADR/PR promotion) — not in batond |
| ADR 052 obs-evals gate stays the day-to-day discipline | **batond** = parked later product (standalone coordination lens / third-party ingest). npm reserve may stay; it is **not** required to close the flywheel |
| OTel wire; no phone-home | Drop “Langfuse semantics are batond’s near-term backend” as load-bearing. Local OTLP sink + report + research artifacts are the current loop |
| Harness-decay / team-topology experiments as *questions* | Those experiments already run via cookoff + findings; they don’t wait on an engine product |

**Non-goals of ADR 194:** no batond code, no Langfuse adoption, no moving insight/report out of musterd.

### 2. Dataset gate (accept ADR 184)

Answer §The one decision with **no**: agent-seat prose is **not** publishable on the provisioning
human’s consent alone.

- **v1 (and default) releases = structural fields only**: acts, models, timings, lane ids,
  fingerprints, per-release pseudonymised seat names.
- **All prose bodies omitted** (human and agent) until a later ADR argues for consented prose with
  evidence (184’s own experiment: can finding 006/008 reproduce from structural-only?).
- Experiment-manifest ownership for published releases lives with the research practice / ADR 194,
  not batond.
- Still **no exporter code** in this lane — posture + answered question only.

### 3. Harden the research practice (design seams; implement later)

Codify the loop that already works:

```
hypothesize → run → compare → promote → observe
```

| Stage | Today | Hardening seam (next session) |
| --- | --- | --- |
| Hypothesize | ADR / lane / goal | Link experiment to a pinned manifest id |
| Run | cookoff / dogfood / `scripts/research/*` | Manifest template: fixture, cell, model, harness, spend gate, artifact paths |
| Compare | Hand tables; archaeology; sqlite; otel-sink | Compare checklist + named artifact layout under run dir; thin CLI optional later |
| Promote | `docs/research/NNN` → ADR/PR | Promote checklist: finding file, baseline, honest-N, “what it changes,” ADR link or explicit none |
| Observe | Dogfood OTel + next arm | Existing instrument-by-default; no new sink |

Also:

- Retire “named for batond” backlog items to either **research-practice arm** or **parked-batond**.
- Roadmap: `eval-experiment-engine` = parked batond product, not “missing flywheel.”
- Dataset gate citations → ADR 184.
- ADR 056 citations updated off 051 for open-data release.

**Out of scope for hardening design:** Langfuse, batond package, consent DB, exporter implementation.

## This lane’s deliverables (doc-only)

1. This design spec.
2. Accept + amend ADR 184 (structural-only / B).
3. ADR 194 superseding 051; mark 051 superseded.
4. Citation / roadmap sweep (`content/roadmap.data.ts`, research README, observability.md,
   model-experimentation.md, ADR 056 as needed).
5. Verify via `pnpm format:check`; no `packages/` code.

## Handoff for implementation session

Build against the hardening seams above (manifest template, compare checklist, promote checklist,
“named for batond” triage). Exporter remains gated on ADR 184 DoD after this accept.
