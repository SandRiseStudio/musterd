# 214 — A raised deferral wakes behind its own knob, on the batched lane

- Status: accepted
- Date: 2026-08-03
- Supersedes: the closing sentence of [ADR 211](211-deferred-act-raise.md) §4
- Builds on: [ADR 131](131-harness-residency-wake-ledger-host.md) (the wake ledger, its lanes and
  rate gates), [ADR 179](179-board-triggered-work-order-wakes.md) /
  [ADR 191](191-review-loop-wake.md) / [ADR 199](199-dispatch-loop-wake.md) (the work-order loops
  whose controls this ADR declines to reuse), and
  [ADR 209](209-portable-wake-context.md) (`portable_inbox_replies`, the precedent this knob copies).

## Context

ADR 211 gave a Member a way to postpone one directed act until a state edge fires. Its increment 1
suppressed every deferred target from the wake candidate set, raised or not, so that enabling
raised acts would be a decision rather than something inherited from the fold landing.

§4 closed by saying that later increment would enable them "behind the existing loop and seat
controls".

## Problem

**There are no such controls.** `loops.review` and `loops.dispatch` (team) and `flow: manual | auto`
(seat) gate board-triggered **work-order** wakes. `flow`'s own definition says so:

> Inbox reply wakes (immediate/batched) are unchanged by this knob.

A raised deferral is an ordinary inbox act — it carries an `act_id`, it comes from
`listInbox(..., unreadOnly)`, and it is not a work order. So no existing control covered it.

Reusing `flow` anyway would have overloaded a knob whose documented meaning is work-order trust, so
that a seat opting into review/dispatch wakes would silently also be opting into deferral wakes.
That conflation is the same category error that produced ADR 211 §4's sentence, and adopting it
would have made the error load-bearing instead of merely written down.

## Decision

### 1. A knob of its own, default off

`ResidencyPolicySchema` gains `raised_deferral_wakes: boolean`, default `false`, resolved per seat
through the existing ladder (launch defaults ⊕ team defaults ⊕ enrollment override).

It mirrors `portable_inbox_replies` (ADR 209 §2), the other ADR-rollout gate on the inbox wake path:
a typed, server-side, default-off selector that an operator turns on per seat, never a field a
sender can influence.

Off, every deferred target stays suppressed whether or not its condition has fired — ADR 211
increment 1's behaviour exactly, where a raised act waits in the inbox for the seat to return on its
own. On, a deferral whose condition has fired is a wake candidate again.

### 2. A raised act takes the batched lane, always

Whatever lane the underlying act would otherwise derive — including `immediate` for an urgent or
interrupt-class act — a raised deferral is emitted as `batched`/`batched`.

The Member chose to put the act down. Its return must not jump the interrupt line their own deferral
took it out of; a deferral that could resurrect itself as an interrupt would be a worse instrument
than leaving the act unread.

Two consequences follow directly and are intended:

- a seat pinned to the `interrupt` lane never receives one, because batched is closed for it;
- the batched lane's cooldown applies, so a raised act cannot wake a seat that was just woken.

### 3. Rate limiting is unchanged

The act id is already the exhaustion key (`wakeExhaustionKey`), so the hourly cap, cooldown, and
per-act attempt cap apply to a raised deferral exactly as to any other batched wake. No new key
space, no new counter, no new terminal state.

## Consequences

- ADR 211's deferral primitive can now actually reach an offline seat, which is what makes "raise
  this again later" more than an inbox annotation — but only where an operator asked for it.
- The work-order controls keep their documented meaning. A seat can run `flow: auto` without
  acquiring deferral wakes, and vice versa.
- A seat pinned to the interrupt lane cannot use this feature at all. That is a real limitation and
  the honest consequence of §2's ordering rule; it is not worked around.
- No new wake kind, `WAKE_DERIVATIONS` member, audit action, table, or column. The change is one
  policy field and one branch in the candidate derivation.
- The knob defaults off, so this ships inert. That is the cost of §1 and is accepted: a deferral
  made weeks ago should not spawn a session because a default changed under it.

## Observability & Evaluation

**Traces.** None added. A raised-deferral wake lands as an ordinary batched `residency.woke` with
the act id it woke for, so the ADR 131 wake ledger already measures its cost, duration, and outcome.
Adding a distinct trace would duplicate a fact the ledger holds.

**Eval.** Enable the knob on one dogfood seat and ask whether those wakes are **answered**. Join
`residency.woke` rows for raised acts to what the woken seat then did with the act: answered
(`accept`/`decline`/`resolve` on its thread), re-deferred (another `wait` naming it), or left.

Re-deferred or left is the failure shape — a wake the Member paid for and did not want. If it
dominates, the conclusion is not to tune the knob but that a raised deferral belongs in the inbox
rather than in a spawn, and this ADR should be reversed rather than defaulted on.

**Experiment.** The knob stays opt-in until that cohort shows raised-deferral wakes are answered at
a rate comparable to ordinary batched inbox wakes. No default flip from a single seat's run.
