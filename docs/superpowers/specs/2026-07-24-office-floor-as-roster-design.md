# Office polish — the floor becomes the roster

Design, 2026-07-24. Approved by nick in-session.

Four independent pieces of office-scene work. They share a package and a perf budget but not a
dependency chain, so they can land in any order.

1. Retire the roster panel — the office floor carries the roster instead.
2. Repaint and socialise the office dog.
3. More variation in seated desk life: neighbour conversations, phone calls.
4. Fix the furniture depth-sort bugs (couch sitter vanishes; walkers read as passing through pieces).

Everything here is inside `packages/web`, so [the perf contract](../../../packages/web/AGENTS.md)
applies: `pnpm perf:check` gates the byte budgets, and any new per-frame work must stop when the
panel is collapsed or the tab is hidden.

---

## 1 · The floor becomes the roster

### Why

`RosterPanel` occupies the middle column of the `/live` grid, roughly 290px. That column is what
squeezes the office into a narrow strip: the room is the point of the page and it is currently
cramped enough that avatars are barely legible.

The floor already _is_ the roster for anyone present — each seat is an avatar with a name label and
a presence dot. What the panel adds beyond that is three things, and only three are wanted:

- who is here right now (the floor already has this),
- who exists but is not here (the floor has none of this today),
- seat kind and role.

Governance chips (`admin`, `wakeable`, `resumable`, `behind`, `disabled`) are not something the panel
gets read for. They move to hover.

### Seat assignment moves to the whole roster

`assignSeats` today filters to present members and hash → linear-probes the 12 desk slots among
them. Offline seats are `gone` and hold nothing, so a freed desk is immediately probeable by someone
else. Desks are therefore stable per _roster composition_, not per seat: your avatar can move desks
because somebody else disconnected.

The new rule: **assign over every seat on the roster, present or not.** A desk belongs to a seat.

There are exactly 12 desks (3 pods × 4) and the dogfood team already has 12 seats, so overflow is a
live concern rather than a hypothetical. The ranking:

1. Present seats claim desks first, in the existing deterministic hash → probe order.
2. Offline seats claim what remains, longest-offline last.
3. Anyone left over goes to the entrance strip, which is the overflow path that already exists.

The invariant this buys: **a present member is never queued at the entrance while an unoccupied desk
sits dark.** That is the one arrangement that would read as broken.

Idle members still take leisure furniture before working members take desks — that inversion is
unchanged, and still means an occupied desk implies work in progress.

### Desk nameplates

Every desk carries a small engraved nameplate on its front edge, in mono:

```
MILEY · agent
```

with the role appended when the seat has one. It paints whether or not somebody is sitting behind
it. This is the "who exists" register; the floating label above a present avatar remains the "right
now" register. An offline seat therefore reads as: empty chair, dark monitor, lit nameplate.

Nameplates belong to the **baked still layer**, not the animated one — they change only when the
roster changes, so they cost nothing per ambient frame.

### Seats past the desk cap

A seat pushed to the entrance strip still gets a name: a **coat-peg row beside the door** carries a
plate per overflow seat. This closes the promise that every seat is somewhere on the floor. It is
the smallest piece of this section and the first thing to cut if it fights the entrance staging.

### What gets deleted

- `packages/web/src/live/RosterPanel.tsx`
- the `roster` panel id, its collapse state, and the middle grid column in `routes/live.tsx`
- the `--col-roster` track and `.lc-roster*` rules in `Live.css`

The reclaimed width goes entirely to the office column.

### Governance on hover

`accountStatusException` and `capabilityBadges` keep their current logic and move into a tooltip
attached to the desk's hit region. Nothing about enforcement changes — the roster surface was always
read-only.

---

## 2 · The dog

### Repaint

Today's dog is a single body colour with a saddle patch. It becomes **white with irregular black
patches**: blobs across the saddle, one over an eye, black ears, black tail keeping its cream tip.
The patches are part of the painter (`drawDog` in `render.ts`), not the behaviour machine — `pet.ts`
still does not know what species it is.

Overall scale goes up roughly **25%**. It is currently small enough to be missed.

### New behaviours

`pet.ts` already carries notice-a-passer-by, greet-an-arrival, follow-a-walker, and
sit-beside-someone-working. Adding:

- **Begging.** While a member carries a plate from the fridge to the lounge, the dog abandons its
  current plan, trails them, and sits facing them for the duration of the meal.
- **Getting petted.** A member walking past a _sitting_ dog pauses ~1.5s and reaches down; the dog's
  tail doubles its wag rate. This is the only new behaviour needing a member-side beat, and it is
  the one that most makes the room feel inhabited.
- **Zoomies.** Rarely, instead of settling, a fast lap of the open floor.
- **Under-desk naps.** Desk footprints join the nap-spot pool, so the dog sometimes sleeps under an
  occupied desk.

The rest-model contract holds: a sleeping dog is a static pose and `stepPet` keeps returning whether
the loop is still needed. Zoomies and begging are awake states and must terminate back into sleep.

---

## 3 · Desk-life variation

### Neighbour conversations

A pod is two rows of two desks; the same-row pair are left/right neighbours. When both are seated
and working, occasionally they swivel toward each other, exchange alternating talk gestures for
**5–10s**, then swivel back to their monitors.

The swivel uses the existing eased `heading` on `Pose`, so it reads as a turn rather than a snap.
The beat is ambient: a real act preempts it, exactly like the existing coffee stroll.

### The phone call

A new errand on the existing ambient-beat scheduler:

1. Stand up from the desk.
2. Phone to ear — a new `CarryKind: 'phone'`.
3. **Pace**: a wandering 3–5 waypoint loop through open floor, 20–35s. Deliberately without a
   destination — the aimlessness is what makes it read as a call rather than a trip.
4. Pocket the phone, return to the desk, sit.

Like the other errands it derives its props from the current leg, so preemption at any step tidies
up by construction.

---

## 4 · The furniture depth-sort bugs

Two reported symptoms:

- a member who sits on the lounge couch to eat disappears, and reappears on standing;
- members read as walking _through_ the fridge, and through other furniture.

**Hypothesis: one root cause, not two.** The couch-sit uses `Pose.depthAt` to composite-sort the
sitter at the couch's floor position; the likely failure is the couch winning that tie and painting
over the member. A walker reading as "through" a piece is the same family — sorted behind something
it is in front of — rather than a navigation failure, since `nav.ts` does block all of this
furniture in its grid.

This is a hypothesis, not a diagnosis. Confirm which it is before fixing:

- if it is depth-sort, the fix is in the painter's sort keys;
- if walkers genuinely path through solids, the fix is in `nav.ts` footprints.

Either way the fix must be **general across furniture**, not special-cased to the fridge.

---

## Verification

- Unit tests alongside the changed modules — `seating.test.ts` for the whole-roster assignment and
  the present-beats-offline ranking, `pet.test.ts` for the new behaviours' termination back to
  sleep, `actors.test.ts` for the conversation and phone-call beats.
- Visual verification through `vite preview` plus the `/office-preview` fixture. Never `vite dev`.
- `pnpm perf:check` after build. Nameplates and the coat-peg row are still-layer work and should not
  move the animated frame cost; if the byte budget moves, log the measured cost per ADR 151.
