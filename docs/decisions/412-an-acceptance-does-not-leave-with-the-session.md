# 412 — An acceptance does not leave with the session holding it

- Status: proposed — 2026-09-17
- Date: 2026-09-17
- Relates to: [ADR 202](202-the-verdict-moves-the-lane.md) (the verdict IS the move),
  [ADR 303](303-auditable-review-selection.md) (selection is audited at decision time),
  [ADR 101](101-model-as-a-variable.md) / [ADR 187](187-durable-model-attestation.md) (the picker reads the
  live occupancy, never a durable memory), [ADR 131](131-harness-residency-wake-ledger-host.md) (`/residency/session`)
- Lane: `01M2RNBRGRWCSD89JTE1BVQ3QG`
- Supersedes nothing; the hand re-route (`lane.review_rerouted`, lane 01M1QYHJFY) is reused as-is.

## Context

An acceptance ask is directed: one seat holds it, and under ADR 202 that seat's `accept` or
`decline` IS the verdict. Nothing until now reacted to that seat going away.

Measured on the live daemon, 2026-09-17:

- big-body raised `lane_review` ask `01M2P7V5Y9JQHXXJ2Q2D4QJ41V` to delta at 2026-09-16 16:11:47.
- delta's session ended at **16:14:11** — two minutes and twenty-four seconds later
  (`residency.session_ended`), `presence.detached` at 16:15:04.
- The ask sat unanswered for **22 hours**, until a seat read `team_next` and answered it by hand.

This is not a bad-reviewer problem, and the numbers say so: delta had answered **6 of the 7**
`lane_review` asks ever routed to it. The failure is the race between routing and departure.

The only recovery today is `staleAcceptanceWarning`, which fires at `ACCEPTANCE_STALE_MS` (12h) and
emits "any seat may answer per the acceptance ask". That is an advisory downgrade of a directed ask
to an unowned one — it waits to be read, and it throws away the routing decision rather than
remaking it.

## Problem

React to a reviewer's departure without re-deciding what a re-route means, without letting two
seats believe they hold one acceptance, and without a seat that is merely between heartbeats losing
work it is still doing.

## Decision

**A seat that says goodbye hands back every acceptance it still holds.** On
`POST /residency/session {event: 'end'}`, each open acceptance ask held by that seat is re-routed:
the standing ask is superseded, the holder is told where the acceptance went, and a fresh ask is
minted to a newly picked reviewer.

Four things this deliberately does NOT change:

1. **The re-route machinery is reused, not reinvented.** `lane.review_rerouted` already supersedes
   the old ask, keeps a late verdict on it from moving the lane, and sends the previous holder a
   courtesy `resolve`. The hard part was decided in lane 01M1QYHJFY; only the *trigger* is new, so
   the audit row records `route: 'departed'` and the departing seat as `actor`.
2. **No wake is leased**, matching the named path. The ask waits in an inbox, as it does at submit.
3. **`/residency/session` stays presence-neutral.** This moves asks and audit rows; it moves no
   presence row. The route's existing property is untouched.
4. **If the picker finds nobody, nothing is minted** and the lane keeps the ask it has. A re-route
   with no destination would strand the acceptance worse than leaving it to the 12h warning.

### The departing seat cannot be handed its own ask back

A seat reporting its own session end is **still attached** at that instant — the route is
presence-neutral by design, so `no_live_presence` will not exclude it for some minutes yet. Without
saying so, the picker hands the ask straight back to the seat that is leaving. So
`selectReviewCounterpart` takes an optional `departing` seat and files it under its own exclusion
reason rather than reusing `no_live_presence`, which would be a false statement about a seat that
is demonstrably still connected.

### Two predicates, because the two callers have different signals

`heldAcceptances(db, team, seat)` answers "what does this seat still owe a verdict on", and says
nothing about whether the seat is there. The goodbye path supplies its own departure signal — an
explicit statement from the seat — so it uses this one.

`abandonedAcceptances(db, team, seat, presenceTimeoutMs)` narrows that to a seat with no live
Presence, for a seat that went away **without** a goodbye: reaped, crashed, or a cloud seat whose
host vanished. Keeping the liveness test out of the first predicate is what stops a seat that is
merely between heartbeats from being re-routed by the goodbye path.

Both read `openAcceptanceAsk`, the vetted "still owed" predicate, so neither can re-route an
acceptance that has already been answered, resolved, or superseded.

## Consequences

- A clean departure costs the acceptance minutes, not the 12h stale window plus whenever a human
  next reads the board.
- `staleAcceptanceWarning` remains, and remains necessary: it is the net for the departure this
  decision cannot hear — a seat that never says goodbye.
- The wired half is the goodbye only. `abandonedAcceptances` has no caller yet; the sweep that would
  use it is the obvious next increment and is deliberately not in this one, because the trigger for
  a *silent* departure (how long is gone, and who decides) is a separate question from honouring an
  explicit one.
- One more `ReviewSelectionExclusion` value appears in ADR 303 snapshots. Readers that enumerate the
  vocabulary must accept `departing`.

## Observability & Evaluation

**Traces.** Every automatic re-route is one `lane.review_rerouted` row carrying `route: 'departed'`,
`from_reviewer` (the departing seat), `superseded_ask`, and the new `reviewer` — the same shape the
hand re-route writes, so existing readers need no change to see it. The ADR 303 selection snapshot
shows the departing seat excluded as `departing`.

**Eval.** Six tests, each mutation-controlled (neutralise the production line; exactly the claimed
test goes red, the rest stay green):

- `heldAcceptances` names a held ask regardless of liveness; `abandonedAcceptances` names it only
  when the seat is not live; neither names an ask that has been answered.
- `selectReviewCounterpart` never re-picks a seat named `departing`, and files it under that reason.
- End to end over HTTP: a seat holding an acceptance posts `{event: 'end'}` and the audit shows the
  lane re-routed away from it, naming the superseded ask.

**Experiment.** The falsifier is the live case this was measured from: route an acceptance to a seat
and end that seat's session within the minute. Before this decision the ask waits 12h for an
advisory warning; after it, a `lane.review_rerouted` row naming a different reviewer exists before
the session-end response returns. What it does NOT prove is the silent departure — a reaped seat
emits no `session_ended`, and that path has no caller yet by choice.
