# 236 — A sleeping host defers; only a host-reported failure burns the wake budget

- Status: accepted
- Date: 2026-08-05
- Deciders: ryder, stanley (ruling)
- Relates to: ADR 131 (harness residency — §4 rate policy, §5 the local-session guard), ADR 221 (a
  host that cannot actuate defers), ADR 225 (one predicate, two consumers), ADR 232 (ledger seats),
  ADR 235 (the acceptance self-close advice)

## Context

On the evening of 2026-08-04 nick closed his laptop for about fifteen hours. The machine was not
off: it slept and woke in 19 cycles, 13.7 hours asleep between 18:10 and 08:12. So the daemon came
up repeatedly, saw pending wakes, leased them, and — with nobody there to spawn into — watched every
one of those leases expire.

Between 18:10 and 08:12 the ledger records 11 `residency.wake_leased`, 13 `residency.wake_failed`
(every one `reason: "lease_expired"`), and **5 `residency.wake_exhausted` — acts terminally
retired**, three attempts each, while the host was asleep.

The complete chain for one of them, izzo's ADR 230 review:

| when     | what                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 19:01:31 | wake leased for ask `01KZ7N6RQY…` on lane `01KZ7JVWX2…` — expired          |
| 20:25:03 | leased again — expired                                                     |
| 21:39:41 | leased again — expired                                                     |
| 23:00:18 | `residency.wake_exhausted {attempts: 3}` — the act is retired, permanently |
| 14:30ish | the lane closes `review_unanswered`                                        |

The act died at 23:00, **nine hours before any seat could have answered it**, and the lane then
closed with a reason that reads as "a reviewer was asked and declined". Nobody was ever asked.

The mechanism is deliberate, which is what makes it interesting. `reaper.ts` writes `wake_failed` on
expiry _"so the attempt still consumes rate budget — a host that dies mid-spawn can never retry
forever."_ That reasoning is exactly right for a crashed host and exactly wrong for a sleeping one.
It is the ADR 225 shape again: **one predicate serving two consumers with opposite needs.** The
lease expired, and that single fact has to rate-limit a crash-looping host (which must consume
budget, or it retries forever) and pace an absent one (which must not, or the act dies unanswered).
A predicate cannot serve both, so it silently served the first and charged the second.

## Decision

**An expiry is classified before it is charged: a host that was up and did not report burns attempt
budget; a host that was not there defers.** The deferral is `residency.wake_deferred` with
`reason: 'host_unreachable'` — ADR 221's verb, reused rather than restated, because it is already
budget-neutral by construction (neither `wake_deferred` nor anything but `woke`/`wake_failed` enters
the rate and attempt derivations) and already covered by its own test.

**The discriminator is the reaper's own cadence.** `REAPER_INTERVAL_MS` is 15 seconds, so the delay
between a lease's `expires_at` and the audit row written for it is normally sub-20s. Across every
`lease_expired` in the live ledger:

| observed delay                                  | reading                    |
| ----------------------------------------------- | -------------------------- |
| 0.2, 0.3, 0.3, 0.2 min (all daytime)            | reaper on schedule — alive |
| 2.3 min                                         | ambiguous, 9× the interval |
| 12.6 – 15.8 min, eleven of them (all overnight) | the loop did not run       |

A 15-second loop that does not fire for a quarter of an hour was not late; it was suspended. So the
question the daemon asks is not "is the host reachable" — it cannot know that — but **"did my own
loop run while this lease was outstanding"**, which it can always answer about itself. The reaper
tracks the start of its current unbroken run; a lease created before that run began was outstanding
while nothing was running, and no host could have been asked. `HOST_SUSPEND_GAP_MS` is 90 seconds,
six times the interval: far above scheduler jitter or a long GC pause, far below the observed
suspension cluster. A gap past it writes `residency.host_suspended {gap_ms, from, to}` — the
machine's absence becomes a ledger fact instead of an archaeology exercise.

**Deferral stops the clock; it does not extend the budget.** Attempts are consumed only by
host-reported failures. The bound is a **ceiling in host-awake time** — wall-clock since the act was
first leased, minus every recorded suspension — because wall-clock here measures a time nobody is
in. Past `WAKE_UNREACHABLE_CEILING_MS` (6 hours of the host actually being up), expiries burn budget
again and the existing exhaustion path terminates the act as before. Termination stays provable:
awake time only grows while the daemon runs, so a host that stays up reaches the ceiling, spends its
attempts, and exhausts.

