# 404 — empty-pool kinds, and busy is a preference

- Status: accepted
- Date: 2026-09-16
- Relates to: ADR 192 (outcome acceptance), ADR 235 (self-close only when nobody was asked),
  ADR 253 (agents-only live pick), ADR 260 (quiet-set increment 1; increment 2 remains parked),
  ADR 303 (selection snapshot)
- Lane: `01M2KXV40B0BS38E95264F5FR8`

## Context

`lane_submit` that asked nobody returned one sentence: *"no eligible acceptor is live"*. That
sentence named two different rooms. An empty room (the worker is the only live Member) is one. A
room full of live seats the picker refused — busy under ADR 260's 120s quiescence, `same_model`,
`not_agent`, `unknown_grade` — is the other.

On revive, the second room was the common one. Submit snapshots showed miley / stanley / izzo
`busy`, nick `not_agent`, and the worker `self`. The copy still said nobody was live. Workers then
self-closed under ADR 235's sanction, because "nobody was asked" was true — the picker had dropped
every busy peer before composing an ask.

ADR 260 increment 1 made busy a hard miss so a quiet seat would be asked instead of an interrupted
one. Increment 2 (fan the ask out to the quiet set) is parked. Increment 1 without increment 2
meant a busy-only team produced `no_candidate`, and ADR 235 then sanctioned self-close. Asked seats
came back 20 of 20 times; a busy inbox with a standing ask is the wait that worked. A busy-as-miss
that never asks is the wait that never starts.

## Problem

The wire collapsed "empty room" and "live but ineligible" into one client sentence, and busy-as-miss
turned the second case into a sanctioned unconfirmed close. Neither is what the team asked for: name
the two rooms, and prefer waiting (within reason) for a busy live peer over closing the lane
unconfirmed.

## Decision

1. **`LaneResult.review.empty_pool` and `NextBrief.review_debt[].empty_pool`.** Additive, optional.
   Derived from the ADR 303 snapshot already on the `lane.ready_for_review` row — no new audit
   field. Kinds:
   - `no_live_member` — every other seat is `self`, `service_or_observer`, or `no_live_presence`.
   - `live_ineligible` — at least one live peer was refused (`busy`, `not_agent`, `same_model`,
     `unknown_grade`, `worker_unattested`). `live` names those seats.
   Absent on older daemons. Clients keep *"no eligible acceptor is live"* when the field is missing
   (`emptyPoolHint`).

2. **Busy is a preference, not a hard miss.** The live peer picker still prefers a quiet gradeable
   agent (ADR 260, 120s). If the only live gradeable peers are busy, it asks one of them. Quiet still
   beats busy when both exist. `same_model`, `unknown_grade`, and `not_agent` stay hard misses.
   Self-close remains the ADR 235 sanction when the picker still returns nobody (empty room,
   same-model monoculture, humans-only, ungradeable). After this change a busy-only team gets an
   ask, so that path is no longer a sanctioned self-close.

3. **This ADR does not ship quiet-set increment 2.** `ask` still cannot carry `meta.eligible`. The
   busy fallback asks one seat. Fan-out stays parked (ADR 260 / ADR 401).

### Rejected

- **Keep busy as a hard miss and only fix the copy.** Honest copy on a path that never asks still
  sanctions self-close against a room that will answer.
- **Ship increment 2 here.** Parked; a different lane, a different measurement.
- **A new audit verb for empty-pool.** The snapshot already has the exclusions. Re-deriving is
  cheaper than a second recorded fact that can drift.

## Consequences

- Historical `no_candidate` rows whose snapshot listed `busy` classify as `live_ineligible` on
  standing submit and on `review_debt`. New submits of a busy-only team route instead.
- MCP / CLI submit copy uses `emptyPoolHint`: empty room → *"no other member is live"*; live
  ineligible → *"live seats were ineligible (busy: …; not_agent: …)"*; missing field → the
  historical sentence.
- The ADR 260 eval's `busy` exclusion remains on the snapshot when a quiet peer won. A promoted
  busy winner is recorded eligible, not left marked `busy`.

## Observability & Evaluation

**Traces.** `LaneResult.review.empty_pool` on a no-ask submit (fresh and standing).
`review_debt[].empty_pool` on `GET /next`. The ready-row snapshot is unchanged as the source; the
picker still writes `exclusion: 'busy'` on quiet-preferred losers.

**Eval.** `packages/protocol/src/lanes.empty-pool.test.ts` (from-candidates + copy + hint).
`packages/server/src/store/review.test.ts`: only-busy live agents pick the busy cross-family seat;
a mixed quiet/busy pool still prefers quiet. MCP `resultAudit.test.ts` and CLI solo-team submit
assert the empty-room sentence. Baseline: the previous suite asserted *"no eligible acceptor is
live"* for every no-ask submit, including an empty room.

**Experiment.** After land, `no_candidate` on teams whose live peers were only-busy should drop
toward zero. Remaining `no_candidate` rows should be `no_live_member` or `live_ineligible` without
`busy` (same-model / not-agent / unknown-grade). Increment 2 remains the unrun experiment ADR 260
named.
