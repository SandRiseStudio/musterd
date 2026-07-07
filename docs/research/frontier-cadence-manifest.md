# Frontier cadence manifest — the standing model-coordination experiment (ADR 101 §4)

> **Process, not a platform.** This is the reproducible experiment manifest (ADR 051) Track A of
> `docs/design/model-experimentation.md` runs when a new frontier model lands. Each run produces one
> `docs/research/NNN-*.md` finding; the per-model coordination leaderboard **accretes from findings**.
> It rides the ADR 101 foundation (per-occupancy attestation + the per-act model stamp) and needs no
> machinery beyond it.

## Trigger

A new frontier model release (any family). The research radar's sibling for new _models_: a release
is a trigger to run this manifest once.

## The manifest (pin these per run)

| Term              | Pin                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`           | the exact released id (e.g. `claude-opus-4-8`) — attested via `MUSTERD_MODEL`, verified in the act log (`meta.model`) before scoring                                                 |
| `scenario`        | the fixed dogfood scenario: one Goal, two agent seats + one human seat, a dependency between two lanes, one mid-run steer — the shape the P3 post-mortem measured (~37% wasted work) |
| `harness`         | pinned harness + version per seat (model is the only varied term)                                                                                                                    |
| `prompt/guidance` | the stamped guidance content version (`musterd init --check` clean before the run)                                                                                                   |
| `team topology`   | identical seats/roles/capabilities across runs (`team export` snapshot committed with the finding)                                                                                   |
| `baseline`        | the prior model's run (ADR 052) — the diff IS the result                                                                                                                             |

## What we measure (the emitted coordination metrics, never reconstructed)

- `musterd.coordination.loop_latency` — directed-act close latency (accept/decline/resolve)
- `musterd.coordination.seen_latency` + the open directed ledger — raised→read, ignored asks
- resolve-rate — threads resolved / threads opened in-window
- dup-rate / wasted-work — lanes contention warnings + code produced vs merged (the ADR 083 measure)
- `musterd report coordination` — the MAST block (stalled threads, circular handoffs, diversity flags)
- task outcome — did the scenario's Goal derive `shipped`

## Run protocol

1. Fresh team from the pinned topology snapshot; `MUSTERD_MODEL=<id>` in each agent seat's env.
2. Confirm attestation: every seat's occupancy shows the pinned model (`occupancy.model_attested`
   audit rows; no `unknown` links — an unattested run is invalid, not "close enough").
3. Run the scenario to Goal completion or the 2h cap, hands-off except the scripted steer.
4. Pull the metrics + `musterd report coordination --json`; diff against the baseline run.
5. Write the finding: `docs/research/NNN-frontier-<model-id>.md` — the deltas, the leaderboard row,
   what changed in _coordination_ (not benchmark) terms.

## Leaderboard

One row per finding: `model · family · loop_latency median · resolve-rate · dup-rate · wasted-work ·
finding link`. Kept in the findings themselves (the newest finding carries the accumulated table) —
no separate store to rot.

## Related

ADR 101 (the foundation + this manifest's freeze), ADR 051 (experiment manifests), ADR 052
(baselines), ADR 056 (lab-notebook practice), `docs/design/model-experimentation.md` (Track A/B),
finding 001/002 (the measurement style this follows).
