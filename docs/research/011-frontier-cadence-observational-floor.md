# 011 — The frontier cadence manifest cannot produce a result on its first run, and the corpus already holds an observational floor

**Date:** 2026-09-05 · **Seat:** dolly (claude-opus-5) · **Lane:** 01M1MMJ1ACS4MK4TFTXT90VJ8S (opened by ryder) · **Status:** finding

`docs/research/frontier-cadence-manifest.md` has never run — 0 of 843 lanes had ever mentioned it when ryder swept on 2026-09-03, and `research-corpus.md` has recorded "protocol written, zero runs recorded" since 2026-08-18. The lane asked for one of two things: run it once, or amend it with a dated reason it does not run and what would restart it.

Neither was possible without first answering a question nobody had asked: **what does one run actually produce?**

## The finding: run one produces no result, by the manifest's own definition

The manifest's `baseline` term is *"the prior model's run (ADR 052) — **the diff IS the result**"*. With zero runs on record, the first run has no prior. It emits a leaderboard row that cannot be read as anything: not fast, not slow, not better — just a number with nothing to sit against.

So the true cost of the first *result* is **two** runs, not one. Each run is a fresh team from a pinned topology, two agent seats plus a human, hands-off to Goal completion or a 2h cap. On this laptop that is a real constraint and not a scheduling detail: 8 GB, lives in swap, seat launches must be staggered (`docs/wiki/nicks-laptop.md`).

**That is the honest reason it has never run**, and it is a structural one rather than neglect. Nothing in the manifest says so — it reads as a one-run protocol, and the trigger has fired at least five times (Opus 5, Fable 5.1, Grok 4.6, GPT-5.6-sol, Gemini 3.8-flash) against a cost nobody had priced. The manifest is amended by this finding to state it (2026-09-05; falsify: a single run of the manifest that yields a readable leaderboard row without a prior run to diff against).

## What the corpus can answer today, with its confounds stated

The leaderboard is blocked on N. The controlled N does not exist — but the observational one is large and already on disk: **9,373 acts carry a model stamp across 12 models**, and 380 of them are directed asks paired to the act that answered them.

`scripts/research/frontier-cadence-observational.ts` reads that pairing: for each answered ask, how long the answering seat took, grouped by the model that seat attested. Run 2026-09-05 against `~/.musterd/musterd.db`:

```
model                            n  seats   median     p90   median<4h  n<4h
claude-opus-5                   116      6    59.1m   19.3h       28.9m    92
grok-4.6                        104      1     9.7m    1.6h        9.2m    94
gpt-5.6-sol                      52      1    61.6m    3.5h       45.9m    47
claude-fable-5                   50      5    21.8m   15.0h       14.2m    37
claude-fable-5-1                 24      4    14.8m    1.5h       12.4m    22
gpt-5.6-luna                     18      1    40.0m    1.8h       40.0m    18
muse-spark-1.3-contributor-free   7      1     4.1m    5.4h        2.7m     5
gemini-3.8-flash                  6      2    16.6m   12.0h       11.4m     4
claude-sonnet-5                   3      1    54.7m    1.7h       54.7m     3
```

**This is not a model ranking and must never be quoted as one.** Four confounds, each large enough to reverse the order:

1. **Seats are not exchangeable.** `grok-4.6` is one seat; `claude-opus-5` is six answering seats out of twelve stamped. Seat, role and task all vary with the model, so a difference here is confounded with the job. The `seats` column is printed beside `n` so the reader cannot miss it.
2. **The clock is wall-clock on a team that exists ~5h a day** (lane 01KZ9B4BXH). An ask raised at midnight and answered at 09:00 scores nine hours of nobody being there. The `<4h` columns crudely remove it — and note what that does to `claude-opus-5`: 59.1m → 28.9m, while `grok-4.6` barely moves (9.7m → 9.2m). Most of the gap between those two rows is *sleep*, not latency.
3. **The stamp mixes observation and declaration** (`docs/wiki/model-attestation.md`). The act log carries the id, not the tier, so a row is "what the seat said it was".
4. **Answered asks only.** An ask nobody ever answered contributes nothing, so every number is conditional on being answered — the survivorship ADR 277 had to bracket.

Falsifier for the table (2026-09-05): `node --disable-warning=ExperimentalWarning scripts/research/frontier-cadence-observational.ts` — re-run it; if the ordering moves materially on unchanged data, the instrument is wrong, not the corpus.

## What this does and does not unblock

It does **not** unblock the per-model leaderboard. That leaderboard is defined to accrete from manifest findings — controlled runs, one varied term — and an observational read of a live team is a different measurement wearing the same words. Publishing this as the leaderboard would be exactly [correct by coincidence](../wiki/correct-by-coincidence.md): a proxy that agrees with the truth only while nobody checks what varied.

What it gives is a **floor**: a first, dated, re-runnable statement of per-model coordination behaviour on this team, against which the first controlled run can be sanity-checked when someone pays for two.

## Open, and deliberately not decided here

Whether to pay for a two-run baseline at all, or to keep the manifest deferred and invest in the observational instrument instead. That is a research-budget decision (ADR 056 territory), and it wants a human. The manifest now carries the deferral and the restart condition either way.
