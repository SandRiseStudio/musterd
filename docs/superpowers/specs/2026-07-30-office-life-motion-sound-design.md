# Office life — dog volume, and the sound of a room with people in it

**Date:** 2026-07-30
**Approved by:** nick (in-session)
**Owner:** miley
**Surface:** `packages/web` — `src/live/sound.ts`, `src/live/office-scene/render.ts` (dog painters)
**Spec B of three.** Siblings: [room dressing](./2026-07-30-office-room-dressing-design.md) (A),
[reception](./2026-07-30-office-reception-design.md) (C).
**Builds on:** the room-tone layer shipped 2026-07-29 (AIR / HUM / LIFE, `LIFE_GAIN = 34`).

## Problem

Two complaints from nick (2026-07-30):

1. **The dog still looks "a tiny bit paper-ish, 2D-ish" when it walks.**
2. **The typing is too loud and doesn't sound realistic**, the room has no sound for *people being in
   it together*, and the vocabulary of small noises is too thin. Requested additions: chatting and
   whispering when two or more members are present, stapling, a drawer, walking around, drinking
   coffee, blowing on coffee, drinking water, eating — plus sound effects for the dog.

---

## Part 1 · The dog

### Diagnosis (this is not the obvious bug)

The dog already has most of the things one would reach for first, and they landed in earlier passes:
far-side legs in their own shade (`DOG.furFar`), depth-ordered limbs (far legs → body → near legs),
a stride bob, a tail that lags the body by a phase offset, a contact shadow that breathes with the
gait, and a continuous facing mirror rather than a boolean flip. **None of those is the problem.**

The problem is the mirror itself. `drawDog` draws a flat side-profile and applies:

```ts
const m = pet.face >= 0 ? Math.max(pet.face, 0.03) : Math.min(pet.face, -0.03);
ctx.scale(m, 1);
```

A **horizontal squash of a flat shape** is, geometrically, a sheet of paper rotating edge-on. That is
precisely the impression being reported, and it is worst *while walking* because a walking dog turns
constantly, so the viewer spends most of the walk inside the squash range. The crossfade to
`drawDogFacing` rescues the extreme end-on case; the mid-turn range between profile and facing is
where the paper shows.

Two things are missing, and both are about **mass**:

- The torso has no minimum width. In life, a dog seen from any angle is still as wide as its ribcage;
  here the ribcage width goes to 3% of profile width.
- The torso is a flat fill. A shape with no internal value change reads as a cutout no matter how
  well it is animated — animation cannot supply volume that the shading never claims.

### Fix

1. **Torso volume shading.** Top-lit value across the body: a lighter band along the spine, a shaded
   belly, and a soft rim on the lit side. This is the single largest 2D → 3D lever available on a flat
   fill, and it costs nothing at any facing.
2. **Shoulder and haunch mass.** Overlapping forms at shoulder and hip in a slightly different tone
   from the barrel between them — the standard illustrator's fake for a rib cage. It also gives the
   legs somewhere to attach to, which is part of why they currently read as sticks under a shape.
3. **A minimum body depth through the turn.** Blend in a body-width term as `|face| → 0`, so the
   torso narrows toward a *ribcage*, never toward a line. The `0.03` floor exists only to avoid a
   degenerate matrix; it should not be the visual floor.
4. **Widen the crossfade window** into `drawDogFacing`, so less of the turn is spent in the squash
   range at all.

