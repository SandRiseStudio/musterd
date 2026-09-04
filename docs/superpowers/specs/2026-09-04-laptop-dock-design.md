# The laptop is the member's, and the desk is where it lives — design

**Date:** 2026-09-04 · **Seat:** miley · **Asked by:** nick

## The ask

nick, watching the stream:

> lets keep the monitors at the desks but i just want those to be monitors and not full pcs. I want
> the members to actually walk into the office with laptops (closed) under their arm and then when
> they get to their desks to work, they sit down and first put their laptop in a dock which then
> powers on the monitor. When they are idle, i want them to turn off the monitor, leaving the laptop
> at the desk and walk to whichever idle space. If they come into the office already idle, there
> laptop should just appear at their desks and they should go straight to their idle space.

And: *"This probably is a big change so it needs to be thought out."* It is, and the size is not in
the drawing.

## What is true today

**Desks are a pool, and the pool is the point.** `seating.ts` `assignSeats` places *idle* members on
the leisure furniture **before** working members claim desks, and says why in its own doc comment:

> Idle members claim leisure spots before working members claim desks, and only fall back to a desk
> when the leisure furniture is full — so a desk is never occupied by someone idle while a couch sits
> empty. That inversion is the whole contract: **on this floor, an occupied desk means work in
> progress.**

The floor has **17 desks and 10 leisure spots**, against a roster of ~19.

**A lit screen is the work cue**, and it comes off one predicate. `audiblyWorking(m)` is
`posture === 'working'`, and `seating.ts` is explicit that this is deliberately the *only* one:

> This is the same predicate the renderer types and lights screens on (`render.ts` `skelFor` / screen
> glow), and the render loop's park check shares it too — one predicate for eyes, ears and the loop,
> so none of the three can disagree.

**Two desks already show a laptop — as scenery.** `MONITOR_SETUPS_BY_ID` gives desks 2 and 10 a
`laptopRiser` (an open laptop on an aluminium stand) and desks 7 and 11 a `laptopDock` (a *closed*
laptop stood in a wooden dock). They belong to nobody; they are furniture variety.

**Members already arrive and leave on foot**, through `ENTRANCE`, and the walk legs already carry a
`carry` slot (`CarryKind = 'box' | 'plate' | 'bottle' | 'mug' | 'phone'`) — a member crossing the
floor with an object in their hands is machinery that exists.

## The change, stated plainly

A laptop in a dock is **not** the same fact as a lit screen.

- a lit screen says *someone is working here, now*;
- a docked laptop says *this desk is someone's, and they are in the building*.

The second fact has no representation on this floor today, and adding it is the whole change. Every
consequence below follows from it, including the one that costs the most.

## Decisions (nick, 2026-09-04)

### 0 · The laptop never leaves the member, except to dock — **supersedes the ask and forks 1–2**

nick, after reading the first draft of this design:

> how about members just always carry their laptops with them — as they enter and exit they carry
> their laptop, when they work they dock it at their desk, and when they are idle they hold it under
> their arm if they are standing/walking and if seated they fold it under their arm or keep in their
> lap folded? this also takes care of yield is not animated issue right?

It does, and it takes care of considerably more than that. This is now the design; the two paragraphs
that follow are kept because the reasoning they were answering is what makes this version's cheapness
legible, not because either is still in force.

**One biconditional replaces the whole model above:**

> **The laptop is docked ⟺ the member is working at their desk. Every other moment it is on their
> person.**

What that dissolves, in descending order of what it was going to cost:

- **The seating change — all of it.** An idle member never has a laptop at a desk, so they have no
  reason to hold one. `assignSeats` keeps its existing contract *untouched*: idle members claim
  leisure furniture before working members claim desks, and *"on this floor, an occupied desk means
  work in progress"* stays literally true instead of becoming a near-truth with an exception. Fork 1,
  which I asked nick to decide, is moot — there is nothing to yield.
- **The `audiblyWorking` risk.** Docked ⟺ working means the monitor is lit by *exactly* the predicate
  it is lit by today. No `&& docked`, no second condition, no way for eyes, ears and the loop to
  disagree. The one-predicate contract survives completely untouched.
- **Known simplification 1 — the un-animated yield.** Gone: no laptop ever moves between a dock and a
  couch, because no idle member's laptop is ever in a dock.
- **Known simplification 2 — the laptop that "just appears" at the desk of someone arriving idle.**
  Gone, and this is the one worth dwelling on: they now carry it in like everyone else and keep it.
  Nothing materialises out of nowhere, so the room's own rule — *nothing teleports* — holds without
  an exemption. The original ask asked for the exemption; this version does not need it.
- **Fork 2, departure.** Answered by construction. They always have it, so of course it leaves with
  them, and an empty dock means nobody is working at that desk.

**What it costs**, and both are real:

1. **Clutter.** Nineteen members each carrying a silver object, several of them clustered on the
   lounge furniture. The mitigation is silhouette: tucked under the arm, small, closed — a shape at
   the elbow, not an object held out in front. If the lounge reads as a laptop shop, the fix is to
   drop the seated ones into the lap where the body occludes most of them.
2. **It collides with the errands.** A member fetching a plate from the fridge or taking a call
   already carries something, and a member who eats lunch with a laptop welded to their arm is worse
   than one who left it at their desk. Precedence rule: **an errand's carry wins for its duration**
   — you set the laptop down to eat. The laptop returns to the arm when the errand ends.

