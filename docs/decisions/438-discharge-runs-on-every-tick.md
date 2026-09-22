# 438 — A guardian's discharge runs on every tick, not only when something is firing

**Date:** 2026-09-21
**Status:** Accepted
**Lane:** 01M336A4XK3G1NHYTYWG00C95B

## Context

[ADR 432](432-an-incident-ask-is-discharged-by-its-condition-clearing.md) gave guardian a
condition-based discharge. Guardian is a `service` seat and ADR 232 bars it from the peer verbs, so
it can raise an obligation and can never accept one — not even its own. 432's insight was that the
classifier already holds the answer: a class **absent** from a tick is a class this guardian has
just observed healthy, and that observation is the discharge. It added `clearRaise`, a
`guardian.cleared` ledger row, and a `resolve` on the ask's own thread.

The mechanism is correct. It was placed at the end of `actOn`.

`guardianTick` calls `actOn` like this:

```ts
if (incidents.length === 0) {
  const build = await d.healthBuild().catch(() => null);
  if (build) stamp = { ...stamp, lastGoodBuild: build };
} else {
  d.log(`incidents: …`);
  stamp = (await d.act(incidents, stamp, tiers)).stamp;
}
```

## Problem

**The discharge could only run on a tick where something was still firing.** `actOn` is reached
only on the `else` branch, so on a fully healthy tick — the tick that *is* the observation 432
defined — nothing called it.

The direction of the failure is the bad one. A guardian whose classes have all gone quiet is a
guardian in its normal steady state, and that guardian could never discharge anything. Every ask it
had ever raised stayed owed, and the backlog only ever drained when something *else* broke. The
cleaner the machine, the longer the queue. ADR 432 existed to kill exactly this accumulation (55
stale asks on the hub, 30 from August) and would have gone on feeding it.

**Observed, 2026-09-21.** [ADR 435](435-publisher-failure-is-read-from-the-last-build-outcome.md)
gave `publisher_failed` a working recovered edge. Its signal fell and stayed fallen — no
`incidents: publisher_failed` line after 14:58, with guardian demonstrably still ticking
(`lastTickAt` 16:52:48). The raise did not close. `stamp.lastRaise.publisher_failed` still held act
`01M32X1ABMERVXADTJ1V260KTD`, and no `guardian.cleared` row for the class existed.

The whole log carried exactly **two** `guardian.cleared` rows, both at 14:11:00, on a tick whose
first line was `incidents: publisher_failed`:

```
14:11:00 incidents: publisher_failed
14:11:00 guardian.remediated {"class":"publisher_failed",…}
14:11:00 guardian.cleared {"class":"daemon_down","raised_at":1789420102267,…}
14:11:00 guardian.cleared {"class":"daemon_wedged","raised_at":1789420982780,…}
```

Those raises dated from 2026-09-14 14:08 and 14:23 — open for a week. They did not clear when the
daemon recovered; they cleared seven days later as a side effect of an unrelated class firing
beside them. The discharge worked, and could only be reached by accident.

**Why the tests did not catch it.** `clear.test.ts` drove the clearing path by calling
`actOn([], d)` — an empty incident list, which is a call shape `guardianTick` can never produce.
Eight tests passed against the bug because they exercised a function nothing reached. That is the
same shape as the `publisher.ok` fixture in ADR 435: a test proving the mechanism and blind to the
wiring.

## Decision

Lift the clearing loop out of `actOn` into its own exported `dischargeCleared(firing, deps)`, and
call it from `guardianTick` on **every** tick, outside the incident branch.

Discharge is a property of the tick's observation, not of acting on an incident, so it belongs
where the observation is — beside the branch rather than inside one arm of it. `DischargeDeps` is a
narrow subset of `ActDeps`: a stamp, `audit`, `log` and the optional `sendResolve`. Notably it has
no `sendAsk`, so "a recovery must not bill anyone's attention the way the incident did" is now
structural rather than a rule to remember.

Three constraints fixed at the call site:

- **After `act`, deliberately.** A class this tick raised is in `firing`, so the tick that makes a
  raise cannot also discharge it.
- **`classified`, not `incidents`.** A deferred sighting (ADR 274's unconfirmed outage) is filtered
  out of `incidents` and is *not* evidence of health; discharging on it would close a raise on an
  observation the classifier itself declined to trust.
- **Skipped entirely under a handover**, where `classified` is empty because the daemon is
  restarting on purpose. That emptiness means "we know nothing this tick", and ADR 173 applies to a
  guardian reading its own signals too: absent is unknown, never healthy.

A throwing discharge is caught and logged; raises stay open and the next tick retries. A guardian
that fails its tick while recovering is worse than one that is quiet about a recovery.

## Consequences

- An incident ask now closes on the first healthy tick after its condition clears — within ~2
  minutes, rather than whenever something else next breaks. The 432 arc does what it was written to
  do.
- `actOn` is now only about acting on incidents, which is what its name says. The two behaviours no
  longer share a function because one of them happened to have the stamp in scope.
- `sendResolve` and the audit closure are hoisted and shared by both call sites, so the raise path
  and the discharge path cannot drift into sending different things.
- **The safety direction is unchanged and still tested.** Only a class absent from `firing` clears;
  a persisting condition is re-classified every tick and so is never absent. Silently clearing a
  raise while the condition persists would be strictly worse than the stale asks — that is the one
  real outage going quiet — and it remains the test that matters most in `clear.test.ts`.
- The existing 432 tests move to `dischargeCleared` and no longer call `actOn` with an empty list,
  a shape production cannot produce.

## Observability & Evaluation

**Traces.** `~/.musterd/guardian/guardian.log`. A `guardian.cleared` row naming the class, the raise
it closes and the suppressed count should appear within one tick of a condition clearing, on a tick
with **no** `incidents:` line above it. If every `guardian.cleared` in a week of log still sits
beneath an `incidents:` line, this decision did not take.

**Eval.** n/a — mechanical. The change is which ticks reach an existing, already-tested function.

**Experiment.** Run, as a falsifiable regression rather than a claim: the new tick-level tests were
executed against the old wiring (`incidents.length > 0` restored on the discharge call) and 2 of
them fail; against the fix, 33 pass. The unit tests of `dischargeCleared` pass under both, which is
precisely why the tick-level assertion is the one that had to be written.
