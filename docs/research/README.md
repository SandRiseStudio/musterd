# musterd research — the lab notebook

> **Living log.** This directory is the *findings* side of musterd's research practice (ADR 056): per-experiment writeups and results a whitepaper is later assembled from. It is the counterpart to `../design/research-foundation.md`, which records the *external* evidence musterd consumes. Findings here → whitepaper → (eventually) a peer-reviewed contribution.

## Direction (ADR 056)

Research is the publishable output of the trace → eval → experiment flywheel (ADR 051), made citable by reproducible experiment manifests (ADR 051) + the baseline requirement (ADR 052). It runs both ways:

- **Produce** — dataset-first. The HuggingFace artifact ladder, in order: **dataset → benchmark + leaderboard → paper (arXiv → HF Papers) → fine-tuned coordination-judge model**.
- **Ingest** — the research radar feeds `../design/research-foundation.md`; findings that change a decision graduate to an ADR. Implementation plan (not built): `../design/research-radar-plan.md`.
- **Model as a variable** — early to each frontier model (run the manifest as one lands) + own models end-to-end (the tiny-model fixture → a fine-tuned coordination-judge): `../design/model-experimentation.md`.

## First thesis — MAST in the wild

Operationalize MAST's multi-agent failure taxonomy ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)) as live detectors over musterd's act-typed message log — ignored `request_help`, circular handoffs, stalled threads, broadcast-only "journal" coordination. Substrate: the `coordination-density` insight + `telemetry-l2` work on the roadmap. Contribution vs MAST: the first **dataset + detectors of real coordination failures**, not annotated transcripts.

**First artifact:** an open, redacted coordination-traces dataset (OTel/Langfuse-shaped). Release is **gated on the opt-in + redaction posture** (ADR 051) being enforced — no dataset ships before consent/redaction is real.

## How to add a finding

One file per experiment/finding, `NNN-<slug>.md`: question · setup (the pinned experiment manifest) · baseline · result · honest-N caveat · what it changes (link any ADR/roadmap item it graduates to). Keep the Goodhart / human-vs-agent-measurement cautions (`../design/human-agent-dynamics.md` §4) in force — diagnostic instruments, never Member rankings.

## Findings

- [001 — Telemetry gaps: the flagship session left almost no machine trace](./001-telemetry-gaps-p3-dogfood.md) (2026-06-30) — the P3 dogfood was near-unobservable from musterd's own telemetry (OTel inert, no PostHog project, Langfuse + audit-log empty, `daemon.log` info-only); the whole cost analysis was reconstructed forensically from the message DB + transcripts. Concrete gap-list + the candidate coordination evals. **Resolved by ADR 082 (2026-07-01): instrument-by-default + HTTP request log + first-party coordination metrics + opt-in per-agent tokens.**
- [002 — Our own live telemetry caught the broadcast-journal anti-pattern](./002-telemetry-caught-broadcast-journal.md) (2026-07-04) — the sequel to 001: with instrument-by-default on (ADR 082), ~53 h of live OTel from the local sink shows the team is journaling, not coordinating — 84% `status_update`, 85% broadcast-to-team, exactly 3 closed-loop acts in 3 days, a directed loop hung ~70 h, and the human absent from the current team's trace. Coordination-density (ADR 050) firing on its own authors; real data behind the interrupt-line/reachability wave (ADR 088). Surfaced the telemetry identity-attribution bug (`musterd.from` keys on display name → cross-team fragmentation).
