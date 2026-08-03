# 211 — Deferred acts: raise on a condition, never a clock

- Status: accepted
- Date: 2026-08-03
- Builds on: [ADR 024](024-human-reachability-nudge.md) (recipient-side salience),
  [ADR 054](054-wake-on-message.md) (`inbox --wait` blocks until an act arrives),
  [ADR 103](103-steer-challenge-defer-acts.md) (`defer` on the Goal spine; a legible signal, not an
  executed mutation), [ADR 111](111-stale-plan-detection.md) (warn-never-block lane warnings),
  [ADR 117](117-elite-inbox.md) (the default view shows every unread),
  [ADR 131](131-harness-residency-wake-ledger-host.md) (the wake ledger and its candidate set),
  [ADR 145](145-human-role-refounded.md) (surfaces before more acts),
  [ADR 147](147-human-ask-stream.md) (the deciding `wait` and its `meta.until` duration),
  [ADR 179](179-board-triggered-work-order-wakes.md) (hook loops, never timers),
  [ADR 189](189-wake-pool-wakeability.md) (a layer never invents a fact it does not have), and
  [ADR 209](209-portable-wake-context.md) (recipient-scoped reads; architecture chapters update in
  the increment that changes the code).

## Context

A Member who receives a directed act has two honest choices: answer it now, or leave it unread.
There is no way to say "not now, bring this back when X." The gap has three consequences.

**The read cursor cannot express it.** Read state is a single monotonic timestamp per Member
(`packages/server/src/store/cursors.ts`); `listInbox` derives unread purely by comparing message
`ts` to it. Reading item C marks item B read. A Member who reads past something they intended to
return to has silently lost it.

**The utterance already exists and is inert.** A `wait` naming an ask (`meta.ask_ref`) must carry
`meta.until` — a free-text duration like `"1h"` or `"indefinite"` — validated in
`packages/protocol/src/envelope.ts` and audited as `ask.deferred`. Nothing parses it, stores it as a
timestamp, or acts on it. That utterance is the _sender's_ "deciding — check back" reply to an ask
(ADR 147 §5), not a recipient postponing an item: a different actor, but the same unmet need.

**Unread is the only re-raise.** ADR 024 makes pending work salient client-side and ADR 054's
`inbox --wait` blocks until an act arrives. Neither can defer something already delivered.

## Problem

"Raise this again later" has an obvious reading — a time — and that reading is closed to us. ADR 179
states the doctrine verbatim: all musterd loops are hook loops, triggered by board-state
transitions, **never by timers**; "the daemon runs no clocks on anyone's behalf." The daemon runs
exactly one repeating timer, the presence reaper, which expires stale presence and triggers no
wakes.

The primitive must therefore express postponement without a scheduler, without making the deferral
a hiding place that loses work, and without a thirteenth act — ADR 145 §4 spends surfaces before
verbs.

## Decision

### 1. A deferring `wait` — no new act

`defer` is taken: it is a Goal-spine act (ADR 103) whose fold drives wave derivation and the Goal
epoch in `listGoals`. Overloading it would collide with that derivation.

`wait` already means "paused" and already carries a `meta` family for "not now". A **deferring
`wait`** names the act being postponed and the condition that ends the postponement:

```ts
{ act: 'wait',
  meta: {
    defer_ref: string,                  // the directed act being postponed
    until: { lane: string }             // raise when that lane's state moves
         | { reply: true }              // raise when the deferred act's thread gets a new act
  }}
```

A `wait` carrying `defer_ref` MUST carry a well-formed `until`. `wait` now has three shapes,
distinguished by which `meta` key is present: bare (paused), `ask_ref` (deciding), and `defer_ref`
(deferring). A `wait` is never both deciding and deferring — the deciding shape's `until` is a
duration string, this shape's is a condition object, and admitting both on one envelope would make
`until` ambiguous.

**Only the recipient may defer.** `defer_ref` must name an act delivered to the sender of the
`wait`. Any other target is `forbidden` without disclosing whether the act exists — the boundary
ADR 209 §4 applies to wake-context reads.

**The deferral is legible.** It is an act on the thread, so the sender of the original ask can see
that it was postponed and on what condition, rather than watching it rot unread. This is ADR 103's
framing: a coordination signal, not a hidden mutation.

**It is not interrupt-class.** `wait` does not raise the interrupt line, so deferring cannot become
a second unpriced way to interrupt.

### 2. One derivation raises both conditions

Both conditions reduce to the same question: **does an act exist on this subject with a `ts` later
than the deferral's?**

- `until: { lane }` — lane state transitions are already acts in the stream (`meta.lane_state`).
  Raise when a lane-state act for that lane exists after the `wait`.
- `until: { reply: true }` — raise when an act on the deferred act's own thread, from a Member other
  than the deferrer, exists after the `wait`. The thread is the deferred act's `thread`, or its own
  id when it is a thread root — the rule `resolve` already uses (ADR 025).

One predicate over two subjects. No lane snapshot stored, no new column, no clock. Both read data
that exists already for other reasons.

