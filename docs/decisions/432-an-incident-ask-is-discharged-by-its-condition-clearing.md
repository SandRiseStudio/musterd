# ADR 432: an incident ask is discharged by its condition clearing, not by a human answering

- Status: proposed
- Date: 2026-09-21
- Lane: 01M32QEEXJXG6402GEPK7YGCHZ
- Relates to: [ADR 232](232-service-seats.md) (service seats are excluded from the peer verbs),
  [ADR 025](025-resolve-closes-a-thread.md) (`resolve` is thread-terminal),
  [ADR 429](429-inbox-pinning-is-an-obligation-rule-not-a-salience-one.md) (pinning is an
  obligation rule)

## Context

Guardian watches the daemon and raises an `ask` when it finds an incident it cannot remediate —
`daemon_down`, `daemon_wedged`. Measured on the hub daemon 2026-09-21: **55 guardian `ask` /
`request_help` acts carry no `accept` or `decline`** — 30 from 2026-08, 25 from 2026-09, 20.8 KB of
body. The daemon was healthy when the count was taken, so every one of them describes a condition
that had long since cleared.

Found by stanley while accepting ADR 429's lane, where ~28 of them were sitting in his pinned set.

## Problem

**Guardian can raise an obligation and is structurally barred from discharging one.** ADR 232 makes
a `service` seat an accountable actor and not a negotiator: it never holds lanes, never accepts,
never wakes. `accept` is precisely the act that discharges an obligation. So the only actor that
knows the condition cleared is the one actor the protocol forbids from saying so.

A human could answer, and does not — by the time anyone looks the daemon is back up and there is
visibly nothing to answer. This is not laziness; a raise with no live condition behind it offers the
reader no action, and clearing it by hand is indistinguishable from dismissing it unread.

The existing damper is not this. `shouldRaise` stops guardian *repeating* an unchanged reason inside
an hour; it does nothing about the ask already standing, which is owed forever.

ADR 429 turned a slow leak into a standing cost. Pinning is now an obligation rule, and `ask` is
obligation-class whoever it is addressed to, so all 55 are pinned into every bounded inbox read,
oldest-first, for every seat. That is the correct behaviour for a real unanswered ask — it is the
one thing a bounded page must not drop — and it is why the leak now has to be closed at the source
rather than papered over by un-pinning asks.

**A second, older gap surfaced while building this.** ADR 429's pinned fold did not honour a
`resolve` on the thread. `countOpenLoops` has honoured it since ADR 090 and the CLI's
`openActionNeeded` always has — so a resolved obligation was excluded from the open-loops gauge and
from the human's banner while still being pinned into every bounded agent read. Three readers of
"is this still owed", two agreeing and the newest one not.

## Decision

1. **A class absent from a tick's classification is that class observed healthy, and guardian says
   so.** `classify` already returns the incident list; a class not in it is a class that is not
   currently wrong. After acting, `actOn` walks the open raise memos and, for each class not firing
   this tick, records a `guardian.cleared` ledger line and drops the memo.

2. **The discharge guardian sends is a `resolve` on its own raise's thread.** Not an `accept` —
   ADR 232 bars that, and this ADR does not re-open it. `resolve` is thread-terminal (ADR 025) and
   is not a peer verb, so it is a discharge a service seat may express. The raise's act id is
   therefore remembered on the stamp (`RaiseMemo.actId`), because a `resolve` must name the thread
   it closes.

3. **A `resolve` on the thread discharges an obligation in the pinned fold** — closing the ADR 429
   gap, so the three readers agree again.

**Derived, never stored** (the ADR 090/423 property). Nothing is written onto the ask. If the
condition returns, the next tick raises a **new** ask at a later position and it is owed again, with
nothing to un-set.

**The direction this must not err in.** Only a class *absent* from `incidents` clears. A condition
that persists is re-classified every tick and so is never absent, so a real open incident cannot go
quiet. If the `resolve` fails to send, the memo is **kept** and the next tick retries — an un-sent
discharge is not a discharge, and forgetting it locally would strand a pinned obligation with
nothing left that knows to close it.

**The discharge sends no `ask` and no `status_update`.** A recovery must not bill attention the way
the incident did.

## Consequences

- The 55 existing asks retire without a data migration: the daemon is healthy, so the first tick
  after this ships clears each open class and resolves its thread. Older raises whose act id the
  stamp never recorded have no thread to close — they stay owed on the server, and the local memo is
  still dropped so the damper does not wedge shut. **That residue is real and is not fixed here**:
  historical asks predating `RaiseMemo.actId` need a one-off sweep, which wants its own decision
  about who may resolve another seat's thread.
- One extra act per recovery, a `resolve`, which is small and terminal. Against 55 permanently
  pinned asks this is a trade worth making, but it is an act, and lane 01M32QF2X4 (the newest tail
  has no obligation rule) should count it.
- Guardian's ledger stays a log line, not an audit row: there is no client-writable audit endpoint,
  which is why the discharge had to be an **act** rather than an audit row a server-side fold reads.
  That constraint is what shaped decision 2.
- A resolved obligation now leaves the pinned set on every surface. Any reader that relied on a
  resolved-but-unanswered ask staying pinned loses it — none is known, and the two older readers
  already behaved this way.

## Observability & Evaluation

- **Traces:** one `guardian.cleared` log line per class per recovery, carrying `class`, `raised_at`,
  `suppressed` and the `act` it closes, plus the `resolve` act itself in the message log. No new
  table, no schema change.
- **Eval:** dataset is the daemon's own message log. Measure = guardian `ask`/`request_help` acts
  with no `accept`/`decline` **and** no `resolve` on their thread. **Baseline 2026-09-21: 55** (30
  August, 25 September). **Bar:** after the first healthy tick post-deploy, no guardian ask raised
  *after* this ships remains undischarged while its class is quiet. Falsify with the query in the
  lane, adding the thread-resolve clause.
- **Experiment:** the question this cannot answer is whether anyone would have acted on a real
  incident faster without 55 stale asks in the way. That needs a real outage, and it is not worth
  staging one.
