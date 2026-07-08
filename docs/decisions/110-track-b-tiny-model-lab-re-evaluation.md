# 110 — Track B re-evaluation: revive Stage 1 as the guardrail-floor probe; Stage 2 stays gated on the dataset

- Status: accepted (decision-only — implementation lives in `musterd-lab`, never the product repos)
- Date: 2026-07-08 (re-evaluation mandated by ADR 101 §5; izzo)
- Builds on: ADR 101 (model as a variable — the attestation substrate this streams into), ADR 056
  (research ladder: dataset → benchmark → paper → judge), ADR 051/052 (manifests + baselines),
  `docs/design/model-experimentation.md` §Track B (the frozen design under review)

## Context

Track B of model-experimentation (own models end-to-end: a tiny local instruct agent, then a
from-scratch MLX model culminating in a fine-tuned coordination-judge) was reserved by ADR 101 §5
with an explicit instruction to **re-evaluate before implementing**. This ADR is that re-evaluation:
go / no-go / re-scope, per stage. Facts on the ground since the design froze (2026-07-06):

- **The substrate Stage 1 targets is live.** ADR 101 increment 1 shipped (PR #144): per-occupancy
  harness-attested model, server-stamped `meta.model` per act, `musterd.model.family` on spans, and
  the family-diversity flag in `report.mast.diversity`. A tiny-model seat now has a real place to
  stream into — and, notably, every live occupancy to date is `claude-*` family, so the diversity
  flag has **never had cross-family live data** to fire against.
- **Stage 2's training input does not exist.** The coordination-judge trains on the
  coordination-traces dataset — itself a reserved, unbuilt roadmap item (`coordination-dataset`),
  which is in turn gated on the ADR 051 consent/redaction posture. The judge is two hops from ready.
- **A Stage 1 scaffold already exists.** `musterd-lab` is a local repo (no remote; single commit,
  2026-06-17) with a working shape: pure-stdlib Python harness, Ollama-served model, reads the
  `AGENTS.md` primer, joins over the CLI, watches its inbox, replies with acts, halts on reclaim.
  It predates three weeks of protocol evolution — ADR 087 (resume-vs-claim), ADR 095 (blocking
  join), ADR 101 (attestation), ADR 103 (steer/challenge/defer) — so it is stale, not wrong.
- **The frozen model picks are dated.** The design named `qwen2.5:3b` / `llama3.2:3b`; the current
  small-model leaders are Qwen3 (1.7B/4B), Gemma 3 4B, Phi-4-mini (3.8B), and SmolLM3-3B, most with
  native tool-calling and structured output. `mlx-lm` matured as expected (LoRA + full fine-tune,
  community SFT/DPO/GRPO stacks) — the Stage 2 tooling bet holds; only its sequencing is wrong.

## Decision

Split the stages and decide them independently — they share a repo, not a fate.

### 1. Stage 1 — GO, re-scoped from "build" to "revive + point at the ADR 101 substrate"

A weak local agent probing the guardrail floor is still the cheapest high-signal experiment on the
board: a 3–4B model fails in exactly the ways the primer + protocol guardrails exist to catch, where
a frontier model papers over gaps. And it gained a second job since the design froze: it is the only
realistic way to put a **non-`claude-*` family** into a live team, which turns the shipped diversity
flag from untested code into observed behavior.

Re-scope (all inside `musterd-lab`):

- **Modernize the harness to the current protocol**: join via the current claim/resume path
  (ADR 087/095), attest its model via `MUSTERD_MODEL` (ADR 101) so its acts carry a real
  non-Claude family stamp, and handle the ADR 103 interrupt-line acts (halt-and-comply on `steer`,
  answer `challenge` with an evidence-bearing `accept`/`decline`) alongside the original
  reclaim-halt probe.
- **Refresh the model pin, demote it to a manifest term.** Default `qwen3:4b-instruct` (native
  tool-calling; `gemma3:4b` / `phi-4-mini` as alternates). Per ADR 051, the exact id is a pinned
  experiment-manifest term recorded per run — never doctrine in a design doc again.
- **Success metric (the ADR 052 obs-evals gate):** one `docs/research/NNN-*.md` finding recording
  the guardrail-floor results — primer comprehension (does it join and coordinate or flail),
  identity binding (does it claim honestly), revocation (does it halt mid-loop), steer compliance —
  plus verification that its occupancy attestation and per-act stamps land (`occupancy.model_attested`
  audit rows, `musterd.model.family` ≠ `claude`) and that a mixed-family review chain renders
  correctly (not flagged) in `report.mast.diversity`. No finding, no "done".
- **Priority honesty:** this does not displace near-term product items. It is a bounded fixture —
  a few sessions of harness work riding infrastructure that already ships — picked up as dogfood
  capacity allows, not scheduled ahead of the interrupt-line or insight-layer work.

### 2. Stage 2 — NO-GO for now; gated, with a named re-open trigger

The from-scratch MLX model and the fine-tuned coordination-judge stay reserved. The reasoning is
sequencing, not skepticism:

- The judge's training corpus is the coordination-traces dataset, which is unbuilt and itself gated
  on consent/redaction (ADR 056). ADR 056's ladder is explicit — **dataset → benchmark → paper →
  judge; build down the ladder, don't skip** — and starting the judge now would skip three rungs.
- **Re-open trigger:** the `coordination-dataset` item ships with honest N and the redaction gate
  enforced. At that point Stage 2 gets its own go/no-go, with the then-current MLX tooling.
- The "train a tiny GPT from scratch to learn the internals" half is a personal learning track
  (valuable, but not a product deliverable); it needs no ADR and can proceed in `musterd-lab`
  whenever, without claiming the research-spine label.

### 3. Repo boundary — confirmed

`musterd-lab` is the home for all Track B implementation. It exists locally; when Stage 1 revival
starts it gets a private `SandRiseStudio/musterd-lab` remote (the parleyd pattern). The product
repos carry only decisions and findings: this ADR, the §Track B pointer in
`model-experimentation.md`, and `docs/research/` findings.

## Consequences

- Track B stops being an undated "reserved" blob: Stage 1 is a green-lit bounded fixture with a
  defined finding as its exit; Stage 2 has a concrete gate instead of a vague someday.
- The diversity flag gets its first live cross-family data without waiting for a second frontier
  vendor to join the dogfood team.
- `model-experimentation.md` §Track B is corrected by this ADR: stale model ids demoted to manifest
  pins, the stage split made explicit.
- Risk accepted: a 3–4B model may simply fail to coordinate at all. That is a _finding_, not a
  failure — the guardrail floor being below 4B is worth one research note either way.

## Observability & Evaluation

**Traces** — Stage 1 adds no new emission; its evidence is the shipped ADR 101 substrate observed
from a non-Claude seat, never reconstructed: `occupancy.model_attested` audit rows for the tiny
seat, per-act `meta.model` stamps carrying a non-Claude family, `musterd.model.family` on its spans,
and the `report.mast.diversity` rendering of a mixed-family chain.

**Eval** — Stage 1: the `docs/research/NNN-*.md` guardrail-floor finding is the deliverable (primer
comprehension, identity binding, revocation halt, steer compliance — each pass/fail with the trace
as evidence). Dataset: the tiny seat's own act log from the probe runs. Baseline: today 100% of
attested occupancies are `claude-*` and the diversity flag has zero cross-family observations.
Stage 2's eval (judge calibration against a hand-labeled golden set, the ADR 051 meta-eval loop) is
reserved with the stage — unmeasurable until the dataset exists, which is the point of the gate.

**Experiment** — the Stage 1 probe run is itself a pinned ADR 051 manifest (model id, harness
commit, guidance stamp, topology) so a later small-model release can re-run it and diff the
guardrail floor the same way Track A diffs frontier models.
