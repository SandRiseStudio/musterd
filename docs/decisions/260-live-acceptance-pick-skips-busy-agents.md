# 260 — Live acceptance pick skips a busy agent

- Status: accepted
- Date: 2026-08-12
- Owner: wanderer
- Relates to: ADR 188 (graded live pick), ADR 191 (wake when live pick is null), ADR 219 (quiescence already marks busy *offline* seats unspendable), ADR 252 (wake cost is under-priced on the failure path), ADR 253 (agents-only live pick), quiet-set spec increment 1

## Context

`pickReviewCounterpart` filters candidates with `hasLivePresence`. On revive, live usually means heads-down. Named live accepts hit the 10-minute bar 24% of the time; busy named agents eventually confirm ~80% at mean 273 minutes. ADR 219 already refuses to *wake* a busy seat. The live pick still targets them.

## Problem

Presence is not reachability. Sole-targeting a mid-turn agent plus ADR 202 (only the named seat can `accept`) is the 273-minute path.

## Decision

The live agent pick drops a candidate when `resolveQuiescence` on their newest work audit is `busy` (line = `QUIESCENCE_DEFAULT_QUIET_AFTER_MS`, 120s). `unknown` (no work audit in lookback) stays eligible. `occupancy.model_attested` is not work. `pickHumanReviewer` is not filtered. A null live pick still takes the ADR 191 wake path.

## Consequences

A team whose every live cross-model agent is mid-turn will wake an offline seat (or `no_candidate`) instead of asking the busy one. Evenings on revive are exactly that shape — everyone live, everyone heads-down — so increment 1 shifts volume onto the ADR 191 paid-wake path. Increment 2 (eligible-set fan-out) is not implied; measure first, including that wake cost.

## Observability & Evaluation

**Traces.** None new. The ready-row still records `reviewer` + `route` + `grade`. A wake that used to be a live pick is already visible as `wake_queued`.

**Eval.** Dataset: `lane.ready_for_review` joined to `lane.closed` on revive, **after** `stakes_defaults packages/web/**=low` was armed, non-exempt.

1. Counterpart confirm in ≤10 minutes among live-routed submits (`wake_queued` false). Baseline: 24% (14-day live named). A jumped route is `closer != ready-row reviewer AND closer != owner` — classify by join; drop those from the confirm numerator (do not hand-exclude #779).
2. Wake-route volume before vs after this ADR (`wake_queued` / ADR 191 path, plus `residency.woke` and unpriced sessions). ADR 252: `cost_usd_total` under-prices the failure path, so count leases and unpriced sessions, not only attested spend. A 10-minute-rate win bought with extra paid wakes is not a win.

**Experiment.** None. Observational before/after on the live log. If (1) does not move and stalls are attention-while-quiet, do not build increment 2 from this ADR. If (1) moves and (2) rises sharply, the next lever is whether that wake cost is acceptable.

- **2026-08-13 — the window is confounded from day one** (stanley, acceptance of #785 / lane
  `01KZ9FNC6VQ8NJH7R2KAMCV5D1`; the Decision is frozen, this note governs the Eval). The dataset is
  conditioned on "after `stakes_defaults packages/web/**=low` was armed", but that window also
  contains #768 (relayed authorization became a countable third acceptance shape), #771 (the `why`
  slot stopped serving discharged handoffs), #773 (value-layer outcome notes / claim-time linking /
  `stale_acceptance` visibility), **and the arming itself**. Arming does not only shift latency: it
  **removes no-risk web-only lanes from acceptance**, changing the population being measured, not
  only its speed. Four interventions plus a composition change, on a team where a handful of lanes
  moves any statistic.

  The read stays valid in the **disproof** direction: a 10-minute rate that fails to move indicts
  increment 1 regardless of the confounds' sign (none of them aimed to make busy-agent targeting
  *worse*). Any *credit* read — "increment 1 moved the rate" — must name the whole stack, not this
  ADR alone.

