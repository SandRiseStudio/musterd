# Office polish — the floor becomes the roster

Design, 2026-07-24. Approved by nick in-session.

Four independent pieces of office-scene work. They share a package and a perf budget but not a
dependency chain, so they can land in any order.

1. Retire the roster panel — the office floor carries the roster instead. **(remaining)**
2. Repaint and socialise the office dog. _(landed)_
3. More variation in seated desk life: neighbour conversations, phone calls. _(landed)_
4. Fix the furniture depth-sort bugs (couch sitter vanishes; walkers read as passing through pieces).
   _(landed — and it turned out to be three defects, not one; see that section)_
5. The petting pose — a member stops to pet the dog. **(remaining)** Split out of piece 2 once it was
   clear it needs a new pose in the skeleton solver rather than wiring.

Everything here is inside `packages/web`, so [the perf contract](../../../packages/web/AGENTS.md)
applies: `pnpm perf:check` gates the byte budgets, and any new per-frame work must stop when the
panel is collapsed or the tab is hidden.

---

## Status, 2026-07-24

Pieces 2, 3 and 4 have landed on `feat/office-floor-as-roster` (lane
`01KYB5KAP5H0RHJWXN5W0JT1TK`), five commits, branched from `origin/main` at `a30d5df`:

|     | commit    |                                                         |
| --- | --------- | ------------------------------------------------------- |
| 4   | `8220ecd` | walkers stop passing through the furniture              |
| 4   | `dcaeefa` | meeting table reseated so all four chairs are reachable |
| 2   | `0b6f10d` | dog repainted white-with-black-patches, 25% bigger      |
| 2   | `9d61bce` | dog zoomies, desk-side naps, begging                    |
| 3   | `5c92568` | neighbour conversations, phone calls                    |

296 tests pass; lint, typecheck and `pnpm perf:check` clean (JS gzip 225.8 KB of 244.1 KB).

**Remaining, and the subject of the next session:** piece 1 below (the floor becomes the roster), and
piece 5 (the petting pose), which was deferred out of piece 2 because it needs animation authoring in
the skeleton solver rather than wiring.

Nick's standing brief for all of it: _magical, fun, warm, quirky, smooth, responsive_ — and nothing in
the office is set in stone, including the floor plan. The meeting corner was reworked under exactly
that licence rather than shipping two seats nobody could sit in.

### Where to pick up

- Branch `feat/office-floor-as-roster` is **local only** — decide whether to PR the five landed
  commits before starting, or carry on and PR the lot. The ADR 106 loop is branch from fresh main →
  PR → `gh pr merge --squash --auto --delete-branch`.
- `/office-preview` is the verification fixture. `?quiet` stops the looping act script;
  `?beat=fridge|water|coffee|phone|<gesture number>` fires a beat at mount and every 30s; the toolbar
  has a button per beat. Verify through `vite preview` (`.claude/launch.json` → `web-preview`),
  **never** `vite dev`.
- Traps hit this session, all still live: `pnpm --filter @musterd/web build` must be re-run _and the
  preview server restarted_ or the served HTML references stale chunk hashes and the page renders
  blank. Browser-pane `javascript_tool` sometimes resolves to a different document than the one being
  screenshotted (zero-size rects, a 2×2 canvas) — don't build verification on pixel-sampling; assert
  in unit tests and use screenshots for the look.

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

### Implementation notes gathered since this was written

- **`assignSeats` is in `seating.ts`** and currently filters to present members
  (`sorted.filter((m) => !isGone(m))`) before probing the 12 desk slots. The change is to probe over
  the whole roster with present-before-offline ranking; `Placement` gains nothing, `gone` simply
  stops meaning "holds no desk".
- **Desk-side floor is scarcer than it looks.** A pod's two rows sit footprint-to-footprint across
  their shared screen gap, so a desk has no walkable floor at its front edge — only along its outer
  flank and behind the chair. This bit the dog's nap spots (`pet.ts`, `deskSpots`) and it will bite
  nameplate hit-regions and any coat-peg placement the same way. `nav.test.ts` holds the invariant
  that every offered seat has open floor beside it; extend it rather than working around it.
- **`renderScene` already has the depth machinery** a nameplate needs: `actorSortAnchor` is exported
  and pure, and desks are drawn per `DESK_SLOTS` in the depth-sorted item list. A nameplate is one
  more item at the desk's own depth.
- **The still layer is the right home for nameplates.** The office bakes to an offscreen buffer when
  nothing moves (ADR 086); text that only changes when the roster changes belongs there and then
  costs nothing per ambient frame.

---

## 5 · The petting pose

Deferred out of piece 2 rather than faked. Every other dog behaviour was a wiring job on machinery
that already existed; this one needs a new pose authored in the skeleton solver.

### What it is

A member walking past a **sitting** dog pauses for ~1.5s, crouches slightly and reaches down; the
dog's tail doubles its wag rate for the duration. Then they both carry on. It is the one beat where a
member and the dog acknowledge each other, and it is what will make the room feel inhabited rather
than merely populated.

### Why it is not wiring

`skeleton.ts` has no crouch. The existing gesture vocabulary reaches _up_ (`sip`, `call`), _forward_
(`browse`, `pour`, `fill`) or into the lap (`lean`, `roll`) — all of them upper-body overlays on a
fixed stance. Reaching down to a dog needs the pelvis to drop and the knees to bend, which means
touching the leg IK rather than overlaying an arm.

### Shape of the work

1. **`GESTURE.pet`** in the registry (next free number is 14).
2. **A crouch in `solveSkeleton`**: drop `pelvis.y`, let the existing foot-IK absorb the knee bend
   (the legs are already solved from a foot path, so a lower pelvis should bend the knees for free —
   confirm before authoring anything on top), and take `wrist[1]` down to roughly the dog's head
   height in character space. Hold envelope, not an arc: the pause is the point.
3. **A pause inserted mid-walk.** The actor system has no "stop here for a moment" primitive today.
   The cheapest honest route is to splice a `hold` leg into the in-flight walk at the walker's
   current position — `walks.get(name)` exposes `{legs, i}`, so `legs.splice(i + 1, 0, hold(at, dir,
dur, { overlay: GESTURE.pet }))` inserts the beat without disturbing the route either side. Verify
   that the leg-clocked overlay and the sit/stride blends survive the splice.
4. **The dog's half.** `pet.ts` already turns to face a passer-by (`petNotice`); the addition is a
   faster wag while being petted, which is a painter change (`WAG_HZ` scaled by a flag on `PetState`)
   rather than a new mode.
5. **Triggering.** The office already computes moving walkers each frame for `petNotice`
   (`index.ts`, the `moving` list). Same proximity check, gated on the dog being in `sit` — and
   rate-limited, because a corridor past a sitting dog should not turn into a queue of people
   petting it.

### Where it must not go

Not every passer-by, and never twice in quick succession. The beat is worth having because it is
rare; a room where everyone stops to pet the dog is a room where nobody is working, which inverts
exactly the read the floor exists to give.

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
