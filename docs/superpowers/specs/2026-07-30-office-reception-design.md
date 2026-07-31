# Office reception — a front desk, a receptionist who isn't a member, and a check-in beat

**Date:** 2026-07-30
**Approved by:** nick (in-session)
**Owner:** miley
**Surface:** `packages/web` — `src/live/office-scene/{layout,render,actors}.ts`
**Spec C of three.** Siblings: [room dressing](./2026-07-30-office-room-dressing-design.md) (A),
[life, motion & sound](./2026-07-30-office-life-motion-sound-design.md) (B).

> **Naming note.** `src/live/ReceptionScene.tsx` is an unrelated flat-SVG banner for the approval
> queue (ADR 098). This spec is about the isometric office floor and does not touch it. Two things
> called "reception" in one package is already one too many — do not merge them.

## Problem and idea

Nick, 2026-07-30:

> I'm also thinking that in the entrance of the office, we should have a space or desk for an office
> receptionist. That office receptionist looks like a member but isn't actually a member. For this
> space, when actual members start to enter into the room, they have to stop at the receptionist and
> check in.

The entrance already has a waiting cluster — `RECEPTION` gives it a rug, a couch, a coffee table and
a fiddle-leaf fig — but nothing to wait *for*. The door is the one part of the room with no reason to
exist. A front desk makes the whole corner a place.

## Decision, and the two amendments

The desk is adopted as proposed. Two changes to the rest:

### 1 · The receptionist is staff, not roster

"Looks like a member but isn't actually a member" is the risky half of the idea. **Every avatar on
that floor today is attested** — it means a real seat, a real harness, a real model (ADR 101 model
attestation, ADR 109 git attribution). A character who reads as a member and is not one quietly
breaks the only rule the room has, and the room's whole value is that you can trust what it shows.

So she is legibly **staff**:

- **Never a nameplate**, ever. The nameplate is the attestation surface; she has nothing to attest.
- **Never leaves the desk.** She has no home desk, joins no pod, takes no leisure spot, is never a
  walk target, and never appears in a headcount, the roster, `N/M`, or the work stack.
- **Distinct silhouette and palette** from member avatars — different enough that the difference is
  visible before you read anything.

She is set dressing that breathes, in the same category as the dog: alive, not attested.

### 2 · A check-in beat, not a check-in gate

Making arrivals *queue* costs us the moment presence matters most. A seat joins — the single most
informative event the office ever shows — and we hide it behind a turnstile. It also stacks badly:
three simultaneous joins become a line at the door instead of three people appearing at work.

So it is a **beat**, roughly 1.2 s:

1. The arriving member pauses at a mark in front of the desk.
2. The receptionist **looks up**.
3. A small badge glyph flashes.
4. The member continues to their desk.

A touch of ceremony, not a bottleneck. If several arrive at once they check in **in parallel at their
own marks** — they do not form a line. The existing overflow queue strip (`STRIP_CAP`, the "+N
waiting" pill) is a different mechanism for a different situation and is unaffected.

## The trap, and why it is already handled

On a page load every present member is new to the client, so a naive implementation replays the
entire ritual on every refresh — seven people queueing at the door because you hit reload.

**The mechanism to prevent this already exists and must be reused rather than reinvented.**
`ActorEngine.setHomes(placements, byName, animate)` gates on:

```ts
if (!initialized || !animate) { /* seat everyone, no animation */ }
```

The first reconcile seats the room silently; only later reconciles animate arrivals. That is the same
gate the existing door fade and the dog's greeting (`takeArrivals`) already hang off. **The check-in
beat hangs off exactly that gate — session-observed arrivals only.** Whoever is in the first snapshot
walks straight to their desk with no ceremony.

Stated here explicitly because a future pass will otherwise "fix" the missing ritual on load back in.

## Pieces

### Layout (`layout.ts`)

- **`FRONT_DESK`** — a counter near `ENTRANCE` (`lx 47, ly 815`), positioned so it faces arrivals
  without blocking the door swing or the existing queue strip, and so the `RECEPTION` couch/table/
  plant cluster reads as *its* waiting area.
- **`CHECK_IN_MARKS`** — a small set of floor positions in front of the counter, one per simultaneous
  arrival. Parallel, not a line.
- **`RECEPTIONIST`** — her fixed position behind the counter and her facing.
- The desk **blocks nav**, like the bookshelves.

### Painters (`render.ts`)

- **`frontDesk`** — a counter with a **raised transaction ledge** (the ledge is the thing that makes
  a desk read as a *reception* desk rather than a big desk), a monitor turned away from the room, a
  phone, a small plant, and a visitor log.
- The receptionist herself: reuse the existing skeleton/character machinery where it fits, with a
  distinct palette. She is seated behind the counter, so most of the body is occluded — the read is
  head, shoulders and arms, which keeps the cost low.

### Behaviour (`actors.ts`)

- **Asleep when the office is empty.** Slumped, slow breathing. This also fixes how dead the room
  looks with zero seats claimed — it is currently completely still.
- **Wakes on the first arrival**, and stays awake while anyone is present.
- **Awake idles**: types, sips, shuffles paper — sparse, on the same cadence discipline as the desk
  micro-beats.
- **Looks up on the check-in beat**, then returns to idle.
- Goes back to sleep a little after the last member leaves — not instantly, or the transition reads as
  a bug rather than a joke.

## Out of scope

- Any real gating: the beat never blocks presence, never delays the roster, and carries no protocol
  meaning. Nobody can fail to check in.
- Giving her a name, a voice, or dialogue.
- Wiring her to the approval queue or the ADR 098 reception banner. They share a metaphor, not a
  mechanism.
- Sound. Her sounds, if any, belong to spec B's vocabulary.

## Perf

The desk and its props are **static — baked still layer**. Only the receptionist's idle animation and
the check-in beat touch the per-frame loop, and both must suspend with the rest of the scene when the
panel is collapsed or the tab is hidden (the standing rule; the office loop already does this). One
more animated figure on a floor that already animates a dozen is not a new cost class, but the
**sleeping** state must be genuinely cheap — an empty office should not be burning a frame budget on
a still character.

## Testing

`actors.test.ts` and `render.test.ts`:

- **The reload trap:** the first `setHomes` produces **no** check-in beats; a later reconcile adding a
  member produces exactly one.
- Simultaneous arrivals get distinct marks and overlapping (not serialized) beats.
- The beat ends and the member reaches their desk — no arrival can be stranded at the mark.
- The receptionist never appears in the roster, headcount, nameplate set, walk targets or leisure
  spots.
- Sleep/wake follows presence, with the wake on first arrival and a delayed return to sleep.
- Nav: the desk blocks, and no path routes through it.

Visual check per the standing recipe (`vite preview` + CDP; restart preview after every build), at
both `/office-preview` and `/live` scale — including the **empty office**, which is the state this
spec changes most.

## Success check

- The entrance reads as a front desk with a waiting area, not furniture near a door.
- The receptionist is obviously not a member — no plate, never on the floor, distinct look.
- An empty office has someone dozing in it instead of being completely still.
- A member joining pauses, gets acknowledged, and walks on — and it never once happens on a refresh.
