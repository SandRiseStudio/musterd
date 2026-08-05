# 233 — The orientation brief names the reviews you owe

Status: **Accepted**

## Context

When a lane enters outcome acceptance (ADR 192), the daemon picks a counterpart (ADR 169 §4) and
sends them a standard-tier `approve` ask. That ask lands once, in an inbox. Nothing ever re-surfaces
it.

Measured over the dogfood ledger. Taking every `lane.closed` row carrying `time_in_review_ms`,
joining it to the `lane_review` ask that named a reviewer, and splitting the unverified self-closes
(`closed_by = owner_at_close`) by whether that named reviewer was ever active during the review
window:

| bucket                         | n   | wall-clock wait | reviewer's own awake time |
| ------------------------------ | --- | --------------- | ------------------------- |
| A — reviewer never online      | 16  | 8.4 minutes     | 0.00h                     |
| B — reviewer **was** online    | 16  | 17.93h          | 0.67h                     |
| _(contrast)_ reviewer answered | 27  | —               | 0.22h                     |

"Awake" counts 5-minute buckets in which a real seat either emitted a deliberate audit action or
sent a message — excluding `web-*` observer seats (a browser tab left open on `/live` contributes
818 `claim.occupied` rows), the 1345 daemon rows with an empty actor, and claim/attestation boot
noise.

**Bucket B is this ADR's subject.** Those reviewers were demonstrably at the keyboard for ~40
minutes spread across an 18-hour window and still never answered — _more_ awake time than the
reviewers who successfully answered (0.67h vs 0.22h). Having time was not the problem. Being
reminded was.

The mechanism is plain once stated: the ask arrives while the seat is mid-lane. It scrolls out of
the inbox. `NextBriefSchema` — the projection a working seat actually reads at every task boundary —
carried `in_flight`, `shipped`, `up_next`, `why` and `next_goal`, and had no field for a review
someone is waiting on. So the obligation existed only in a message the seat had already scrolled
past.

Bucket A is a different failure with a different fix (the owner self-closed after 8.4 minutes,
honouring `promised_wait_ms = 300000` before any reviewer could plausibly respond) and is out of
scope here.

## Decision

`NextBrief` gains **`owed_reviews`**: lanes still in the acceptance stage whose review ask was routed
to this seat, oldest ask first, each carrying the lane, who is waiting, the ask id to answer, and
when it was asked.

Derived in `deriveNext` alongside every other field, so CLI and MCP render one projection and the
derivation is never duplicated per surface (ADR 084).

**"Still in the acceptance stage" is the entire unanswered test.** An accept closes the lane it
accepts (ADR 192, as repaired), so a lane that is still awaiting acceptance is by construction one
nobody has answered. There is no accept-message bookkeeping that could drift out of sync with the
lane, and a review answered by any route at all — MCP, CLI, a third party — disappears from here for
free.

Three exclusions, each deliberate:

- **Lanes you own.** The ask can legitimately name you on a small team, but reviewing your own work
  is precisely what the counterpart exists to prevent. Surfacing it would not be a reminder, it
  would be a wrong instruction.
- **Terminal and missing lanes.** Nothing to answer.
- **Asks routed to someone else.** This is what _you_ owe, not a team backlog.

Rendered **first**, above `carrying`, on both surfaces. This is the one item in the brief that
another seat is blocked on, and it is the one that demonstrably loses when a seat is busy. Printing
it under your own work would reproduce the failure it exists to fix.

### Why not re-routing

The obvious alternative — notice the reviewer is unavailable and re-assign — is aimed at a failure
that does not exist. In bucket B the reviewer was already present; in bucket A nobody was given
time. Neither is fixed by choosing a different name.

## Consequences

- `owed_reviews` is additive on `NextBrief` and schema-defaulted to `[]`, so a newer client parsing
  an older daemon's brief gets an empty list rather than an error — the ADR 148 skew posture,
  matching `risk` and `merged` on `LaneSchema`.
- **`client.next()` casts its response instead of parsing it through `NextBriefSchema`**, so the
  schema default does not run on that path and an older daemon's brief genuinely lacks the key. Both
  renderers therefore read `brief.owed_reviews ?? []`. The MCP result-audit fixture is left without
  the field on purpose: it is the older-daemon shape, and keeping it stale keeps that contract under
  test.
- A seat that owes a review now sees it at every task boundary until it answers, which is the
  intended pressure. If a seat wants it gone, the way is to give a verdict.
- No new query cost worth naming: one indexed read over `messages` joined against lanes already
  loaded for the rest of the brief.

## Observability & Evaluation

**Traces.** No new audit rows. The obligation is _derived_ from state that is already recorded — the
lane's state and the review ask — so there is nothing here to log that would not be a second copy of
a fact the ledger already holds. The acts that resolve an owed review (`lane.closed` with its
`verified`, `reason`, and `time_in_review_ms`) are the existing trace, and they are what the eval
below reads.

**Eval.** Dataset: the same 59 `lane.closed` rows that join to a `lane_review` ask, decomposed by
reviewer-awake time as in the table above. Baseline: **bucket B = 16 of 32 unverified self-closes
(50%)**, and overall 30 of 96 closes verified (31.3%). The decision works if bucket B shrinks — a
reviewer who was online during the window, and now sees the obligation in every brief, should either
answer or explicitly decline. Re-run the decomposition after 20 further closes; success is bucket B
falling below 25% of unverified self-closes.

**Experiment.** None pre-registered. A holdout would mean showing some seats their obligations and
hiding others', which is a coordination layer deliberately withholding work from a teammate — the
cost of a bad arm is a real unreviewed lane. The before/after on bucket B is the measurement, and
because bucket A is unaffected by this change it acts as a built-in control: if both buckets move,
something other than this ADR moved them.

**Counter-signal.** If bucket B holds steady while seats report seeing the line, the constraint is
not visibility but willingness, and the answer is a policy question about review as an obligation —
not more surfacing. If `owed_reviews` routinely lists more than a couple of lanes per seat, the
counterpart picker is over-concentrating and that is a separate defect worth its own lane.
