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
