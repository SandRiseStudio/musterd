# 188 — The graded review ladder: decorrelation is a spectrum, and risky lanes take two reviews

- Status: proposed — 2026-07-31. Authored by ryder from a brainstorm with nick the same day, on the
  audit of the first 17 review episodes. Number **188** — verified free against `origin/main` at
  branch time (highest there: 187).
- Date: 2026-07-31
- Builds on: [ADR 169](169-two-stage-close.md) (the two-stage close whose picker and close edge
  this re-grades), [ADR 172](172-model-family-posture.md) (the risky-lane human requirement, kept
  at full strength and re-sequenced), [ADR 158](158-model-attestation-truth.md) (attestation truth
  — unknown grades nothing), [ADR 187](187-durable-model-attestation.md) (the presence-only routing
  predicate this ladder compares with), [ADR 056](056-research-as-first-class-practice.md) (why the
  grade must be recorded, never collapsed), [ADR 173](173-absent-is-not-unknown.md) (the counted
  abstention at the close edge), [ADR 147](147-human-ask-stream.md) /
  [ADR 153](153-ask-reachability-gated-hold.md) (the ask tiers both review stages ride).
- Spec: [2026-07-31-graded-review-ladder-design](../superpowers/specs/2026-07-31-graded-review-ladder-design.md);
  plan beside it.

## Context

Seventeen lanes entered `ready_for_review` before this ADR. Every one closed without a real
review:

| outcome                      | count | note                                                                             |
| ---------------------------- | ----- | -------------------------------------------------------------------------------- |
| self-close, `no_candidate`   | 12    | picker found nobody; no ask ever sent                                            |
| self-close, `review_timeout` | 4     | pre-`no_candidate` rows; closed in 8–161 s — mostly mislabeled no-candidates     |
| `counterpart_confirm`        | 1     | a **same-family** voluntary confirm, recorded `verified: true` with no qualifier |

Review-catch rate: 0/17. The binding constraint was **family granularity**: the boolean rule
(different family or nothing) counted a live opus-4.8 seat as `claude`, identical to the opus-5
worker, during several of those no-candidates — so the middle of the decorrelation spectrum was
treated as its bottom, and the review stage produced nothing at all. The honest comparison is not
"cross-model review vs cross-family review"; it is **cross-model review vs no review**, which
cross-model wins.

The seventeenth row exposed the second defect: `verified` derives purely from "closer ≠ owner".
Family is _recorded_ at close but never _checked_, so a same-model confirm reads as verified with
no qualifier — the pick edge's failure shape (fixed for the wake pool in ADR 187) sitting
unfixed at the close edge.

## Decision

### 1. `reviewGrade` — a three-value spectrum in protocol

`reviewGrade(workerModel, reviewerModel)` beside `modelFamily`: different families →
`cross_family`; same family, different model → `cross_model`; identical → `same_model`; either
side unknown → `null` (ineligible to route, ungraded at close — say nothing over something false,
ADR 158). Model identity is `normalizeModelId`: trim, lowercase, strip one trailing 8-digit date
stamp (`claude-haiku-4-5-20251001` ≡ `claude-haiku-4-5`). No other inference.

### 2. The picker is a ladder

Non-risky lanes: live **human** first (cross-family by construction, graded `human`), then
`cross_family`, then `cross_model`. `same_model` and ungradeable seats are never routed. The sort
is stable — among equal grades, roster order stands; no new tie-break policy. `ReviewPick` gains
`grade`; the historical two-value `route` is kept for wire compat and the grade carries the finer
truth. The `lane.ready_for_review` audit row, the review ask's `meta.lane_review`, and the verb
response all record the achieved grade.

**Pre-registered prediction:** the `no_candidate` rate (16/17 lifetime) collapses whenever any
second model is live. On the authoring-day roster (opus-5, opus-4.8, fable-5) every seat can
review every other.

### 3. The close edge finally checks

Every verified close derives `review_grade` from the two seats' live attested models — routed and
voluntary confirms alike. A human confirmer grades `human`. `verified` keeps its exact meaning (a
different seat confirmed — nick's ruling): a same-model voluntary confirm stays `verified: true`
**with `review_grade: same_model` beside it**, honest at every reading depth. An unattested model
at close abstains — and the abstention is counted (`review_grade_unknown: true`, ADR 173), never
left indistinguishable from a legacy row.

### 4. Risky lanes take two reviews, peer first (increment 2, PR B)

A lane with any declared `risk` tag requires **peer review then human review**. The peer ask
(ladder, tier `standard`) fires at ready time; the human ask (tier `blocking`) fires when the
peer's _accept lands on the ask thread_ — not on `lane_resolve`, which would close the lane — and
carries the peer's findings, so the human reviews an already-screened change. Sequencing is
nick's ruling: human attention is the scarce resource (the 2026-07-28 datum: 40
manually-authorized PRs in one day).

Degradations, per stage, never a wedge: no peer candidate → the human ask fires immediately (a
requirement is not gated behind a stage that cannot happen); peer confirmed but no human live →
recorded, and an owner self-close derives `human_review_missed` exactly as today, now beside
`peer_review: <grade>`.

## What deliberately does not change

- The ask tiers and timeouts; self-close stays sanctioned; no hard state machine appears.
- The risky-lane human requirement's _strength_ (ADR 172) — only its sequencing.
- ADR 187's split: routing and grading read live presence only; the durable record stays the wake
  pool's.
- Wake/spend for offline reviewers — ADR 179 increment 5's call, unchanged.

## Observability & Evaluation

- **Traces.** `lane.ready_for_review` gains `review_grade` (routed) beside the existing
  no-candidate/posture shapes; `lane.closed` gains `review_grade` or a counted
  `review_grade_unknown`; PR B adds `lane.review_peer_confirmed { lane, peer, grade,
human_ask_fired }`. The 17-row baseline table stays queryable and is the before-state.
- **Eval.** Direct assertion, no dataset — this is routing mechanics, not model behavior: ladder
  ordering (human > cross_family > cross_model), same-model never routed, date-stamp
  normalization, the close-edge grades (human / cross_model / same_model / abstain), and each
  degradation path, all through-DB.
- **Experiment.** The §2 pre-registered prediction is checkable on the next handful of
  `ready_for_review` rows: `no_candidate` should collapse whenever two distinct models are live.
  Whether review _strength_ correlates with catch rate becomes an answerable ADR 056 question once
  grades exist in the record — that analysis is deferred until there are verified closes to
  stratify, and does not gate this ADR.

## Consequences

- The review stage can produce reviews on a one-family roster, graded honestly, at zero new spend.
- `verified: true` stops implying diversity it cannot show; readers who need the strength read the
  grade.
- A future eval can ask "do cross_family reviews catch more than cross_model ones?" against real
  rows — the question the boolean rule made unaskable.
- Two historical fields (`route`, `reviewer_family`) are now partially redundant with the grade;
  they are kept for wire compat and retired, if ever, by their own decision.

## Related

- Lane `01KYWHBGD6`. The 17-row audit and the dolly-was-live finding: lane `01KYV4Q6GY` (ADR 187).