`until: { lane }` is deliberately **loose**: it fires on the first lane-state act for that lane after
the deferral, which may not be the state the Member was waiting for — a lane moving to `active`
raises an act deferred until it lands. Naming a target state would be more precise and more to get
wrong. Evidence may argue for the precise form later.

### 3. Pendingness moves off the cursor

A directed act is **pending** when it is unread by the cursor **or** it carries a deferring `wait`
whose condition has since fired.

This is the resolution of the read-past problem: the cursor may sail past a deferred act and the act
still returns, because its pendingness no longer depends on the cursor at all. The cursor itself is
unchanged — no per-item read state, no migration.

Latest `wait` per `defer_ref` wins; re-deferring is appending another one. There is no supersede
column and no write-path side effect — the same pure read-side collapse `pendingInterrupts` performs
for steers.

A deferral ends three ways, all existing: its condition fires; a newer `wait` supersedes it; or the
thread terminates (`accept`/`decline`/`resolve`), after which the deferral is inert because the work
it postponed is over.

### 4. Wake eligibility is withheld, deliberately

Wake candidates are drawn from `listInbox(..., unreadOnly)` inside `claimWakeLeases`. Two things
follow, and both must be decided rather than inherited.

An act its recipient deferred is **not** a wake reason — they said "not now" — so deferred targets
are suppressed from the candidate set.

A **raised** act would otherwise become a batched-lane wake candidate the moment §3's fold lands,
with no new wake kind, no new `WAKE_DERIVATIONS` member, and nothing new to satisfy the "must carry
`act_id` or `lane_id`" refinement. Convenient, and a hazard: it would ship a wake nobody decided to
ship. The first increment therefore suppresses deferred targets whether or not they have raised. A
later increment enables raised acts as wake candidates deliberately, behind the existing loop and
seat controls.

### 5. The bounded view stays honest

ADR 117 requires the default inbox view to include every unread and the cursor to advance only to
the newest unread actually displayed. A deferred act is still unread and still counted. It is
demoted below the fold with an explicit footer line, never silently hidden.

### 6. Surfaces

No new MCP tool. ADR 144 makes tools expensive — scope-by-role, alias decay, never rename — and
`team_send {act:'wait', meta:{defer_ref, until}}` carries this with validation and a doc line only.
Agents get it for free.

The CLI takes the surface investment, since "surfaces before more acts" means spending here:
`musterd inbox defer <act_id> --until-lane <lane_id> | --until-reply`, and the deferred footer on
`musterd inbox`.

## Failure mode

An act deferred `until-lane` on a lane that never moves again is never raised. Postponement becomes
a quiet way to drop work. This is the loss mode the design risks, and it is named here rather than
discovered in production.

Mitigation follows the `stale_plan` shape from ADR 111: `musterd report` surfaces long-deferred acts
as a warn-never-block exception, directed at the affected Member and never broadcast. Warn, never
block, never auto-un-defer — the system does not decide on a Member's behalf that a deferral has
expired.

## Consequences

- A Member can postpone one directed act without losing it and without the cursor deciding for them.
- "Later" is a state edge in this system, permanently. Anyone who wants a wall-clock deferral must
  first overturn ADR 179's doctrine, which this ADR deliberately does not do.
- The deciding `wait` (`ask_ref` + duration) and the deferring `wait` (`defer_ref` + condition) are
  two shapes of one verb with two incompatible readings of `until`. Unifying those vocabularies is
  a later question and needs its own evidence.
- No new act, table, column, migration, or wake kind. The acts enum is untouched.
- Deferring a lane is out of scope: lane state and `depends_on` already express parked work, and a
  second vocabulary for blocked work is a cost without a case.
- 2026-08-03: [ADR 214](214-raised-deferral-wakes.md) supersedes §4's closing sentence. That sentence
  named `loops.*` and the seat's `flow` as the controls a later increment would enable raised acts
  behind; both gate board-triggered **work-order** wakes and state that inbox reply wakes are
  unchanged by them, so neither could gate a raised deferral. ADR 214 records the control that
  actually fits and the lane a raised act takes.

## Observability & Evaluation

**Traces.** `inbox.deferred` is the only new audit action: a recipient deferred one directed act,
detail `{ until: 'lane' | 'reply' }` — the condition _kind_ only, never the lane id and never a body
(ADR 051).

There is deliberately **no corresponding `raised` row**. A raise is derived at read time and has no
event; emitting one would invent a fact the system does not have, which ADR 189 forbids.

**Eval.** Measure the fold, not the absent event:

- deferral count and condition-kind split;
- the distribution of the deferral → raise interval, derived from act timestamps;
- the outcome split of raised acts: answered, re-deferred, or never answered.

The third number decides whether this helped. If "never answered" is material, the primitive gave
Members a tidier way to lose work, and this ADR should be revisited rather than extended.

**Experiment.** Keep the long-deferred report exception on from the first increment that ships a
surface, so the loss mode is observable before wake eligibility is enabled.
