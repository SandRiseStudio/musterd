# Frontier cadence manifest — the standing model-coordination experiment (ADR 101 §4)

> **Process, not a platform.** This is the reproducible experiment manifest (ADR 051) Track A of
> `docs/design/model-experimentation.md` runs when a new frontier model lands. Each run produces one
> `docs/research/NNN-*.md` finding; the per-model coordination leaderboard **accretes from findings**.
> It rides the ADR 101 foundation (per-occupancy attestation + the per-act model stamp) and needs no
> machinery beyond it.

## Trigger

A new frontier model release (any family). The research radar's sibling for new _models_: a release
is a trigger to run this manifest once.

## Deferred 2026-09-05 — the first result costs TWO runs, and that was never priced

**Status: deferred, with a restart condition.** The trigger has fired at least five times (Opus 5,
Fable 5.1, Grok 4.6, GPT-5.6-sol, Gemini 3.8-flash) and the manifest has never run. Finding
[011](011-frontier-cadence-observational-floor.md) establishes why, and it is structural rather than
neglect: `baseline` below is *"the prior model's run — the diff IS the result"*, so with zero runs on
record the FIRST run emits a row that cannot be read as anything. The first readable result costs two
runs, each a fresh team, two agent seats plus a human, hands-off to Goal completion or a 2h cap, on a
laptop that lives in swap and must stagger seat launches (`docs/wiki/nicks-laptop.md`).

**What restarts it:** a human decision to spend two runs back-to-back (not one), or a second machine
with capacity to hold a pinned team so the runs do not contend with the working laptop — the cloud
seat makes that newly plausible. Either is a research-budget call under ADR 056.

**What exists meanwhile, and what it is not:**
`scripts/research/frontier-cadence-observational.ts` reads per-model answered-ask latency off the
live corpus (380 pairs, 9 models, 2026-09-05). It is an observational floor with four large stated
confounds, **not** a leaderboard row and not a substitute for a run — every term this manifest pins
is free there.

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