**Do not touch** `pawCycle` or the derived-reach gait — that is a shipped fix (#483) for a different
complaint, and re-adding per-leg easing is a known regression.

### Testing

`pet.test.ts` / `render.test.ts`: the rendered torso width has a floor above the matrix guard across
the full `face` sweep; the crossfade window is wider than the squash floor; shading tones differ
between spine, barrel and belly. Visual check per the standing recipe (`vite preview` + CDP,
`?beat=`, `window.__office`), watching a **turn**, not a straight-line walk — the straight-line walk
is the case that already looks fine.

---

## Part 2 · Sound

### Ground rules (inherited, and load-bearing)

- **Everything rides the existing `lifeBus`** and its `LIFE_GAIN` makeup. Per-event gains stay
  *relative* to each other; the layer's absolute level is that one number. Never scatter compensation
  factors through five synths — that is written into `sound.ts` as the standing rule and it is there
  because this layer shipped inaudible once.
- **Re-measure offline through the same graph** after retuning. The reference readings are peaks
  against a −33.7 dBFS bed, and they carry **±3 dB** — each render draws fresh noise. Do not tune
  finer than that; differences under ~3 dB are not real.
- **No audio assets.** Synthesis only, per the perf contract.
- **Stops dead on a hidden tab.** Every new event goes through the existing `armLife` / visibility
  path; nothing gets its own timer.
- Jitter every parameter per play. A loop the ear can predict is a loop the viewer turns off.

### 2.1 Typing — quieter and rebuilt

Current `keys()` plays a run of single bandpass noise bursts at 1650–2550 Hz, Q 2.2. That is one
transient, and a bright one: measured, a keystroke peaks at −25 against a −33.7 bed, about 9 dB
**above** the room. Both complaints have the same root — it is the loudest event in the layer and it
is only half a keystroke.

- **Two transients per key.** A real keypress is a low *thock* on key-down and a lighter click on
  release, a few tens of ms apart. Add the release transient and drop the down-stroke's body roughly
  an octave. This is what buys realism; the level change alone would just make it quiet and fake.
- **Cut the gain** so typing sits at or just above the bed rather than 9 dB over it. Re-measure; do
  not target a number finer than ±3 dB.
- **Per-run keyboard character.** Jitter the body frequency and the down/up gap *once per run*, not
  per key, so a given burst sounds like one keyboard and successive bursts sound like different
  desks. Currently every keystroke in the office is the same keyboard.

Keep the existing run structure — the uneven rate, the long-run thinking pause. That part works.

### 2.2 Chatter — proximity-gated

Today `murmur()` fires from the shared roll regardless of who is present, which means an empty office
murmurs to itself.

- **Gate:** fires only when **two members are actually near each other** — sharing a pod, both in the
  huddle, or both in the lounge. Not a headcount: a headcount of two at opposite ends of the floor
  is not a conversation.
- **Pan toward the pair's screen position**, rather than the random pan every other event uses. The
  room's sound should match what the eye can see.
- Whispering is the same synth at lower level and a tighter formant band — worth having as a
  variant, since nick asked for "chat or whisper".
- This needs the scene's occupancy to reach the sound engine. Keep the coupling **one-way and thin**:
  the office scene pushes a small summary (pairs and their screen x), the sound engine never reads
  the scene. `sound.ts` must stay independently testable.

The existing `murmur` synth itself — two registers, jittered syllables and contours — is good and
stays.

### 2.3 New events

All join the `life()` roll, all band-limited noise through the shared `click`/burst shapes unless
noted:

| Event | Shape |
| --- | --- |
| **Stapler** | two-stage: a short press, then the sharp *ka-chunk* of the staple setting |
| **Drawer** | a wooden slide (filtered noise swell over ~0.4 s) into a hard stop |
| **Footsteps** | paced pairs of soft low thuds, panning as they cross — the pan drift is the whole effect |
| **Coffee sip** | a short liquid intake, higher and lighter than a swallow |
| **Blowing on coffee** | a breath swell — wideband noise through a slow-opening lowpass, no transient |
| **Water** | a lower, wetter swallow than the coffee sip |
| **Eating** | soft irregular crunches at an uneven rate |

Rebalance the `life()` roll so the additions do not swamp typing and talk. Work and conversation stay
the majority of the mix; these are seasoning. Several of these are *desk* sounds and could later be
tied to the props that already exist (`deskCoffee`, `deskWater`) — **not in this pass**; positional
prop-tied audio is a bigger idea than a sound vocabulary.

### 2.4 Dog sounds

Gated on the dog being present, panned to its position, and tied to its mode where it matters:

- **Padding paws** while walking — very soft, on the gait phase.
- **A collar-jingle shake** occasionally: a short cluster of tiny bright transients (the dog wears a
  mustard collar already).
- **A yawn** — a breath swell with a small pitch contour.
- **A single quiet bark**, rare. Rare is the entire design: a bark on a timer becomes an alarm clock.

### Testing

`sound.ts` is currently untested; this pass adds `sound.test.ts` covering the parts that are logic
rather than audio:

- The event roll respects its weights and includes every new event.
- The chatter gate: no murmur with zero or one member, none with two distant members, murmur with
  two co-located ones; pan follows the pair.
- Dog events do not fire with no dog present.
- Nothing schedules while `document.hidden`.
- Per-run keyboard parameters are constant within a run and vary between runs.

The **levels** are verified by offline render through the same graph, per the file's standing method,
and the measured peaks recorded in the source comment alongside the existing table — that comment is
the only record of how this layer is calibrated.

## Success check

- The dog reads as an animal with a rib cage through a turn, not a sheet of paper.
- Typing sounds like a keyboard and sits *in* the room rather than on top of it.
- Two people near each other produce conversation from the right side of the screen; an empty office
  does not talk to itself.
- The room's noises are varied enough that ten minutes in, none of them is predictable.
