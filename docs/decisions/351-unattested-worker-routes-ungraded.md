# 351 — An unattested worker routes at the rung below the ladder, and the record claims nothing

- Status: proposed — 2026-09-02
- Date: 2026-09-02
- Authored by ryder on lane `01M1G2DFKDK9SMR67AZHVGAY3H`; the choice is nick's (2026-09-02, option 1
  of three), the deferral was #1160's.
- Builds on: [ADR 188](188-graded-review-ladder.md) (the ladder this adds a rung under),
  [ADR 303](303-auditable-review-selection.md) (the selection snapshot and `worker_unattested`),
  [ADR 173](173-absent-is-not-unknown.md) (the counted abstention at close),
  [ADR 187](187-durable-model-attestation.md) (why the durable record may not fill the gap),
  [ADR 260](260-live-acceptance-pick-skips-busy-agents.md) (the concentration eval whose
  population an ungraded row must stay out of), [ADR 348](348-an-acceptance-can-be-routed-by-hand.md) (the precedent for a route value
  that means "not the ladder's evidence"), [ADR 056](056-research-as-first-class-practice.md) (the
  conclusions a false grade would poison)

## Context

ADR 188 grades a worker/reviewer pairing on a three-value spectrum and routes nothing it cannot
grade: `reviewGrade` returns null when either side's live occupancy attests no model. #1160 fixed
the *attribution* of that null — a gradeable candidate blinded by an unattested worker is filed
`worker_unattested`, not as its own `unknown_grade` — and deliberately left the routing question
open: should an unattested worker be routed at all?

