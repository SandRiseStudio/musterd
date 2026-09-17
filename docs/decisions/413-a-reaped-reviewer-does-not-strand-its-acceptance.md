# 413 — A reaped reviewer does not strand its acceptance

- Status: proposed — 2026-09-17
- Date: 2026-09-17
- Builds on: [ADR 412](412-an-acceptance-does-not-leave-with-the-session.md) (the explicit goodbye)
- Relates to: [ADR 229](229-the-acceptance-backstop-sweep.md) (the 24h close), [ADR 202](202-the-verdict-moves-the-lane.md),
  [ADR 303](303-auditable-review-selection.md), [ADR 101](101-model-as-a-variable.md) (the picker
  reads the live occupancy)
- Lane: `01M2RQ8W0RR838P2KW3SP6SYGV`

## Context

ADR 412 re-routes an acceptance when its reviewer says goodbye — `POST /residency/session
{event:'end'}`. That covers the departure the daemon actually hears. It does not cover the one it
does not: a reaped seat emits `presence.detached` with reason `'reaped'` and **no**
`residency.session_ended` at all, so 412's trigger never fires for a seat that crashed, was killed,
or whose host vanished. A cloud seat is exactly that case whenever its host goes away rather than
its session ending cleanly.

Three facts, checked rather than assumed, decide what that costs:

1. **A sweep already exists and does not re-route.** `sweepAbandonedAcceptance` (ADR 229) **closes**
   the lane as `done` with the system as closer after `SWEEP_GRACE_MS` (24h), and `recordLaneClose`
   labels it `review_timeout`. Re-routing is not among its moves.
2. **It is opt-in per team**, gated on `getPolicy(...).loops?.sweep === true`.
3. **revive has not armed it** — its policy is `{"loops":{"dispatch":true}}`.

So on this team, an acceptance whose reviewer vanished silently waits **forever**: the 12h
`stale_acceptance` warning is advisory, and the 24h close never runs. On a team that *has* armed the
sweep, the outcome is worse than waiting — the lane is closed `done`, unreviewed, carrying its merge
attestation.

`abandonedAcceptances` shipped in ADR 412 with no caller, for exactly this. This decision is its
caller.

## Problem

Notice a departure nobody announced, without inventing a second definition of "gone", without
competing with the ADR 229 backstop, and without a seat that is merely between heartbeats losing an
acceptance it is still working on.

## Decision

**The reaper re-routes acceptances held by a seat with no live Presence**, using the same
implementation ADR 412 uses for the goodbye — `lane.review_rerouted`, old ask superseded and inert,
holder told, fresh ask minted — with the audit row recording `route: 'reaped'` instead of
`'departed'`.

### "Gone" is not redefined

Liveness is `hasLivePresence`, which is already the team's answer: it is the predicate
`selectReviewCounterpart` excludes candidates by. A seat this sweeps is a seat the picker would not
have picked. No new threshold is introduced, and there was no need to invent one — the alternative
(a fresh "how long is gone" constant) would have been a second, competing definition of the same
fact.

### Ungated, unlike ADR 229's sweep

ADR 229's gate guards a **destructive** act: closing a lane `done` with no verdict, which is why
"every team is bit-identical to pre-229 until an admin arms it" is the right posture there. This is
not that act. It never closes a lane and never invents a verdict; the worst it can do is move an ask
to a seat that is actually there — the same operation ADR 412 already performs ungated on the
goodbye path. Gating it would have left the silent case, which is the more common one for cloud
seats, broken on every team that never flips the flag.

It runs **before** the ADR 229 backstop in the tick, so on a team that has armed the sweep, a lane
is offered a live reviewer before it can be closed unreviewed.

### It terminates by construction, not by a counter

Once a lane is re-routed its open ask belongs to a live seat, so the next tick's
`abandonedAcceptances` no longer names it. A lane comes back only if its *new* reviewer also
vanishes — which is the case where trying again is the right answer. No re-route counter, no clock
reset, and therefore no way to defer ADR 229's backstop indefinitely on a team that wants it.

When the picker finds nobody, nothing is minted and the lane keeps the ask it has. The sweep then
re-examines it each tick and writes nothing until a candidate exists.

### One implementation, two triggers

The re-route moved to `protocol/laneReroute.ts`, along with the acceptance-ask composition and
delivery helpers it needs. They were in `transport/http.ts`, and the reaper cannot reach there:
`presence/` must not import `transport/`, and nothing in the tree does. The caller supplies both the
seat and the acceptances, so the two triggers differ only in how the departure became known —
`heldAcceptances` for a goodbye, `abandonedAcceptances` for a reaping.

## Consequences

- An acceptance orphaned by a crash is re-offered within a reaper tick instead of never.
- ADR 229's premise — "a lane past the grace has no actor left to close it" — is now false for the
  departed-reviewer subset, because there is another actor. 229 is not reopened here; a team that
  arms the sweep simply has fewer lanes reaching it. Whoever revisits 229 should know this.
- `staleAcceptanceWarning` remains, and remains the only net for the case this cannot see: a lane
  whose reviewer is live and simply not answering.
- A silently-departed seat that returns finds its acceptance gone and a `resolve` on the old ask
  saying where it went. That is the same experience ADR 412 gives a seat that said goodbye.

## Observability & Evaluation

**Traces.** One `lane.review_rerouted` row per swept lane, `route: 'reaped'`, carrying
`from_reviewer`, `superseded_ask` and the new `reviewer` — the same shape the hand re-route and ADR
412 write, so no reader needs changing. The reaper logs `reroute_reaped_acceptance` per lane.

**Eval.** Two tests on the real reaper tick with fake timers, both mutation-controlled (neutralise
the call; exactly these two go red, the other 60 in the pair of suites stay green):

- a lane whose holder's presence has gone stale is re-routed to the live attested seat, with
  `route: 'reaped'` and the stale holder as `from_reviewer`;
- twenty further ticks produce exactly one re-route, demonstrating the by-construction termination
  rather than asserting a counter.

ADR 412's six tests still pass unchanged against the extracted shared implementation, which is what
makes the refactor safe to claim as behaviour-preserving on the goodbye path.

**Experiment.** The falsifier: hold an acceptance on a seat, kill it without a goodbye, and watch a
reaper tick. Before this decision the ask waits forever on revive (sweep unarmed) or is closed
unreviewed at 24h on a team that armed it; after it, a `lane.review_rerouted` row naming a live
reviewer exists within a tick. What it does NOT prove is the live-but-silent reviewer — that seat
has a Presence, so this never touches it, and the 12h warning remains its only net.
