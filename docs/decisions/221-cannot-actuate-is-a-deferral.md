# 221 — A host that cannot actuate defers; it does not fail

- Status: accepted
- Date: 2026-08-04
- Deciders: nick (directed), stanley
- Relates to: ADR 131 (harness residency, §4 rate policy and §5 the local-session guard), ADR 216
  (Codex CLI backend)

## Context

A wake fails in two very different ways, and the ledger recorded them identically.

The first is a genuine failure: the harness spawned and did not occupy, the watchdog fired, the
child died. Something about _this act on this seat_ went wrong, and retrying is reasonable — which
is what `attempt_cap` bounds, retiring the act as `residency.wake_exhausted` after three tries.

The second is not a failure at all: the host cannot resolve the harness binary. Nothing was
attempted, because nothing could be. The act is deliverable, the seat is fine, and the fault is a
property of _the machine_ — an empty PATH entry on a LaunchAgent, a CLI installed for a different
user, a harness never installed on the host it was enrolled to.

Binary resolution happens inside the backend's `wake()`, **after** the lease is claimed, so the
second case was recorded as `residency.wake_failed`. Both the hourly/cooldown read (`wakesSince`)
and the per-act attempt read (`attemptsForAct`) count `residency.woke` and `residency.wake_failed`
only — so a host that could never spawn anything still consumed the act's entire attempt budget and
then retired it as terminally undeliverable. The seat reads as if it declined; the operator learns
nothing; and the act is gone.

From the live ledger on 2026-08-04:

- **9 of 12** `wake_failed` rows are binary-not-found or `ENOENT`.
- Joining exhausted acts to the failure reasons of their own attempts, **at least 3 acts reached
  terminal `wake_exhausted` purely because a binary was missing** (izzo ×2, miley ×1).
- It spans **3 of 5 seats and both harnesses across three weeks** — izzo's `claude` at two different
  paths, miley's `claude`, gptbot's `codex` the same day this was written. Same root cause,
  rediscovered by hand every time.

The pattern is not that hosts break. It is that when they do, the system spends an act to find out
and then blames the seat.

## Decision

**A backend that cannot resolve its harness binary returns a deferral, not a failure.**

`residency.wake_deferred` already exists for the local-session guard, and it is already
budget-neutral by construction: excluded from both the rate and attempt derivations, and covered by
the existing test _"deferrals burn NO attempt or rate budget"_. "This host cannot actuate" is the
same category of fact as "a human is working in this workspace" — a transient, machine-local reason
not to spend a wake — so it routes through the same verb and inherits that guarantee rather than
restating it. The `reason` field keeps the two distinguishable in the ledger.

**`musterd residency status` reports every harness this machine is enrolled for and cannot spawn.**
This half is not decoration. Deferring removes the terminal failure, but replaces it with silence:
the act now waits, correctly, and waits indefinitely if nobody notices. The trade is only honest if
the condition is visible, so the line names the seats, the harness, the consequence, and the
remedy — and is scoped to enrollments on _this_ host, because warning about another machine's
problem trains the reader to skip the line.

Two deliberate limits:

**No preflight in the host loop.** Checking before claiming the lease was the obvious shape and is
the wrong one: it duplicates resolution logic above the actuator seam that ADR 131 §7 exists to
keep thin, and it would have to be repeated per backend anyway. The lease is cheap; the _attempt
budget_ is what needed protecting, and returning a deferral protects it at the point where the
knowledge already lives.

**An unknown harness class is not reported.** Backends are pluggable, so a class with no registered
resolver is one this machine may simply not actuate. Silence beats a confident wrong accusation.

## Consequences

- A missing binary can no longer retire an act. The act waits and is delivered as soon as the host
  is repaired, instead of being lost after three attempts.
- A host that is broken for a long time accumulates deferrals rather than exhaustions. That is the
  intended trade, and it is why the `residency status` line exists — an act waiting forever in
  silence would be a worse failure than the one this replaces, just a quieter one.
- Wake metrics get cleaner: `wake_failed` now means an actuation that was genuinely attempted, so
  failure rate stops being diluted by machines that never tried. The ADR 209/210 delivery cohorts
  (ADR 210's Eval) inherit that directly.
- The existing deferral snooze (`WAKE_DEFER_SNOOZE_MS`) now also throttles this case, which prevents
  a broken host from re-leasing on every poll tick.
- A seat enrolled to a host that never gets fixed will never wake. That was already true; it is now
  visible instead of being laundered into a terminal act failure.

## Observability & Evaluation

**Traces.** No new action. `residency.wake_deferred` gains a second `reason` shape (the harness
name plus "not found") alongside the existing `local-session-live`, so the two remain separable in
the ledger without a schema change.

**Eval.** The measurable claim is that binary faults stop consuming attempt budget. Baseline, from
the ledger on 2026-08-04: **9 of 12 wake failures were binary-not-found, and ≥3 acts were retired as
`wake_exhausted` with a missing binary named in their own attempts**. Success is that subsequent
binary faults appear as `wake_deferred` and that no `wake_exhausted` row has a binary-not-found
reason among its attempts. Failure to watch: a rise in acts deferred for many hours, which would
mean the `residency status` line is not being read and the visibility half needs a louder surface
than an on-demand command.

**Experiment.** None. This corrects a misclassification against an existing, already-tested
budget-neutral path; there is no arm worth withholding it from.