### 1 · ~~An idle member holds their desk — but work outranks idle~~ (superseded by §0)

Their laptop would stay docked and the monitor go dark while their body sat in the lounge, and if a
working member would otherwise have no desk, the longest-idle holder would yield. Recorded because
its **cost** is what §0 buys out: it weakened *my laptop marks my desk*, and it needed a laptop to
move from a dock to a couch with nobody walking it there.

### 2 · ~~On departure they pack up and take it~~ (now true by construction, §0)

Kept for its conclusion, which survives: **an empty dock means nobody is working there.** The jacket
over the chair still says the desk has an owner. The two say different things and the floor can say
both.

### 3 · The dock beat is light

Arrive at the desk → sit, dock and monitor-on land **together**. No wake lag. The full four-step beat
(sit, pause, dock, pause, monitor wakes) was declined: it reads at 720p only if the viewer happens to
be looking at that desk in that second, and it is four timed steps of new choreography to keep the
render loop honest about.

## What falls out

**The decorative laptops must go.** Once a laptop means *this person is in the building*, a laptop
that belongs to nobody is a lie told four times per frame. `MONITOR_SETUPS_BY_ID` keeps its monitor
variety — `single | dual | ultrawide` — and loses `laptopRiser` / `laptopDock`. Every desk instead
gets the same small dock, empty until its owner arrives.

**"Monitors, not full PCs" is separable and is a real bug.** `screenPanel` draws the panel body as a
box and `monitor()` sits it on an 8×6×8 dark foot; at this camera angle the two read as one chunky
all-in-one rather than a thin panel on a stand. That is a drawing fix with no state behind it, and it
can land on its own.

## The model

One biconditional, and everything else is derived from it:

> **The laptop is docked ⟺ the member is working at their desk. Every other moment it is on their
> person.**

Which gives five floor states, and no sixth:

| state | body | laptop | monitor |
| --- | --- | --- | --- |
| **away / offline** | not on the floor | not on the floor | off, dock empty |
| **arriving** | door → desk | closed, under the arm | off |
| **working** | at the desk | **docked** | **on** |
| **idle, standing / walking** | crossing the floor | closed, under the arm | off, dock empty |
| **idle, seated** | a leisure spot | closed, in the lap | off, dock empty |
| **leaving** | desk → door | closed, under the arm | off, dock empty |

There is no *held desk*, no *yielded* state and no laptop anywhere a member is not. The table is
longer than the model.

### Seating — unchanged

`assignSeats` is not touched by this lane. Its existing contract is what makes the biconditional
true at the seating layer: idle members claim leisure furniture before working members claim desks,
so *an occupied desk means work in progress* — and therefore a docked laptop and a lit monitor mean
the same thing, which is exactly what the model says.

The determinism it promises (hash-and-probe, *"so avatars don't teleport between reloads or presence
pings"*) is likewise untouched, because nothing here needs to know what was true last frame.

### Rendering

- **monitor lit ⟺ `audiblyWorking(owner)`** — the predicate it already uses. Unchanged.
- **laptop drawn in the dock ⟺ the same condition.** The dock is a second reading of the work cue,
  not a new fact plumbed through the scene.
- **the dock is drawn always**, empty when nobody is working there.
- **the laptop on the body** is a new `CarryKind: 'laptop'` in `drawCarry`, which positions off the
  skeleton's joints (`chest`, `wrist[]`) rather than off a pose name. That is why the seated and
  standing cases are one piece of code and not two: the joints move, the drawing does not care how.

### Carry precedence

A member can only hold one thing. **An errand's carry wins for its duration** — the plate from the
fridge, the water bottle, the phone on a call — and the laptop returns to the arm when the errand
ends. Without this rule a member eats lunch with a laptop welded to their elbow, which is worse than
anything this lane set out to fix.

## Known simplifications

Both of the previous draft's simplifications were bought out by §0. What remains:

1. **The desk's dock is drawn empty for a member who is idle *at their own desk*** — dnd members, and
   idle members who spilled to a desk because the lounge was full. They are sitting at a desk with
   their laptop in their lap and an empty dock in front of them, which is a slightly odd picture but
   an honest one: they are not working, and the room says so consistently in three places at once.

## Falsifiers

- **the biconditional**, over a synthetic roster in all five states: `docked(m)` is true exactly when
  `audiblyWorking(m)` is, and `onPerson(m)` is its negation for every member on the floor — never
  both, never neither;
- **no laptop without an owner on the floor**: no desk draws a docked laptop for a member who is away,
  offline, or capped out of the render — the scenery-laptop regression, which is what
  `MONITOR_SETUPS_BY_ID` used to do on four desks by design;
- **an errand outranks the laptop**: a member sent for a plate carries the plate, not the laptop, and
  has the laptop back when the errand ends;
- **`assignSeats` is byte-for-byte unaffected** — the existing determinism and ordering tests still
  pass untouched, which is the evidence that this lane did not quietly move the seating contract.

## Not in this lane

The dock beat's sound, and any change to the leisure furniture's capacity. The lounge holding 10 of
~19 is a separate question about the floor plan, and this design deliberately does not touch it.