**Measured 2026-09-02, live `audit` table.** The storm that produced six of the first ten such rows
in one day (#1143) is over, and the shape persists in the healthy state:

- 12 `no_candidate` rows now carry the unattested-worker shape (10 at #1160's measurement); the
  two new ones are big-body at 23:40 and 23:47 UTC on 2026-09-01, each four seconds after a
  `claim.occupied {surface: "cli"}` that attested nothing.
- Since the storm ended (22:00 UTC 2026-09-01) the seats made 244 claims from the `cli` surface
  against 50 from `claude-code`; big-body made 161 CLI claims of which 72 carried a model.
- 7 attested→null flips are still logged after the storm, the last at 01:51 UTC 2026-09-02.

So "the worker attests nothing at the moment it calls `lane_ready`" is not a fault condition. It is
what a seat driving lanes through a shell looks like whenever the harness binding is absent, and
[ADR 246](246-the-cli-attests-what-the-harness-observed.md) already says the CLI attests only what
it observed. Today that seat's non-risky lane gets **no review** — the risky path already falls
through to the human ask (ADR 188 §4), so the loss is confined to non-risky lanes, which is most of
them.

Three options were put to nick:

1. Route the unattested worker to a live, attested peer at a new bottom rung, recording that the
   pairing proves nothing.
2. Keep routing nowhere — honest, zero code, and the lanes stay unreviewed.
3. Grade the worker from its durable attestation (ADR 187). Cheapest, and exactly what ADR 187
   forbids: a stale memory certifying a live review as cross-family.

nick chose 1.

## Decision

### 1. `ungraded` — the rung below the ladder, not a fourth grade

The live picker (`selectReviewCounterpart`) gains one rung under `cross_model`: when the **worker's**
live occupancy attests nothing and a candidate's does, the candidate is selectable at grade
`ungraded`. Order among ungraded candidates is roster order, as at every other rung (the stable
sort; losers file `tie_break`). A candidate that itself attests nothing stays `unknown_grade` and is
never routed at any rung — two unknowns prove even less than one. A worker that *is* attested is
unchanged: `same_model` stays excluded, and nothing falls to `ungraded` as a consolation.

`ungraded` is deliberately **not** added to `REVIEW_GRADES`. `reviewGrade` still returns null for
the pairing; the rung is the picker's, expressed as `PickGrade = ReviewGrade | 'human' | 'ungraded'`
in `packages/server/src/store/review.ts`. Nothing that reasons about decorrelation can pick it up
as a grade by accident.

### 2. Its own route value

An ungraded pick carries `route: 'ungraded'`, not the wire-compat `'cross_family'` every other
picker route reuses. `route` is the field the ADR 260 eval filters its `liveRouted` population on,
and [the wiki records](../wiki/acceptance-routing.md) why a new value must be excluded from that
population **on arrival, before its first row lands**: the ladder did choose here, but it chose
among pairings it could not grade, so the row is no evidence about decorrelation in either
direction. `scripts/research/adr-260-acceptance-eval.ts` excludes `route === 'ungraded'` from
`liveRouted` and counts it in the printed mix beside `hand-routed`, so the mix keeps summing.

### 3. The close edge already abstains — and now it is exercised

ADR 188 §3 grades every verified close from the two seats' live attested models, and an unattested
model at close abstains with a counted `review_grade_unknown: true` (ADR 173). That path existed
for voluntary confirms; an ungraded routing is the first thing that reaches it by design. The close
row reads `verified: true, review_grade_unknown: true` — a different seat confirmed, and nobody
claims to know how different.

### 4. `worker_unattested` becomes historical

The ADR 303 exclusion value is kept in the type so rows from 2026-09-01 to this ADR still parse. New
rows do not write it: under an unattested worker a gradeable candidate is either selected or
`tie_break`.

## What deliberately does not change

- `reviewGrade` and `REVIEW_GRADES` in protocol. The spectrum is still three values plus null.
- ADR 187's split. The durable record still answers only "what would waking this seat bring".
- The risky-lane path (ADR 188 §4): peer then human, with the human ask firing on no peer.
- `worker_family` on the ready and close rows (ADR 303 / #1160) — an ungraded row carries
  `worker_family: 'unknown'`, which is how a reader tells this rung from a graded one without the
  grade.
- The root cause. A CLI claim that carries no attestation when the harness binding is absent is a
  separate lane under ADR 246; this ADR makes the gap survivable, not smaller.

## Observability & Evaluation

- **Traces.** `lane.ready_for_review` rows with `route: 'ungraded'`, `review_grade: 'ungraded'`,
  `review_selection.worker_family: 'unknown'`, and `selected.grade: 'ungraded'`. The reviewer's ask
  carries `lane_review.grade: 'ungraded'`. `lane.closed` carries `review_grade_unknown: true` when
  the worker is still unattested at close.
- **Eval.** Direct assertion, through-DB: an unattested worker with two attested live peers routes to
  the first in roster order at `ungraded` with the second `tie_break`; an unattested *candidate*
  stays `unknown_grade`; an attested worker's `same_model` twin stays excluded (no fall-through);
  the HTTP ready → ask → close round trip records `ungraded` at ready and `review_grade_unknown` at
  close (`review.test.ts`, `integration.test.ts`).
- **Pre-registered prediction.** The unattested-worker `no_candidate` shape (12 rows to 2026-09-02,
  see [the wiki page](../wiki/unattested-worker-blinds-the-picker.md)) stops growing; the same seats
  and moments produce `route: 'ungraded'` rows instead. Falsify: a `no_candidate` row after this
  ADR lands whose `worker_family` is `unknown` and whose candidates include a live attested agent.
- **What it must not move.** ADR 260's `crossFamilyShare` and top-reviewer concentration: an
  ungraded row is out of `liveRouted`, so the pre-registered metrics see the same population they
  saw before. Falsify: re-run the eval with and without the `route !== 'ungraded'` clause after a
  week of rows and compare `liveRouted`.

## Consequences

- A CLI-driven seat's non-risky lane gets a second pair of eyes again. The review is real; the
  diversity claim is absent rather than false, at every reading depth (ready row, ask, close row).
- Readers of `review_grade` see a fourth word. Anything that switched exhaustively on the three
  grades reads `ungraded` as "not one of them", which is the correct reading.
- The count of `ungraded` rows is itself a measure of the ADR 246 gap — how often the seats ask for
  review from a presence that attests nothing. It is printed in the eval mix so it cannot vanish.
- The question this ADR does not answer: whether the ask text should tell the reviewer *why* the
  pairing is ungraded. The grade word is there; the sentence is not. Left for the surface if it
  turns out reviewers read the word as a defect.

## Related

- Lane `01M1G2DFKDK9SMR67AZHVGAY3H`. The attribution fix: #1160 (lane `01M1FJYETP6809EW45WY0S71V8`).
  The residue measurement: #1170.
