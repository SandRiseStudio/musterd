# Model experimentation — frontier cadence + our own models

> **Design direction, not built.** Captures a standing thread (prior sessions, Nick's priority): musterd
> should treat *the model itself* as a first-class experimental variable — both by being **early to each
> new frontier model** and by **owning models end-to-end**. Extends the flywheel (ADR 051) and the
> research practice (ADR 056); the substrate is the coordination telemetry (ADR 082) already shipped.
> Corrections via ADR + update this doc.

## Why this is a musterd thread, not a distraction

The flywheel's experiment axis (ADR 051) is `model × prompt × agent-config × harness × eval × **team
topology**`. Model is the first term, and it's the one the whole field re-rolls every few weeks. musterd's
edge is that it can measure what *actually* changes when the model changes — not on a benchmark, but on
**real human+agent coordination** (the rarest data, ADR 056): does a new model shout into the void less,
close loops more, dup work less? Those are the emitted coordination metrics (`loop_latency`,
`open_loops`, wasted-work), so a model swap is a clean A/B on the exact numbers we care about.

## Track A — bleeding edge: experiment as each frontier model lands

The habit: when a new frontier model ships, run the standard coordination experiment against it and record
a finding.

- **Cadence, not a platform.** A reproducible experiment manifest (ADR 051) pinned to a model id, run on
  a fixed dogfood scenario, diffed against the prior model's baseline (ADR 052 baseline requirement). One
  `docs/research/NNN-*.md` finding per model, per the lab-notebook practice (ADR 056).
- **What we measure:** the coordination evals (directed-act latency, resolve-rate, dup-rate, wasted-work
  ratio) + task outcome — model as the only varied term. The point is the *delta between models on
  coordination*, which nobody else publishes.
- **Feeds:** the "MAST in the wild" thesis and the dataset ladder (ADR 056) — a per-model coordination
  leaderboard is a natural artifact.
- **Ingest side:** the research radar (`research-radar-plan.md`) already sweeps new *research*; the model
  cadence is the sibling for new *models* — a new frontier release is a trigger to run the manifest.

## Track B — own the models end-to-end (the tiny-model fixture)

Two staged goals, on Apple Silicon, kept in a separate lab repo (`musterd-lab`), never the product repos —
it's a fixture + a research asset, not a shipped dependency.

- **Stage 1 — run a tiny local model as a dogfood agent.** A small instruct model (Ollama,
  `qwen2.5:3b-instruct` / `llama3.2:3b-instruct`) in a thin harness that reads the `AGENTS.md` primer,
  claims a seat (honest join), runs a work loop, and streams coordination telemetry. A *weak* agent
  stresses the guardrails (primer comprehension, identity binding, `superseded` revocation halting
  mid-task) in ways a frontier model papers over — the sharpest test that the primer + protocol work for
  non-frontier agents.
- **Stage 2 — train our own model from scratch.** A tiny GPT (MLX / `mlx-lm`, ~10–30M params,
  TinyStories/Shakespeare) to learn the internals, then taught the musterd command grammar so it can
  drive the Stage 1 harness. The far end of this track meets the **research ladder's final rung** (ADR
  056): a **fine-tuned coordination-judge model** trained on our own coordination-traces dataset — a model
  that scores coordination quality, which is both a research artifact and a batond eval component.

## How the two tracks connect

Track A tells us *how the best available models coordinate*; Track B gives us *models we fully control* to
probe the floor (weak agents) and eventually to **build the judge** that scores everyone. Both write into
the same lab notebook and the same dataset ladder, and both are measured on the coordination telemetry
that already ships by default (ADR 082). Neither is a near-term build item — they're the research spine
the roadmap's *Later* observability items (`eval-experiment-engine`, `coordination-dataset`,
`research-radar`) hang from.

## Related

- ADR 051 (flywheel — the experiment axis), ADR 056 (research as first-class — produce/ingest, the
  dataset ladder), ADR 052 (obs-evals gate — baselines), ADR 082 (the coordination telemetry it measures
  on).
- `docs/design/research-foundation.md` (external evidence), `docs/research/README.md` (the lab notebook),
  `docs/design/research-radar-plan.md` (ingest half), `docs/design/brand-coordination-observability.md`
  (batond, where the engine + judge live).
