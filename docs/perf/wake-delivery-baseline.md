# Wake delivery baseline (ADR 209 / ADR 210)

The log ADR 210's Eval reads. ADR 210 must show that exact-match resume lowers p50/p95
allowance-equivalent cost per completed reply **against the ADR 209 portable/fresh cohort measured
under the same wake kinds** — so that cohort has to exist before the comparison means anything.

Method: `musterd report` → the `wake` section, whose split is derived in
`deriveWakeMetrics` (`packages/server/src/store/insights.ts`) from `residency.woke` /
`residency.wake_cost` audit rows, attempt-deduped per act. Both cohorts are counted over the same
act set, so they are comparable by construction rather than by a reader's assumption.

## 2026-08-04 — n=0. The cohort is empty, and that is the finding.

| quantity                               | value          |
| -------------------------------------- | -------------- |
| `residency.woke` rows, all time        | 33             |
| **most recent successful wake**        | **2026-08-01** |
| ADR 209 merged (#603)                  | 2026-08-03     |
| wakes since ADR 209 merged             | **0**          |
| audit rows carrying `delivery_outcome` | **0**          |
| audit rows carrying `exact_match`      | **0**          |
| wake leases claimed since ADR 209      | 3 (all failed) |

**No ADR 209 baseline can be computed, and none is recorded here.** This is not thin data that
better statistics could rescue: every wake in the ledger predates the ADR that introduced the
delivery axis, so the portable/fresh cohort has no members at all. Any p50/p95 quoted today would be
measuring the pre-ADR-209 resume ladder while calling it the fresh path.

The three leases since ADR 209 all failed rather than producing a wake:

- 2026-08-03, ryder — `wake_deferred` (live local session), then the lease expired.
- 2026-08-04 17:51:48, gptbot — `codex CLI not found (PATH + known install locations)`.

That last one is load-bearing for anyone reading this table as "the rail is just quiet": it is not
quiet, it is failing. `loops.review` was armed the same hour with `gptbot@codex` on `flow:auto`, and
the host actuator on `mac.lan` cannot resolve the `codex` binary — so every review wake fails this
way until that host's PATH is repaired. Raised to grokbot.

## Why the instrument shipped before the data

`deriveWakeMetrics` computed `resumed` from `detail.session` and split by neither
`delivery_outcome` nor `exact_match`, so even once wakes resume there was no query to run — the
same shape of gap as the missing `exact_match` emission (ADR 210, #627). The split now exists, and
the baseline fills itself in as soon as wakes occur.

**`delivery_measured` and `exact_match_measured` are honesty denominators**, in the mould of the
existing `cost_reported`. An unmeasured cohort reports zero counts _and_ a zero denominator, and the
report prints `delivery: unmeasured` rather than `0 fresh · 0 resumed · 0 fresh-fallback`. This is
deliberate and tested: a row of zeros reads like a measured result, and this table is exactly where
that misreading would have been laundered into a decision.

## What has to happen before ADR 210's switch can be justified

1. **Wakes have to occur on the portable path.** Blocked today by the actuator failures above; the
   codex-CLI one is gptbot's/grokbot's surface.
2. **A named ADR 209 fresh cohort** accumulates with `delivery_measured > 0`, giving the p50/p95 and
   inherited-context byte distribution ADR 209's own Eval names.
3. Only then does enabling `residency.exact_match_resume` for one workspace cohort produce a
   comparison rather than an anecdote. Byte, rate, and freshness bounds stay fixed until it has
   repeated observations behind it — ADR 210 says so, and nothing here changes that.
