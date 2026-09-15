# 283 — The close reason reaches the reader

- Status: accepted
- Date: 2026-08-19
- Deciders: izzo (measured it, built it), nick (chose the payload), dolly (filed the lane)
- Relates to: ADR 169 (the `verified` annotation this copies), ADR 192 (accepted / unconfirmed
  copy), ADR 084 (one derivation, never one per surface), ADR 217 (the wait-verdict split), ADR 229
  (the sweep's own reason), ADR 234 (acceptance exemption), ADR 172 (human-review requirement),
  ADR 173 (abstention), ADR 277 (`ask_outcome` on the swept audit row)

## Context

ADR 169 taught the board projection to say whether a `done` lane's close was a counterpart
_acceptance_, deriving `verified` from the `lane.closed` audit row and annotating it onto the wire
without ever storing it. ADR 192 gave the two states their reader-facing copy: **accepted** and
**unconfirmed**.

It never taught the projection to say why an unconfirmed one was unconfirmed.

The ledger has known the answer the whole time. `recordLaneClose` derives a close `reason` through a
ladder with an ADR behind each rung — `acceptance_exempt`, `no_candidate`, `human_review_missed`,
ADR 217's `review_timeout` / `review_cut_short` / `review_unanswered` split, ADR 229's
`review_swept`, plus `counterpart_confirm`, `self_close` and `abandoned`. It writes that reason on
every close. Nothing reads it back out.

## Problem

**`unconfirmed` is two opposite situations wearing one word, and the right response to each is the
response the other one wastes.**

- _asked, and nobody answered_ — go find the person who was asked.
- _nobody was asked_ — no eligible counterpart existed. Nobody is at fault, nobody is worth
  chasing, and the thing to look at is the roster.

Both print `unconfirmed`. A seat reading its brief cannot tell them apart, and the two next moves
have nothing in common.

Measured 2026-08-19 over all 344 `lane.closed` rows in the live ledger, both halves are populous:

| nobody was asked                         | asked, and went silent                                            |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `no_candidate` 40, `acceptance_exempt` 9 | `review_timeout` 23, `review_unanswered` 16, `review_cut_short` 2 |

(plus `counterpart_confirm` 142, `self_close` 90, `review_swept` 17, `abandoned` 1.)

Forty-nine closes where chasing a person is the wrong move, forty-one where it is the right one, and
one word covering all ninety.

## The rejected shape, and why

The lane was filed as _put `ask_outcome` on the wire_. That is the wrong payload, for three reasons
measured before any code was written:

1. **`ask_outcome` covers 4 of 344 closes.** It is written only on the swept path —
   `laneClose.ts`, `systemClosed && askOutcome !== undefined` — and its own comment says why:
   _"Everywhere else `reason` already answers it."_ Three days after ADR 277 landed, the ledger held
   four rows carrying it. ADR 277's own 30-day Eval will produce perhaps forty. Building a display
   on that population is shipping a feature nothing can falsify, which the lane itself warned
   against.
2. **`reason` covers all 344 and already draws the exact line.** The distinction this ADR exists to
   surface is fully present in a field written on every close since ADR 217.
3. **`ask_outcome` is already a protocol wire name with a different vocabulary** — envelope
   `meta.ask_outcome` is `held | risk_accepted | stranded` (ADR 147). Putting the lane-close
   vocabulary on `LaneSchema` under that name gives one wire name two meanings, in a protocol other
   implementations depend on.

So `ask_outcome` stays exactly where ADR 277 put it: on the audit row, on the swept path, pending
its own Eval. It answers a narrower question — _was an ask ever sent on a lane the clock closed_ —
and this ADR does not disturb it.

## Decision

**`close_reason` joins `LaneSchema` as a board-projection annotation, derived from the same
`lane.closed` audit row `verified` is derived from, never stored.**

1. `CloseReasonSchema` enumerates the ten reasons the ladder writes. A value outside it is **dropped
   by the projection**, not passed through — a newer daemon's vocabulary reaches an older reader as
   "unknown" rather than as a string nothing can render.
2. `verifiedCloses` becomes `closeVerdicts`, returning both halves from the one indexed query the
   board read already paid for. **The two halves abstain independently.** A close from before
   ADR 169 recorded no verified-ness; a close from before ADR 217 named its reason a way this
   vocabulary does not cover. Deriving either from the other would manufacture a claim the ledger
   never made — and a word with nothing behind it is the whole defect this ADR is repairing.
3. Both readers annotate through one helper, `annotateClose`, used by `/lanes` and by `deriveNext`'s
   `shipped`. This is not tidiness: those two surfaces **already drifted apart once** on `verified`,
   and the web board rendered accepted/unconfirmed chips for two ADRs while the brief a seat reads
   said only `✓`.
4. The reader-facing copy lives in `@musterd/protocol` as `closeReasonCopy`, once, for the ADR 084
   reason. Each phrase is written to imply its own next move — "nobody was asked — no eligible
   counterpart" against "asked, and the wait ran out". If a reader cannot act differently on the two
   halves, the wire field has not earned its place.
5. `counterpart_confirm` and `abandoned` render **nothing**. The first is what `accepted` already
   says and the second is already the whole story; repeating them would make the annotation noise on
   the majority of lanes and train readers to skip it on the minority where it carries the news.

## Consequences

A seat reading `team_next` now sees `✓ "the lane" — unconfirmed (nobody was asked — no eligible
counterpart)` where it previously saw `✓ "the lane" — unconfirmed`, and the two unconfirmed shapes
are legible at a glance on the CLI, the MCP brief, and the board.

Absent stays absent everywhere. A close that recorded no reason renders exactly as it did before
this ADR — no parenthetical, no guess.

**What this does not fix.** The reason says what happened to the _close_. It does not say whether
the acceptance ask was ever _read_, which is the finding `docs/wiki/acceptance-routing.md` records:
the binding constraint on this team is attention, not candidate supply, and one seat received 38
acceptance asks that the obligation rail could never reach. `no_candidate` and `review_timeout` are
both downstream of that, and surfacing them makes the shape of the problem legible without making it
smaller.

**Falsifier.** A seat reading its brief can distinguish a lane nobody was asked to review from one
whose reviewer went silent, without writing SQL. Falsify by planting the two close rows and reading
the brief: `packages/server/src/store/closeReason.test.ts` and
`packages/mcp/src/tools/next.render.test.ts`.

## Observability & Evaluation

**Traces.** No new emission. The annotation is derived at read time from `lane.closed` rows the
audit log already carries, and `closeVerdicts` reuses the single indexed query the board read
already paid for — this ADR adds no row and no query.

**Eval.** _Dataset:_ the `lane.closed` audit rows, which is the same population this ADR was
measured against. _Baseline, 2026-08-19, n=344:_ 90 unconfirmed closes split 49 "nobody was asked"
(`no_candidate` 40, `acceptance_exempt` 9) against 41 "asked and went silent" (`review_timeout` 23,
`review_unanswered` 16, `review_cut_short` 2). _Pre-registered prediction:_ over the 30 days from
this ADR, the follow-up chase — a `team_send` naming a lane whose close reason was `no_candidate` or
`acceptance_exempt` — falls, because a reader who is told nobody was asked has no one to chase. If
it does not fall, this field is being rendered and ignored, and the honest conclusion is that the
annotation was not the binding constraint.

**A caveat that outranks the prediction, and is stated here rather than discovered later.** This
team cannot currently produce a clean before/after over a multi-day window on acceptance routing:
`docs/wiki/acceptance-routing.md` measures 4 `policy.change` rows and 11 commits to
`review.ts` / `orientation.ts` / `envelope.ts` in a single week, and this ADR adds one more commit to
that same file set. So the number above is a **descriptive** baseline, and anyone quoting a
before/after against it owes the window's contamination check first —
`scripts/check-routing-freeze.ts` exists for exactly this and is parked on `izzo/routing-freeze`.

**Experiment.** None. The rendering is not A/B-able across a six-seat team without splitting the
brief by seat, which would cost more coordination honesty than the measurement is worth.
