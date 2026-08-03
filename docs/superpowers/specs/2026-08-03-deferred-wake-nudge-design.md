# Deferred wake / nudge — "raise this again later"

- Date: 2026-08-03
- Lane: 01KYJXGW63DQ4P408H37YDGV46 (ryder)
- Target ADR: 211
- Status: design, approved in brainstorm — not yet implemented

## Problem

A Member who receives a directed act has two honest choices: answer it now, or leave it unread.
There is no way to say "not now, bring this back when X." The gap has three consequences:

1. **The read cursor cannot express it.** Read state is a single monotonic timestamp per Member
   (`packages/server/src/store/cursors.ts`). Reading item C marks item B read. A Member who reads
   past something they intended to return to has silently lost it.
2. **The utterance exists and is inert.** A `wait` naming an ask (`meta.ask_ref`) must carry
   `meta.until` — a free-text duration like `"1h"` or `"indefinite"`
   (`packages/protocol/src/envelope.ts:143`), audited as `ask.deferred`
   (`packages/server/src/protocol/route.ts:538`). Nothing parses it, stores it as a timestamp, or
   acts on it. That utterance is the _sender's_ "deciding — check back" reply to an ask (ADR 147
   §5), not a recipient postponing an item — a different actor, but the same unmet need.
3. **Unread is the only re-raise.** ADR 024 makes pending work salient client-side, and ADR 054's
   `inbox --wait` blocks until an act arrives. Neither can defer something already delivered.

## Constraint that shapes everything

ADR 179 states the doctrine verbatim: all musterd loops are hook loops, triggered by board-state
transitions, **never by timers** — "the daemon runs no clocks on anyone's behalf." The daemon runs
exactly one repeating timer, the presence reaper, which expires stale presence and triggers no
wakes.

**Decision: "later" is a condition, not a clock.** A deferral names a state edge that brings the act
back. No scheduler, no due date, no "raise at" field. This is the only reading of "later" compatible
with the doctrine, and it is what the design below implements.

## Decision

### 1. A deferring `wait` — no new act

`defer` is taken: it is a Goal-spine act (ADR 103) whose fold drives wave derivation and the Goal
epoch in `listGoals` (`packages/server/src/store/goals.ts:92-126`). Overloading it would collide
with that derivation. Adding a thirteenth verb spends the thing ADR 145 §4 says to spend last —
"surfaces before more acts."

`wait` already means "paused" and already carries a `meta` family for "not now." A **deferring
`wait`** names the act being postponed and the condition that ends the postponement:

```ts
{ act: 'wait',
  meta: {
    defer_ref: string,                  // the directed act being postponed
    until: { lane: string }             // raise when that lane's state moves
         | { reply: true }              // raise when this thread gets a new act
  }}
```

Validation mirrors the existing `wait` + `ask_ref` rule in `envelope.ts`: a `wait` carrying
`defer_ref` MUST carry a well-formed `until`. A bare `wait` (ordinary "paused") and a deciding
`wait` (`ask_ref` + `until` duration) are unchanged. One verb, three shapes, each distinguished by
which `meta` key is present.

**Only the recipient may defer.** `defer_ref` must name an act delivered to the sender of the
`wait`. Any other target returns `forbidden` without disclosing whether the act exists — the same
boundary ADR 209 §4 applies to wake-context reads.

**The deferral is legible.** It is an act on the thread, so the sender of the original ask can see
that it was postponed and on what condition, rather than watching it rot unread. This follows ADR
103's framing: a legible coordination signal, not a hidden mutation.

**It is not interrupt-class.** `wait` does not raise the interrupt line
(`packages/server/src/store/messages.ts:185`). Deferring cannot become a second unpriced way to
interrupt.

### 2. One derivation raises both conditions

Both conditions reduce to the same question: **does an act exist on this subject with `ts` later
than the deferral's `ts`?**

- `until: {lane}` — lane state transitions are already acts in the stream (`meta.lane_state`).
  Raise when a lane-state act for that lane exists after the `wait`.
- `until: {reply}` — raise when an act on the deferred act's own thread, from a Member other than
  the deferrer, exists after the `wait`. The thread is the deferred act's `thread`, or its own id
  when it is a thread root — the same rule `resolve` uses (ADR 025).

One predicate over two subjects. No lane snapshot stored, no new column, no clock. Both read data
that already exists for other reasons.

**`until: {lane}` is deliberately loose.** It fires on the _first_ lane-state act after the
deferral, which may not be the state the Member was waiting for — a lane moving to `active` raises
an act deferred until it lands. Naming a target state would be more precise and more to get wrong.
Ship the loose version; let evidence argue for the precise one.

### 3. Pendingness moves off the cursor

