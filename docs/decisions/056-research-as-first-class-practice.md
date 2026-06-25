# 056 — Research as a first-class practice: produce and ingest

- Status: proposed
- Date: 2026-06-25

## Context

musterd is already a research *consumer* — MAST, Co-Gym, AgentOps, LumiMAS are load-bearing in
`research-foundation.md` and `landscape.md`, and the founding thesis rests on Co-Gym's measured result.
The flywheel decision (ADR 051: trace → eval → experiment, engine in batond) plus the dogfood
practice (developing musterd on musterd) generate the rarest ingredient in this field: **real
human+agent coordination data nobody else has.** Nick wants research to be a first-class musterd
priority — to the point of publishing — and, symmetrically, wants musterd to keep **ingesting** new
research that shapes it. This ADR extends ADR 051: research is the publishable *output* of the flywheel
and a standing *input* to the roadmap.

## Problem

Make research a durable practice in both directions without spawning a research org or over-claiming from
small-N dogfood data: decide the first publishable artifact, the first thesis, the quality bar, the
reproducibility/open-data posture that makes artifacts citable, and the intake mechanism that turns new
external research into musterd decisions.

## Decision

### Produce (musterd → the field)

- **Dataset-first.** The first artifact is an **open, redacted coordination-traces dataset** on
  HuggingFace (OTel/Langfuse-shaped — ADR 051), the corpus no single-agent vendor can produce. HF artifact
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
- **Research-grade by construction, not retrofit.** Reproducibility rides on ADR 051's pinned experiment
  manifests (model/prompt/config/topology) and ADR 052's baseline requirement — together they *are* a
  methods section. The open-data release depends on ADR 051's **opt-in + redaction** posture being real:
  no dataset ships before consent/redaction is enforced.
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
  experiment reproducible + baselined), which ADRs 051/052 already impose.
- Named seams, each its own ADR/build when it lands: the dataset release pipeline (consent/redaction), the
  radar automation, the benchmark + leaderboard, the judge model. Roadmap: `coordination-dataset` and
  `research-intake`.
- Composes with ADR 051 (reproducible experiments + redaction), ADR 052 (baselines), telemetry-l2 +
  coordination-density (the MAST detectors), and the tiny-model dogfood track.
- The open-data release is **gated** on redaction/consent — a hard precondition, not a later nicety.

## Observability & Evaluation

n/a as a shippable feature (this is a research/process ADR), but central to it: the **dataset is the eval
corpus** and the **MAST detectors are the evals** this practice produces. Their metric is detector
precision/recall against a hand-labeled golden set (the meta-eval / judge-calibration loop of ADR 051);
the baseline is MAST's published taxonomy. Reproducibility is the experiment-manifest posture above.
