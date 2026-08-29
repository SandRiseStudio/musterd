# 335 — Attestation follows the slot, not the hook

- Status: accepted
- Date: 2026-08-28
- Builds on: [ADR 131](131-harness-residency-wake-ledger-host.md) §5 (session capture: the daemon
  learns harness class and nothing more), [ADR 166](166-session-liveness-by-enumeration.md) (the slot
  is the weaker witness), [ADR 252](252-wake-cost-failure-path.md) (a paid session invisible to the
  ledger — the same shape, priced)
- Lane: 01M159BHJK2TBDNDY8ABZV0W84

## Context

ADR 131 §5 gave a workspace one **slot** — `binding.session` — naming the harness session that holds
it, and one **attestation**: `musterd session start|end --stdin`, fired by the SessionStart and
SessionEnd hooks, telling the daemon that a session of some harness class exists. The slot is local
truth; the attestation is what the ledger knows.

Since then the slot acquired writers the attestation did not follow.

- The **interloper gate** (lane 01KZAEGF2K) stops an empty 4-second process from stealing a live
  slot. A newcomer may not take a live-looking slot until its own transcript shows a turn, and being
  gated means being invisible: no slot write *and* no attestation.
- The **heal** (lane 01KYQF0STK) fixes the opposite failure — a corpse slot naming a session that
  has ended while another is plainly running. It runs at the tool boundary, the boundary that always
  happens, and gives the slot to the session actually running.

Both are right. Together they describe a session that holds the slot and was never announced.

## Problem

A transcript has no turn at SessionStart — the file appears at the first turn. So the gate's activity
predicate is *false by construction* for every genuinely new session, and any newcomer arriving
beside a live occupant is turned away. Moments later the heal hands it the slot for real. The heal
writes locally and calls nothing; `captureSession` was the only caller of `attestSession`, and it has
already run. Nothing retries, and the push is `try`/`catch`-silent because a hook must never fail — absence on
the ledger therefore says nothing at all, which is exactly the reading ADR 236 warns against.

The result is a session that holds the slot, acts as the seat, and does not exist on the ledger.

Measured on seat `ryder`, 2026-08-28. A wake child held the slot; an interactive session started
beside it, was gated, and took the slot at its first tool boundary — its `started_at` equals the
transcript's birthtime to the millisecond, which is the heal's signature (`birthtimeOf`), not
SessionStart's (`Date.now()`). It then ran for two hours, claimed a lane and closed one, and its
correlation digest `982f768adf12` returned **zero** audit rows for its entire life. The newest
session the daemon knew of was the wake child, ended ninety minutes earlier. Not a transport fault:
the same workspace's agent key POSTing that route by hand landed a row synchronously.

What that costs: wake cost accounting cannot see these sessions; any ledger-based "is this seat
occupied" read is wrong; and two-sessions-on-one-seat is unobservable *precisely when it happens*,
because the gated session is the one that leaves no trace. The overlap above was only recoverable
from the `messages` table. The gate's note that "the slot self-corrects at the next SessionStart" is
true of the slot and false of the ledger, which has no later moment in which to correct.

## Decision

**Attestation belongs to holding the slot, not to the hook that happened to write it.**

`SessionCapture` gains `attested_at` — machine-local, like the rest of the slot, recording that an
attestation *landed*. The tool boundary reconciles: an un-ended slot with no `attested_at` is
announced once, beside the model observation that already runs there for the same reason.

Four constraints, each load-bearing:

- **Only on success.** The stamp is written after the push returns, never optimistically. An
  unreachable daemon leaves the slot due; one bad minute must not permanently mark a session
  announced. (A mutation found this unpinned on the capture path — it is now a test.)
- **Once per session, not per tool call.** `attested_at` is the bound.
- **Un-ended slots only.** A corpse is not a session to announce.
- **It never writes or takes a slot.** The gate still decides who holds one, so a newcomer it turned
  away still announces nothing. This adds a report; it does not add a claimant.

`attested_at` stays out of `WorkspaceSpecSchema`, so it never reaches the committed
`workspace.json`, and nothing about it crosses the wire: the attestation body is unchanged — harness
class, event, keyed digest, optional wake lease. ADR 131 §5's rule about what the daemon may learn
is untouched; this is about *when* it learns it.

## Consequences

- Sessions that take the slot by the heal are now on the ledger, so cost accounting and occupancy
  reads see them. Historical residency counts **undercount sessions by an unmeasured amount** — any
  analysis crossing 2026-08-28 should say so rather than compare across it.
- The daemon may now hear `start` for a session minutes after it began. `started_at` is local and
  never travelled, so the ledger never claimed to know when a session started — but a reader who
  inferred it from row timestamps was already guessing, and is now guessing differently.
- A gated session that is never healed (it never reaches a tool boundary) still announces nothing.
  That is the gate working: such a session did no work either.
- Not addressed here, and still true: nothing tells either session that two of them hold one seat.
  The gate prevents slot theft, not co-tenancy — ADR 131 §5 leaves live-beside-live to the wake
  guard, and the wake guard runs once, before spawn. That is a separate lane.

## Observability & Evaluation

**Traces.** No new span. The reconciler rides the existing tool-boundary path and its whole output is
the `residency.session_captured` row it was always supposed to produce — the point of the change is
that the row now exists, so the ledger itself is the instrument. The row is unchanged in shape, so
every existing reader keeps working.

**Eval.** Dataset: the `audit` table's `residency.session_captured` / `.session_ended` rows joined to
`wake_leases`. Baseline, measured on this machine 2026-08-28 before the change — of the sessions the
`messages` table proves acted (a seat that sent an act while holding the slot), the ledger names
only those a wake spawned; seat `ryder`'s interactive session of that day appears zero times against
five wake-spawned captures in the preceding day. The number to watch is the ratio of acting sessions
to captured sessions per seat per day, which should move toward 1. It cannot be computed
retrospectively with precision, because the sessions it counts are the ones that left no row — which
is the finding, not a gap in the method.

**Experiment.** Stated so a reader knows which arm is evidence and which is still owed.

The **pre-change arm was observed, not staged**: the ryder session above is exactly the sequence —
gated at SessionStart, healed into the slot at a tool boundary, zero audit rows for its whole life.
That arm needs no re-running; it is the incident.

The **post-change arm is pinned at unit level, not yet in a live session**: five tests cover the
heal-then-attest path, idempotence, the ended-slot refusal, the failed-push retry, and the gated
newcomer that still announces nothing. Four mutations — drop the un-ended guard, drop the
`attested_at` bound, drop the stamp, stamp regardless of whether the push landed — each turn exactly
one of them red; the last was found SURVIVING before its test existed, which is why that test is
there. What remains owed, and cheap: run a real session beside a live occupant on a build carrying
this change and confirm one `session_captured` row appears at the first tool boundary. Until someone
does, the live claim rests on the tests rather than on a measurement.