Today `unread` is derived purely by comparing message `ts` to the cursor
(`packages/server/src/store/messages.ts:119-140`). Under this design a directed act is **pending**
when it is unread by the cursor **or** it carries a deferring `wait` whose condition has since
fired.

This is the whole resolution of the B-vs-C problem: the cursor may sail past a deferred act and the
act still returns, because its pendingness no longer depends on the cursor at all.

Latest `wait` per `defer_ref` wins. Re-deferring is appending another one. There is no supersede
column and no write-path side effect — the same read-side collapse `pendingInterrupts` already
performs (`messages.ts:209-210`).

**A deferral ends three ways, all existing:** its condition fires; a newer `wait` supersedes it; or
the thread terminates (`accept`/`decline`/`resolve`), after which a stale deferral is inert because
its target is closed.

### 4. The wake falls out of the fold — and must be gated

Wake candidates are drawn from `listInbox(..., unreadOnly)` inside `claimWakeLeases`
(`packages/server/src/store/residency.ts:663`). A raised act that is pending again is a
batched-lane wake candidate again, automatically.

**No new wake kind.** No new `WAKE_DERIVATIONS` member, no new `WAKE_CONTEXT_KINDS` member, and
nothing new to satisfy the "must carry `act_id` or `lane_id`" refinement in
`packages/protocol/src/residency.ts:333,356`. The "deferred wake" in this lane's title does not need
a wake mechanism; it needs the existing one to see the item again.

This is a hazard as much as a convenience: wake eligibility arrives the moment the fold lands,
whether or not that increment intends it. **Increment 0 MUST explicitly exclude raised acts from
`claimWakeLeases` until increment 2 turns them on deliberately.**

### 5. ADR 117 stays honest

ADR 117 requires that the default inbox view include every unread and that the cursor advance only
to the newest unread actually displayed. A deferred act is still unread and still counted. It is
demoted below the fold with an explicit footer line (`2 deferred — 1 until lane …`), never silently
hidden.

### 6. Surfaces

**No new MCP tool.** ADR 144 makes tools expensive — scope-by-role, alias decay, never rename.
`team_send {act:'wait', meta:{defer_ref, until}}` carries this with validation and a doc line only.
Agents get it for free.

**The CLI takes the investment,** since "surfaces before more acts" means spending here:

- `musterd inbox defer <act_id> --until-lane <lane_id>`
- `musterd inbox defer <act_id> --until-reply`
- the deferred footer on `musterd inbox`.

## Failure mode

An act deferred `until-lane` on a lane that never moves again is never raised. Postponement becomes
a quiet way to drop work. This is the loss mode the design risks and it must be named in the ADR,
not discovered in production.

Mitigation follows the `stale_plan` shape from ADR 111: `musterd report` surfaces long-deferred acts
as a warn-never-block exception. Warn, never block, never auto-un-defer — the system does not decide
on a Member's behalf that a deferral has expired.

## Observability & Evaluation

**Traces.** A deferral is a write and audits as `inbox.deferred` with the condition kind and target
id — never a body. A **raise is derived at read time and has no event to log**; emitting one would
mean inventing a fact the system does not have, which ADR 189 forbids.

**Eval.** Measure the fold, not the absent event:

- deferral count and condition-kind split;
- distribution of the deferral → raise interval, derived from act timestamps;
- outcome split of raised acts: answered, re-deferred, or never answered.

The third number is the one that decides whether this helped. If "never answered" is material, the
primitive gave Members a tidier way to lose work and the ADR should be revisited rather than
extended.

**Experiment.** Keep the report exception on from increment 1 so the loss mode is observable before
wake eligibility is enabled in increment 2.

## Increments

0. Protocol validation, the pending fold, inbox demote + footer. **Raised acts explicitly excluded
   from `claimWakeLeases`.**
1. CLI surface (`musterd inbox defer`) and the `musterd report` long-deferred exception.
2. Wake eligibility for raised acts, behind the existing loop/seat controls.

## Explicitly out of scope

- Any wall-clock deferral, due date, or scheduler in the daemon.
- Parsing or actuating the existing `wait` + `ask_ref` + `meta.until` duration string. That is a
  different actor's utterance (ADR 147 §5); unifying the vocabularies is a later question and
  needs its own evidence.
- Per-item read state. The cursor is unchanged.
- Deferring a lane. Lane state and `depends_on` already express parked work; a second vocabulary
  for blocked work is a cost without a case.
- Seat-level "do not wake me for this class" postures. That is the existing
  `WAKE_DEFER_SNOOZE_MS` suppression window (`residency.ts:52`), which is a different primitive:
  it suppresses rather than resurfaces.
