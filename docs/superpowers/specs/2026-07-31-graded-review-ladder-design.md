# Graded review ladder + two-review risky lanes — design

Date: 2026-07-31. From a brainstorm between nick and ryder, on the evidence of the first 17
review episodes. Becomes ADR 188 (number to re-verify against origin/main at PR time).

## The evidence this answers

All 17 lanes that ever entered `ready_for_review` closed unverified or worse:

- 12 × `no_candidate` — the picker found nobody, no ask was ever sent.
- 4 × `review_timeout` — early rows predating the `no_candidate` label; closed in 8–161 s, so
  mostly mislabeled no-candidates.
- 1 × `counterpart_confirm` — a **same-family** voluntary confirm (ryder on dolly's lane), which
  the picker would never have routed and which today reads `verified: true` with no qualifier.

Review-catch rate: 0/17. Binding constraint: **family granularity**. dolly (opus-4.8) was live
during several no-candidates but counts as `claude`, identical to every other seat. Decorrelation
is a spectrum; the boolean rule treats its middle as its bottom, and the measured output of the
whole review stage is nothing.

Second finding, from the one verified close: `verified` is derived purely as "closer ≠ owner".
Family is recorded but never *checked* at close, so a same-model confirm implies a diversity it
does not have.

## Decision 1 — review grade, a three-value spectrum

New protocol helper `reviewGrade(workerModel, reviewerModel)` beside `modelFamily`:

| grade | meaning |
| --- | --- |
| `cross_family` | different families (claude → gpt). The ideal. |
| `cross_model` | same family, different model (opus-5 → opus-4.8, opus-5 → fable-5). Accepted. |
| `same_model` | identical model. Never routed; recordable when it happens voluntarily. |

Either side unknown → no grade, ineligible for routing (the ADR 158 posture: say nothing rather
than something false). Model identity is the attested ID with any trailing date stamp normalized
away (`claude-haiku-4-5-20251001` ≡ `claude-haiku-4-5`) — one tested function, no other guessing.

Humans are `cross_family` by construction, as today.

## Decision 2 — the picker becomes a ladder

`pickReviewCounterpart`, non-risky lanes: live human first, then the best available grade —
`cross_family` preferred, `cross_model` accepted, `same_model` never routed. The
`lane.ready_for_review` audit row records the achieved grade, so a cross-model routing is never
mistaken for a cross-family one.

Prediction (pre-registered in the ADR): with any second model live, the `no_candidate` rate —
16/17 lifetime — collapses. With today's roster (fable-5, opus-5, opus-4.8) every seat can review
every other.

## Decision 3 — risky lanes need two reviews, peer first

A lane with any declared `risk` tag (`user-facing`, `production`, `cost`, `destructive`,
`complex` — declared at `lane_open`/`lane_update`, never inferred) requires **both**:

1. **Peer review** — the ladder above, same as any lane. The ask fires at ready time.
2. **Human review** — a live human seat. The human ask fires **only after** the peer confirms or
   the peer window lapses (nick's ruling: human attention is the scarce resource — the
   2026-07-28 datum is 40 manually-authorized PRs in one day). The peer's findings ride in the
   human ask's body, so the human reviews an already-screened change.

This replaces the current risky-lane routing (human only, one review). The lane holds
`ready_for_review` through both stages — no new state.

Degradation, per review, never a wedge:

- Peer stage silent/no candidate → recorded, human ask fires anyway (the requirement that exists
  is not skipped because the optional-stage failed).
- Human stage silent/no human live → self-close sanctioned; close records `human_review_missed`
  (exists today) — a requirement with no one to meet it, said loudly.

## Decision 4 — the close edge finally checks

`lane.closed` derives `review_grade` from the two seats' attested models at close — for routed
confirms and voluntary ones alike. `verified` keeps its exact current meaning (a different seat
confirmed — nick's ruling); the grade rides beside it, so:

- The worked example: ryder (opus-5 at close time) confirming dolly (opus-4.8) derives
  `cross_model` — the row stops implying more than happened, and stops implying less too.
- A risky close additionally records which of the two required reviews actually happened
  (`peer_review: <grade> | none`, `human_review: true | false`), extending the existing
  `human_review_missed` derivation rather than replacing it.

## What deliberately does not change

- Tier and timeout: the review ask stays species `approve`, tier `standard`, 5 m,
  proceed-on-silence.
- Self-close stays sanctioned; no hard state machine appears; any transition remains legal and
  merely derives its honest labels.
- Wake/spend for offline reviewers stays ADR 179 inc 5's call. The ladder only widens who counts
  among **live** seats.
- ADR 187's split stands: routing reads live presence only; the durable record serves the wake
  pool. The ladder compares live attested models.

## Observability & Evaluation (for the ADR)

- Traces: `ready_for_review` rows gain `review_grade` (routed) or `no_candidate` as today;
  `lane.closed` rows gain `review_grade` (+ `peer_review`/`human_review` on risky lanes).
- Eval: direct assertion — ladder ordering, date-stamp normalization, same-model never routed,
  two-stage sequencing, each degradation path. Baseline is the 17-row table above, kept queryable.
- Experiment: the pre-registered prediction in Decision 2. Whether review *strength* (grade)
  correlates with catch rate becomes answerable once grades exist — that analysis belongs to a
  later ADR 056 pass, not here.

## Increments

1. Protocol: `reviewGrade` + model-ID normalization + tests.
2. Picker ladder + graded `ready_for_review` audit + tests.
3. Close-edge grade derivation + tests.
4. Two-review risky sequencing (peer-gated human ask) + tests.

Each increment lands green independently; 1–3 are one PR, 4 is its own (it touches ask
composition and is the only behaviorally-new machinery).
