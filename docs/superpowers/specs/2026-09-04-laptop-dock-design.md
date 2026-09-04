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

Three forks were put to him. All three answers took the harder edge.

### 1 · An idle member holds their desk — but work outranks idle

Their laptop stays docked and the monitor goes dark while their body sits in the lounge. **If a
working member would otherwise have no desk, the longest-idle holder yields**: the desk is released
and that member's laptop goes with them to the lounge.

The alternative he declined was "hold it, overflow is honest" — let working members queue at the
entrance strip. He chose to keep `an occupied desk means work in progress` true, and pay for it with
a second choreography.

**Cost, recorded up front:** this weakens *my laptop marks my desk*. A yielded member's laptop is
beside them on a couch, so a viewer who has learned "laptop = that person's desk" meets an exception.
It is the rarer state and it is visible (the laptop is drawn beside them, not deleted), which is what
makes it survivable.

### 2 · On departure they pack up and take it

Undock, close it, carry it out the door. **An empty dock means nobody home** — and that is what makes
a docked laptop mean anything at all. The declined alternative left the laptop docked overnight,
which would have made the object decorative again within a day.

This is a genuine departure from today's rule that an offline member's desk stays owned with a jacket
over the chair. The jacket stays; the laptop goes. They say different things and now the floor can
say both.

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

One invariant, and everything else is derived from it:

> **A member's laptop is either docked at their desk, or with them.** Never both, never neither,
> never anywhere else.

Which gives four floor states:

| state | body | laptop | monitor |
| --- | --- | --- | --- |
| **away / offline** | not on the floor | not on the floor | off, dock empty |
| **arriving** | door → desk | under their arm | off |
| **working** | at the desk | docked | **on** |
| **idle, holding** | a leisure spot | docked at their held desk | off |
| **idle, yielded** | a leisure spot | closed, beside them | off (desk is someone else's) |
| **leaving** | desk → door | under their arm | off, dock empty |

### Seating

`assignSeats` is a pure function of the roster, deterministic by hash-and-probe, *"so avatars don't
teleport between reloads or presence pings."* That property is worth more than the feature, so the
new rule must not need history.

It does not. "Work outranks idle" is expressible as **priority order within one pass**:

1. `away` members → nook, desk held (unchanged)
2. **working / dnd → desks** (probe) ← moved ahead of idle
3. **idle → a desk if one remains**, body placed at a leisure spot regardless
4. idle with no desk left → leisure spot, laptop with them
5. overflow → entrance strip

No memory of who held what last frame; the same roster still yields the same seating. "Longest-idle
yields" is then not a separate mechanism at all — it is what step 3 does when desks run out, and the
probe order makes it stable rather than arbitrary.

`Placement` gains one field: an idle member is `{ kind: 'leisure', spot, heldDesk?: number }`. The
body is at `spot`; the laptop is at `heldDesk` when there is one.

### Rendering

Per desk slot, the renderer needs three facts rather than one: **who owns it**, **is their laptop
docked**, **are they working**. Today it reads one (`slotMember`), and the night-office lighting pass
already learned what that costs — the old desk-lamp pool loop keyed off `slotMember` and lit bench
seats and offline owners' kept desks, neither of which has a lamp.

- monitor lit ⟺ owner present **and** working **and** docked
- laptop drawn in the dock ⟺ docked
- dock drawn always, empty when not

`audiblyWorking` stays the single predicate for *is this member working*. The monitor gains
`&& docked` on top of it, not instead of it — so the screen and the typing can only disagree during
the arrival frame before they sit, which is the one moment they *should*.

## Known simplifications

Written down rather than discovered later.

1. **The yield is not animated.** When a working member takes a held desk, the idle holder's laptop
   moves from that dock to beside them on the couch without a walk. Animating it means routing them
   back across the floor to fetch it for a state nobody is watching. The laptop is *relocated and
   still drawn*, never deleted — this room's rule is that nothing vanishes, not that everything is
   witnessed. If it reads badly on the stream, the walk is the fix.
2. **Arriving-already-idle skips the carry**, by nick's explicit instruction: the laptop is simply
   docked and the body goes to the lounge. Defensible beyond the instruction — the common case is
   the scene *hydrating* with members already placed, where the page genuinely did not witness them
   arrive. Same honesty seam gptbot's dwell correction drew: an unwitnessed arrival claims nothing.

## Falsifiers

- the invariant, over a synthetic roster: for every member, `docked` XOR `withThem`, in all six
  states — never both, never neither;
- 18 working members against 17 desks: no idle member holds a desk while a working member has none;
- a roster shuffled into a different array order yields identical placements (the determinism
  `assignSeats` already promises, re-asserted now that priority order has changed);
- a member going offline leaves an empty dock, not a docked laptop;
- no desk draws a laptop whose owner is not on the floor — the scenery-laptop regression.

## Not in this lane

The dock beat's sound, and any change to the leisure furniture's capacity. The lounge holding 10 of
~19 is a separate question about the floor plan, and this design deliberately does not touch it.