- **2026-08-14 — the Eval was run, and it cannot be read as a before/after. The disproof direction
  is gone too** (izzo, lane `01M011HP1E`; instrument:
  `scripts/research/adr-260-acceptance-eval.ts`, re-runnable and read-only — falsify by re-running
  it, not by re-reading this note). Windows: ARM = 2026-08-12 21:14 (the `policy.change` arming
  row); ON = **2026-08-13 10:02**, the first autorefresh bounce carrying #785 — not the 09:33 merge
  and not the commit's 08-12 author date, because the filter lives in the daemon (falsify:
  `git merge-base --is-ancestor 33489b4c 5f9d427`).

  | window | n live-routed | good ≤10m | any confirm | median age | cross_family share |
  | ------ | ------------- | --------- | ----------- | ---------- | ------------------ |
  | baseline, pre-arming (13d) | 102 | **23%** | 61% | 17m | 21% |
  | post-arm, increment 1 OFF (12.8h) | 9 | 89% | 89% | 4m | 100% |
  | post-arm, increment 1 ON (28h) | 18 | **6%** | 83% | 60m | 61% |

  The instrument reproduces the ADR's published 24% baseline at 23% on an independent
  implementation, which is the only reason to trust the rest of the row.

  **Why the OFF window is not a control:** 8 of its 9 goods are one seat (wanderer) clearing six
  lanes between 21:45 and 22:10. That is a batch acceptance session, not a routing latency. Nobody
  should cite "89% before".

  **Why the disproof read is no longer safe.** The note above rests on "none of the confounds aimed
  to make busy-agent targeting *worse*". One does. Acceptance routing concentrated onto a single
  cross-family seat — `cross_family` share by day is 0–11% through 08-05, then **70% on 08-12, 57%
  on 08-13, 83% on 08-14**, with wanderer as top reviewer every one of those days. That shift is
  dated **08-12, a full day before #785 went live**, so increment 1 did not cause it: it is ADR 253
  (#752, humans out of the live pick, merged 08-12 13:44) meeting the LADDER sort in
  `packages/server/src/store/review.ts:369`, which puts `cross_family` first — and on a
  claude-monoculture team with one grok seat, "highest grade available" resolves to the same name
  every time. A queue at one acceptor depresses the 10-minute rate on its own. Increment 1 plausibly
  *amplifies* it (dropping busy claude seats leaves that seat top of the ladder more often), but the
  concentration predates it and cannot be charged to it. So the 23% → 6% move indicts nothing:
  disproof and credit are both unavailable on this window.

  **What survives the confounds, because it needs no baseline.** In the ON window the seat that was
  asked answered **15 of 18** asks — only 2 jumped, 1 still open — at a 60m median, with exactly 1
  inside 10 minutes. Candidate *supply* is not the binding constraint; the correctly-routed, quiet
  seat is slow to look. On 12 of the 16 slow rows the asked seat has its own `lane.closed` /
  `git.pr_merged` audits between the ask and the close: it was awake and servicing other lanes while
  this ask sat. That is the attention signature this ADR pre-registered as the stop condition, and
  it is visible without comparing windows at all.

  **Eval item 2** (uncensored, sweeps included): median 60m and >12h at 9% (2/22) in the ON window
  against 17m and 19% (30/161) at baseline — the tail improved while the head got worse, consistent
  with a queue rather than abandonment.

  ~~**Eval item 5, the one clean before/after** (both sides post-arming, post-#752, both spanning a
  night): wake leases **0.23/h → 1.10/h** (3 in 12.8h → 31 in 28.2h), `wake_deferred` **0 → 26**,
  `residency.woke` 0 and `residency.wake_cost` 0 on both sides. This ADR's Consequences predicted
  the shift onto the ADR 191 paid path and it happened at roughly 5× the rate; ADR 252's
  under-pricing is visible in the same row, since 31 leases produced zero priced wakes.~~
  **RETRACTED 2026-08-14 — see the correction note below. It was not clean and it was not 5×.**

  **Verdict: do not build increment 2 from this Eval, and do not build it yet.** Not because
  fan-out was disproved — it was not tested — but because the window cannot answer the question and
  the one signal that does survive points at attention, which a wider candidate set does not fix.
  n=18 over 28 hours, one of them the a11y incident evening with several seats heads-down. Re-run
  the instrument after a week with no routing changes landing in it.

- **2026-08-14 (later) — I retract item 5, the one arm I vouched for; and the standing condition is
  worse than "re-run in a clean window"** (izzo, lane `01M015ENX2M`; prompted by stanley's #844 /
  ADR 269, verified here before believing it — falsify by re-running
  `scripts/research/adr-260-acceptance-eval.ts`, which now prints both figures side by side).

  **The lease rate was churn, not volume.** An act that cannot settle is re-leased, so a lease count
  measures failure-to-settle as much as it measures wakes. Measured: one act held **12 leases**, and
  leases-per-act ran **2.7** (baseline) → **5.2** (post-#785). On distinct wake *decisions* the
  comparison is:

  | window | leases | leases/h | **decisions** | **decisions/h** |
  | ------ | ------ | -------- | ------------- | --------------- |
  | OFF (12.8h) | 3 | 0.23 | **1** | 0.08 |
  | ON (29.2h) | 31 | 1.06 | **6** | 0.21 |

  One decision versus six is not a measurement, and the "roughly 5×" was mostly the same handful of
  acts failing to settle. stanley's cause is upstream of mine and correct: `transcript_age_ms` used
  `Date.now() - mtimeMs`, `mtimeMs` is fractional on APFS, the schema said `.int()`, so Zod rejected
  the whole report and the settlement died with the cost — 48 refusals, $22.54 of real spend, and
  **the refusal left no ledger row at all**.

  **Two consequences, and the second is the important one.**

  1. The guard's predicate was a category too narrow. It watched *who is asked* (`review.ts`,
  `orientation.ts`, `envelope.ts`) while item 5 depends on *what moves act/lease volume*. #844
  touches neither those paths nor policy, so the old guard would have passed it and let the re-run
  read a genuine lease-rate drop as a routing result. The watched set now includes the wake path
  (`WAKE_PATHS`), and the instrument reports decisions beside leases so the churn cannot hide again.

  2. **A window boundary cannot exclude contamination that leaves no trace.** This defect ran ~3
  weeks inside every window this Eval measured, in both arms, and nothing recorded it arriving. So
  the note above — "re-run after a week with no routing changes" — promises more than any freeze can
  deliver: holding files still excludes changes we can *see*. miley reached the same place from the
  other side while considering a freeze that would have cost them work ("11 routing commits and 4
  policy changes in 7 days" is a standing condition, not this window's workaround). The honest
  standing claim for this ADR is therefore: **acceptance routing on this team changes faster than it
  can be measured, and some of that change is structurally unobservable at the window boundary.**
  Any future acceptance statistic quoted over a multi-day window here should carry that sentence.

  What survives all of it, and is now the only claim in this report I would defend: the asked seat
  answers 15/18 at a 60m median (attention, not supply), and **top-reviewer concentration**, which
  has now reproduced at two different n (50% at n=18, 56% at n=57) and is untouched by the wake path.
