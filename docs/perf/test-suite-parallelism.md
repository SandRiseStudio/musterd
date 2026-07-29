# Test-suite parallelism — measured, and the cap not adopted

**Date:** 2026-07-29 · **Commit:** `c611b3b` (main @ #491) · **Author:** ryder

A negative result, recorded so nobody re-runs it. After [#491](https://github.com/SandRiseStudio/musterd/pull/491)
raised the test timeout ceiling, the obvious follow-up was to attack the contention itself by capping
`poolOptions.forks.maxForks`. **It was measured and not adopted: capping is not faster, and the
hypothesis behind it was wrong.**

## The hypothesis

`pool: 'forks'` defaults to one worker per CPU (8 on the dogfood box). That box has 8 GB of RAM and
routinely sits above 80% swap, and much of this suite boots real daemons, builds real git repos, and
spawns real CLIs. So: eight workers might thrash rather than parallelise, and **fewer workers might be
both faster and steadier**.

## Method

Full `pnpm test` runs at `maxForks ∈ {8, 6, 4, 2}`, wall time measured externally.

- The flag was **verified to take effect first** — a silently-ignored flag would make every arm
  identical and read as "no difference". On `packages/cli/src/commands`, `maxForks=1` took 13,536 ms
  against 4,285 ms at `maxForks=8`. It is live, and parallelism is worth **3.2x** on that subset.
- Runs were **interleaved and order-counterbalanced** (rep 1 ran 8→2, rep 2 ran 2→8), because this
  machine's load drifts hard.
- A **paired** phase then ran 8 and 4 back-to-back, three times, so both arms met similar conditions.

## Results

| rep             | 8      | 6      | 4      | 2      |
| --------------- | ------ | ------ | ------ | ------ |
| 1 (load 5→41)   | 21.6 s | 27.8 s | 24.1 s | 26.9 s |
| 2 (load 22→105) | 52.3 s | 53.8 s | 50.8 s | 24.9 s |

Paired, adjacent runs:

| pair | 8      | 4      | winner |
| ---- | ------ | ------ | ------ |
| 1    | 25.7 s | 27.5 s | 8      |
| 2    | 22.8 s | 22.0 s | 4      |
| 3    | 26.9 s | 40.6 s | 8      |

**Median: 8 → 25.7 s, 4 → 27.5 s.** 8 won two pairs of three.

## Conclusion: do not cap

The decision rule was fixed before the runs — _adopt only if faster or neutral on median wall time_ —
and a cap is neither. It is marginally slower at the median, loses two of three paired runs, and the
flag-sanity measurement shows parallelism is strongly beneficial (3.2x from 1→8). The swap-thrashing
hypothesis is **not supported**: the flakes were a timeout-calibration problem, which #491 already
fixed, not a parallelism problem.

**The honest caveat is that the effect is smaller than the noise.** Identical settings varied 2.4x
between reps (`maxForks=8` at 21.6 s and 52.3 s), because three other seats work on this machine and
their builds land whenever. This was not a clean bench and no amount of repetition would have made it
one; what the data supports is "no detectable win", not a precise ranking. A larger effect would have
shown through that noise, and none did.

## The by-product worth more than the result

Fourteen full-suite runs across `maxForks` 2/4/6/8 at load averages from **5 to 105** — every one
green, 2448/2448. That is the load verification #491 could not honestly claim: when that PR shipped,
its clean runs took ~19 s against the 157 s of the run that failed, so they said nothing about
behaviour under contention, and an attempt to induce load artificially was abandoned after it spiked
the machine. This experiment supplied the missing arm for free, on real contention rather than
synthetic. **#491's ceiling holds at load 105.**

## If this is revisited

Measure on a CI runner, not this laptop. GitHub runners differ in cores and RAM, the tuning does not
transfer, and a cap would change CI runtime for everyone. Re-run the flag-sanity check first — it is
the cheapest way to catch a measurement that is silently comparing a setting to itself.

---

# Revisited on CI — 2026-07-29

That last section is now done. The bench is a workflow (`.github/workflows/bench-forks.yml`,
manual-only via `workflow_dispatch`); this is its first full sweep, and it settles the question the
laptop could only shrug at.

**Runner: 4 cores, 15.6 GB. Vitest's default `maxForks` is one per CPU, so `maxForks=4` _is_ the
default here** — an arm at 4 is the default wearing a different label, not a treatment. This is why
the bench prints the core count: without it the table below is unreadable.

| rep        | default (=4)  | 1             | 2             | 4             |
| ---------- | ------------- | ------------- | ------------- | ------------- |
| 1          | 46,868 ms     | 47,030 ms     | 47,128 ms     | 46,824 ms     |
| 2          | 46,028 ms     | 47,848 ms     | 48,391 ms     | 46,540 ms     |
| 3          | 46,985 ms     | 47,904 ms     | 46,718 ms     | 46,908 ms     |
| **median** | **46,868 ms** | **47,848 ms** | **47,128 ms** | **46,824 ms** |

Twelve runs, all green. Reps 1 and 3 ran the arms forward, rep 2 reversed.

## Two findings, and the second is the interesting one

**1. The cap question is closed.** `maxForks=4` and the default land 44 ms apart on a 47-second run —
they are the same setting, exactly as the core count predicts, which is a pleasing check that the
harness measures what it claims. Capping CI to 4 would be a no-op because CI is already there. So the
cap was never a CI question at all; it was a question about local defaults, and #494 answered that one
on the machine where it mattered.

**2. The suite barely parallelises on a clean machine.** `maxForks=1` costs **2%** against 4 (47,848
vs 46,824 ms). One worker, on four cores, is two percent slower. The total spread across every arm and
rep is 46,028–48,391 ms — about 5%.

That second number reframes the laptop data rather than confirming it. On the dogfood box, 1 fork
against 8 was **3.2x** on a subset. Here, 1 against 4 is 1.02x on the whole suite. The difference is
not the fork count — it is that the laptop was swapping. **Nothing about this suite is CPU-bound**;
its ~47 s is dominated by work that does not parallelise (module transform and collect, real daemon
start-up, socket waits). Anyone hoping to make the suite faster should attack that, not the worker
count, and this table is the evidence for skipping the obvious-looking lever.

It also retires the last of the flake story. #482 fixed a real race, #491 fixed a miscalibrated
ceiling, and the "workers starve each other" theory that motivated both was a property of one
memory-constrained laptop, not of the suite.

## Known wart

The per-arm status reads `passed (count not parsed)`. The suite genuinely passed — a failing arm is
excluded from the median, printed with 60 lines of context, and fails the job — but the test-count
capture does not match vitest's output under `CI=true`, and the fallback added for exactly this did
not match either. The pattern works on a locally redirected run, so the CI reporter formats its
summary differently. Timings are unaffected; whoever next runs the bench should check the raw log and
fix the pattern against what is actually there rather than guessing a third time.
