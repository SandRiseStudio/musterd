# musterd research — the lab notebook

> **Living log.** This directory is the *findings* side of musterd's research practice (ADR 056): per-experiment writeups and results a whitepaper is later assembled from. It is the counterpart to `../design/research-foundation.md`, which records the *external* evidence musterd consumes. Findings here → whitepaper → (eventually) a peer-reviewed contribution.

## Direction (ADR 056)

Research is the publishable output of the trace → eval → experiment flywheel (ADR 051), made citable by reproducible experiment manifests (ADR 051) + the baseline requirement (ADR 052). It runs both ways:

- **Produce** — dataset-first. The HuggingFace artifact ladder, in order: **dataset → benchmark + leaderboard → paper (arXiv → HF Papers) → fine-tuned coordination-judge model**.
- **Ingest** — the research radar feeds `../design/research-foundation.md`; findings that change a decision graduate to an ADR.

## First thesis — MAST in the wild

Operationalize MAST's multi-agent failure taxonomy ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)) as live detectors over musterd's act-typed message log — ignored `request_help`, circular handoffs, stalled threads, broadcast-only "journal" coordination. Substrate: the `coordination-density` insight + `telemetry-l2` work on the roadmap. Contribution vs MAST: the first **dataset + detectors of real coordination failures**, not annotated transcripts.

**First artifact:** an open, redacted coordination-traces dataset (OTel/Langfuse-shaped). Release is **gated on the opt-in + redaction posture** (ADR 051) being enforced — no dataset ships before consent/redaction is real.

## How to add a finding

One file per experiment/finding, `NNN-<slug>.md`: question · setup (the pinned experiment manifest) · baseline · result · honest-N caveat · what it changes (link any ADR/roadmap item it graduates to). Keep the Goodhart / human-vs-agent-measurement cautions (`../design/human-agent-dynamics.md` §4) in force — diagnostic instruments, never Member rankings.

_No findings logged yet — this is the stub that opens the practice._