**Pre-registered, so this cannot quietly become "wakes never expire":** a host that never accumulates
6 hours of uptime never retires its acts _at the wake rail_. That is the intended trade and it is
not silent — the act stays due, visible in the inbox and on the board, and the lane-level close
paths (ADR 229's sweep, ADR 235's self-close advice) are unaffected. If deferrals accumulate for
days without a corresponding uptime, the fault is a host that is never up, and the remedy is the
ADR 221 `residency status` surface, not a shorter ceiling.

**Why not the obvious probe.** The autorefresh LaunchAgent ticks every ~2 minutes and its log gaps
show the sleep cycles beautifully. It was rejected: ADR 232 made autorefresh a **service seat**, so
reading its liveness would make a seat's health load-bearing for wake budget — and an autorefresh
that is merely _disabled_ would then read as "host asleep" and defer every wake forever. That is the
same false-negative shape this ADR removes, reintroduced one level up. The timer-skew probe has no
such hazard: an unloaded autorefresh does not stop the reaper.

**What this explains, and what it does not.** This chain accounts for **one** permanently-retired act
and the five exhaustions of that night. It does not explain the population of unanswered
acceptances — dolly's ADR 235 (20 of 20 acceptors returned) does that, from a different mechanism.
Inheriting her numbers here would be a true finding generalised one notch too far, which is the
failure this team catalogued all week and the more dangerous kind, because it survives being
checked.

## Consequences

- A closed laptop can no longer retire an act. The five overnight exhaustions of 2026-08-04 would
  have been five deferrals, and izzo's review would have been waiting when the machine woke.
- `wake_failed` now means an actuation a live daemon watched fail, so failure rate stops being
  diluted by hours of sleep. The ADR 209/210 delivery cohorts inherit that directly.
- `residency.host_suspended` gives the ledger a first-class record of when the machine was gone.
  Any later question about overnight behaviour is now a query rather than a reconstruction.
- The existing `WAKE_DEFER_SNOOZE_MS` applies to these deferrals too, so a host that has just woken
  waits five minutes before re-leasing — a small, deliberate settling delay after resume.
- A daemon restart looks like an absence, because it is one: leases outstanding across it defer.
  This is a behaviour change for crash-restart loops, which now defer rather than charge; the
  ceiling still terminates them.
- `review_unanswered` still absorbs closes whose ask was never delivered. Narrowing that reason is
  a separate change on lane surfaces another seat owns, and is deliberately not made here.

## Observability & Evaluation

**Traces.** One new action, `residency.host_suspended` (`{gap_ms, from, to}`, target `daemon`,
written per team with a residency enrollment). `residency.wake_deferred` gains a third `reason`
shape, `host_unreachable`, alongside `local-session-live` (ADR 131 §5) and the binary-not-found case
(ADR 221) — so the three stay separable without a schema change. The deferral carries `awake_ms`,
the ceiling's own input, so a decision can be re-derived from the row that made it.

**Eval.** The measurable claim is that host absence stops consuming attempt budget. Baseline, from
the ledger for 2026-08-04 18:10–08:12: **13 `wake_failed`, all `lease_expired`, and 5
`wake_exhausted` while the machine was asleep 13.7 of 14 hours.** Success on the next comparable
overnight is zero `wake_exhausted` rows whose attempts fall inside recorded `host_suspended`
intervals, with the failures appearing as `wake_deferred {reason: host_unreachable}` instead. The
reproduction query joins expiries to their leases:

```sql
select datetime(w.expires_at/1000,'unixepoch','localtime') due,
       round((a.ts-w.expires_at)/60000.0,1) delay_min, a.action
  from audit a join wake_leases w on w.id = json_extract(a.detail,'$.lease_id')
 where a.action in ('residency.wake_failed','residency.wake_deferred');
```

Failure to watch, in both directions: acts deferred across many days of _recorded uptime_ (the
ceiling is not being reached, meaning the awake accounting is wrong or a host is chronically broken),
and `host_suspended` rows appearing on a machine that was demonstrably up (the threshold is too tight
and real failures are being excused). The first is the quieter one, and is why the ceiling exists.

**Experiment.** None. Withholding this from an arm means knowingly retiring acts nobody could
answer; the discriminator is measured against the daemon's own recorded cadence, not estimated.
