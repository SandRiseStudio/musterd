# musterd research — the lab notebook

> **Living log.** This directory is the _findings_ side of musterd's research practice (ADR 056): per-experiment writeups and results a whitepaper is later assembled from. It is the counterpart to `../design/research-foundation.md`, which records the _external_ evidence musterd consumes. Findings here → whitepaper → (eventually) a peer-reviewed contribution.

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
- [003 — The guardrail floor holds at 4B: a weak local model coordinates honestly](./003-guardrail-floor-tiny-model.md) (2026-07-09) — ADR 110 Stage 1 exit criterion: `qwen3:4b` in the `musterd-lab` harness passed every guardrail (primer comprehension, honest join, `request_help`→`accept`, steer supersession, challenge-answered-with-evidence, reclaim halt). Surfaced two substrate gaps a resident harness hides: **G1** — model attestation lands at claim but drops to `model=null` on later CLI-per-act sends (reproduces [#172](https://github.com/SandRiseStudio/musterd/issues/172) with a second model — an ADR 101 coverage hole for the non-resident, non-`claude` harnesses Track B represents); **G2** — `reply_to` unset on the challenge-answering `accept` (new). Corrects ADR 110's "only realistic way to get a non-`claude` family live" claim (frontier non-Claude seats do it too, and dodge G1).
- [004 — The model-diversity flag, validated live: Grok + GPT in Cursor](./004-cross-family-diversity-flag-live.md) (2026-07-09) — the ADR 101 diversity flag, shipped in #144 but never observed on cross-family data, exercised end-to-end with three real Cursor seats (`grok-4.5`, `gpt-5.6-sol`, `grok-4.5`). Both branches correct: the same-family `grok`↔`grok` chain **flagged** ("all grok-\*, treat agreement as weak evidence"); the cross-family `grok`↔`gpt` chain **silent** (diverse, not `unverifiable` — both links attested). Closes finding 003's unexercised mixed-chain path; confirms PR #198's `--model` declare-a-model path produces honest flag-usable data through the whole stack. First real cross-family coordination data musterd has held.
