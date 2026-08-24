# 056 — Research as a first-class practice: produce and ingest

- Status: accepted (2026-08-24, nick; amended on acceptance — see below)
- Date: 2026-06-25

## Context

musterd is already a research *consumer* — MAST, Co-Gym, AgentOps, LumiMAS are load-bearing in
`research-foundation.md` and `landscape.md`, and the founding thesis rests on Co-Gym's measured result.
The flywheel decision ([ADR 194](194-flywheel-practice-not-batond.md); was ADR 051) plus the dogfood
practice (developing musterd on musterd) generate the rarest ingredient in this field: **real
human+agent coordination data nobody else has.** Nick wants research to be a first-class musterd
priority — to the point of publishing — and, symmetrically, wants musterd to keep **ingesting** new
research that shapes it. This ADR extends the flywheel: research is the publishable *output* of the
loop and a standing *input* to the roadmap. Compare→promote for musterd R&D is this practice, not a
batond engine.

## Problem

Make research a durable practice in both directions without spawning a research org or over-claiming from
small-N dogfood data: decide the first publishable artifact, the first thesis, the quality bar, the
reproducibility/open-data posture that makes artifacts citable, and the intake mechanism that turns new
external research into musterd decisions.

## Decision

### Produce (musterd → the field)

- **Dataset-first.** The first artifact is an **open, redacted coordination-traces dataset** on
  HuggingFace (structural fields first per [ADR 184](184-dataset-consent-and-redaction.md)), the corpus
  no single-agent vendor can produce. HF artifact
  ladder, in order: **dataset → benchmark + leaderboard (Space) → paper (arXiv → HF Papers) →
  fine-tuned coordination-judge model** (the tiny-model dogfood track, as both a
  real HF model and cheap experiment compute). Build down the ladder; don't skip to the paper.
- **First thesis: MAST-in-the-wild.** Operationalize MAST's failure taxonomy as live detectors over the
  act-typed log (ignored `request_help`, circular handoffs, stalled threads). The detector substrate is
  the **coordination-density** insight + **telemetry-l2** work already on the roadmap — the paper harvests
  them. Contribution vs MAST: the first *dataset + detectors of real coordination failures*, not annotated
  transcripts.
- **Bar: start whitepaper-grade, escalate to peer-reviewed contribution.** Whitepaper/blog for fast
  credibility now; the dataset + benchmark are the durable peer-reviewable path.
- **Research-grade by construction, not retrofit.** Reproducibility rides on pinned experiment
  manifests ([ADR 194](194-flywheel-practice-not-batond.md) / research practice) and ADR 052's baseline
  requirement — together they *are* a methods section. The open-data release depends on
  [ADR 184](184-dataset-consent-and-redaction.md)'s consent + redaction posture being real: no dataset
  ships before that gate's DoD holds (v1 = structural-only).
- **Honest-N discipline.** Solo-studio dogfood is small-N; frame findings as case studies / a dataset
  contribution until N is real. Automated experiment runs + the tiny model scale N cheaply and honestly.
  Every published metric carries the Goodhart / human-vs-agent-measurement cautions
  (`human-agent-dynamics.md` §4) — diagnostic instruments, never rankings of Members.

### Ingest (the field → musterd)

- **A standing research radar.** A recurring scan/triage of new multi-agent-coordination and
  human-agent-collaboration research (arXiv, HF Papers, the venues), funneled into
  **`research-foundation.md`** (the canonical evidence doc). When a finding would change a decision, it
  graduates to an **ADR + roadmap item**; otherwise it's recorded as evidence. The natural automation is a
  scheduled agent emitting a triaged digest; a human decides what graduates (no auto-merge of findings
  into the thesis).

### Lab notebook

- **`docs/research/`** is the findings log — per-experiment writeups a whitepaper is later assembled from.
  Division of labor: `research-foundation.md` records *consumed* evidence (ingest); `docs/research/`
  records *produced* findings (output).

## Consequences

- Research is a **harvest of the flywheel**, not a separate program — the cost is the discipline (every
  experiment reproducible + baselined), which ADRs 192/052 already impose.
- Named seams, each its own ADR/build when it lands: the dataset release pipeline (ADR 184), the
  radar automation, the benchmark + leaderboard, the judge model. Roadmap: `coordination-dataset` and
  `research-intake`.
- Composes with ADR 194 (flywheel / research practice), ADR 184 (publication gate), ADR 052
  (baselines), telemetry-l2 + coordination-density (the MAST detectors), and the tiny-model dogfood
  track.
- The open-data release is **gated** on ADR 184 — a hard precondition, not a later nicety.

## Amendment on acceptance (2026-08-24)

Accepted after two months operating as de-facto practice. A full audit of the 49 citing files
(lane 01M091HZWA) reconstructed what was actually relied on; this section records that evidence
rather than rewriting the decision.

**Exercised and proven load-bearing:**

- The **produce/ingest split** — `research-foundation.md` (ingest), `docs/research/` (produce),
  and `docs/wiki/research-corpus.md` all structure themselves on it.
- The **lab notebook** — `docs/research/` holds nine findings under this charter's convention.
- The **artifact-ladder ordering** — the sole basis for
  [ADR 110](110-track-b-tiny-model-lab-re-evaluation.md)'s Stage 2 NO-GO and the "first rung"
  framing in ADRs 122/184. Build down the ladder stands.
- The **ADR 184 gate** on any open-data release — reaffirmed as a hard precondition.

**Partially delivered:** the research radar exists as a hand-run practice (M1–M3,
`docs/research/radar/`); the automated weekly digest this ADR sketches (M4–M5) is not built and
remains a named seam, not a promise.

**Accepted but not yet exercised:** the whitepaper-grade → peer-reviewed escalation bar (no
whitepaper exists); the benchmark/leaderboard and judge-model rungs (cited by eight ADRs only as
future homes). These stay in the decision as direction, with no delivery implied.

**Not in this ADR:** a cluster of eleven documents (ADRs 158, 163, 169, 172, 187, 246,
`landscape.md`, `the-standing-acceptor.md`, among others) cites "ADR 056 diversity conclusions"
and "correlated models make correlated mistakes." This ADR contains no such claim — three of
those citations link to files that never existed under other titles. That correlated-failure /
model-diversity thesis is real and load-bearing, and it gets its own charter (follow-up lane
opened at acceptance); it is not retro-written into this one.

## Observability & Evaluation

n/a as a shippable feature (this is a research/process ADR), but central to it: the **dataset is the eval
corpus** and the **MAST detectors are the evals** this practice produces. Their metric is detector
precision/recall against a hand-labeled golden set (meta-eval / judge-calibration as a research-practice
arm per ADR 194 — not blocked on batond); the baseline is MAST's published taxonomy. Reproducibility is
the experiment-manifest posture above.
