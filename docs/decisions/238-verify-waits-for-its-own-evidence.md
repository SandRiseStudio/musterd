# 238 — Verify waits for its own evidence: another session's presence is not this wake's outcome

- Status: accepted
- Date: 2026-08-05
- Deciders: ryder, stanley (found the failure), izzo (ruled out the code cause)
- Relates to: ADR 131 (harness residency — §2 the host loop, §5 the local-session guard), ADR 221 (a
  host that cannot actuate defers), ADR 236 (a sleeping host defers), ADR 225 (the shared-predicate
  trap), ADR 232 (the daemon bounce that made this visible)

## Context

Every gptbot wake from 09:57 on 2026-08-05 failed with `roster provenance session is not wake`.
Three acceptance wakes died — 09:57:56, 10:28:35, 11:00:01 — each burning attempt budget against a
seat that was healthy the entire time, and a queue of ten acceptance asks stalled behind them until
it was drained by hand at 11:25. Two earlier wakes that day, 08:55 and 09:27, had succeeded.

Two hypotheses were on the table, and **a live probe killed both**. Spawning the adapter exactly as
a wake does (`MUSTERD_PROVENANCE=wake codex exec … -C /Users/nick/agents-gptbot`) while polling the
presence table twice a second:

| t (from spawn) | rows for gptbot                                       |
| -------------- | ----------------------------------------------------- |
| −4s            | one row, `provenance=session` (another live session)  |
| +8s            | **two rows** — that one, plus a new `provenance=wake` |
| +45s           | the `session` row gone; the `wake` row alone          |

So `MUSTERD_PROVENANCE` **does** reach the adapter, and the row it writes **is** `wake` — the env
hypothesis is dead. And nothing overwrote it: the two rows coexisted, so the provenance-rewrite
hypothesis is not needed to explain the failure either. What the probe exposed instead is the
timing: the wake's own evidence takes about eight seconds to appear, and something else was already
answering in its place.

`verifyOccupied` returned on the **first fresh presence of any provenance**:

```ts
const fresh = me.presences.filter((p) => p.last_seen_at >= freshBar);
if (fresh.length > 0 && …) {
  const attesting = fresh.find((p) => p.provenance === 'wake') ?? fresh[0];
  return { occupied: true, provenance: attesting?.provenance ?? null };  // ← judged, at once
}
```

The freshness bar exists precisely to reject debris — its comment records the 2026-07-13 rehearsal
where a lingering row credited a dead child as woken. But that bar filters by **time**, and a row
belonging to another _live_ session is fresh by definition: its owner keeps touching it. So the one
kind of foreign row the bar cannot exclude is the one that is actually there, and verify judged the
wake roughly instantly — eight seconds before its own adapter claimed the seat.

This is ADR 225's shape once more. One predicate, "a fresh presence exists", answered two questions:
_is this seat occupied at all_ and _did my wake produce an occupancy_. It answered the first
correctly and the second wrongly, and only the second was being asked.

Two things follow that the ledger cannot show, and the ADR should not pretend otherwise. Presence
rows are deleted on detach, so the specific foreign row present at each of the three failures was
gone before anyone looked; what is established is the mechanism plus the fact that such a row was
present for gptbot again during the probe. And izzo's daemon bounce at 09:51 — which forced every
adapter to reconnect and ambient-touch, minutes before the first failure — remains the best
available explanation for _why the condition began_, but it is a correlate, not a proven cause.

## Decision

**Verify waits for the wake's own evidence, and treats another session's occupancy as a deferral.**

Two changes, in that order of importance:

1. **Poll on, rather than crediting a foreign row.** A `wake`-provenance presence returns
   immediately, as before. A fresh non-wake presence no longer ends the wait — it is _remembered_
   and the loop keeps polling until the window (90s) is spent. The wake's own row, which the probe
   timed at ~8s, is now comfortably inside that window, so the three failures of 2026-08-05 would
   have been three successful wakes rather than three better-classified ones. Restoring delivery is
   the point; reclassification alone would have converted a burned act into an undelivered one.

2. **At the deadline, an occupied seat defers.** If the window expires with only a foreign
   occupancy, the codex backend reports `deferred: true` instead of a failure. Nothing about the act
   went wrong and nothing about the host is broken — someone else is simply sitting in the seat —
   and ADR 221's verb is already budget-neutral by construction. A resume attempt that hits this
   returns the deferral instead of falling through to a fresh spawn: a seat another session holds
   will not be freed by spawning into it a second time.

**`!verified.occupied` still fails, and still burns.** An empty roster after a full window is a real
failure, and if it deferred, a host that spawns nothing would retry forever. That guard has its own
test, because the tempting simplification is to route every non-`wake` outcome to the deferral.

**Provenance semantics are untouched.** The newest-wins rule for `x-musterd-provenance` (owner call,
2026-07-14) stands exactly as written, and the test that encodes it is unchanged. Making birth
provenance sticky was the obvious fix while the overwrite hypothesis was alive; the probe removed
the reason for it, and it would have traded a live owner decision for a defect that turned out to be
somewhere else. That the fix touches neither the header nor the presence store is evidence it is the
right layer.

## Consequences

- gptbot's acceptance wakes work again, which unblocks the cross-family acceptance route the whole
  review loop depends on — the visible symptom was a ten-deep stall, not a subtle miscount.
- A wake now costs up to the full 90-second verify window when a foreign session is present, where
  it used to fail in about a second. That is the trade: latency in the rare contended case, buying
  delivery in a case that previously always lost.
- `wake_failed` continues to narrow toward meaning what it says. ADR 236 removed the sleeping host
  from that population; this removes the occupied seat. What is left is genuinely attempted and
  genuinely unsuccessful.
- A seat with a permanently live foreign session now defers indefinitely rather than exhausting.
  That is the intended trade and it is bounded by ADR 236's awake-time ceiling, which is the reason
  this ADR can lean on deferral without re-arguing termination.
- Only the codex backend classifies on provenance; claude-code does not check it, so its behaviour
  is unchanged. Deliberate — the change follows the defect rather than tidying both.

## Observability & Evaluation

**Traces.** No new action. A deferred wake writes `residency.wake_deferred` with the backend's
reason string naming the foreign provenance, joining the existing `local-session-live` (ADR 131 §5),
binary-not-found (ADR 221) and `host_unreachable` (ADR 236) reasons — four distinct causes on one
budget-neutral verb, all separable by `detail.reason` without a schema change.

**Eval.** The measurable claim is that a wake contended by a foreign session now succeeds rather than
failing. Baseline, from the ledger for 2026-08-05: **three consecutive `residency.wake_failed` rows
for gptbot (09:57:56, 10:28:35, 11:00:01), all `roster provenance session is not wake`, with ten
acceptance asks queued behind them and zero successful wakes between 09:27 and the manual drain at
11:25.** Success is that subsequent gptbot wakes report `residency.woke`, and that any
`wake_deferred` rows carrying a non-wake provenance reason are matched by a foreign session actually
holding the workspace. Failure to watch: verify windows consistently running to the full 90 seconds,
which would mean wakes are routinely contended and the diagnosis is incomplete — the wake's own row
should normally arrive in single-digit seconds.

**Experiment.** None. The discriminating experiment was run before the change rather than after: the
live probe above, which killed both standing hypotheses and produced the ~8s figure the fix depends
on. Withholding the fix from an arm would mean knowingly leaving the cross-family acceptance route
broken.
