# Office walls & windows

Status: spec (2026-07-14) · Owner: web/live · Relates to: ADR 079 (isometric office), the lighting model
(`office-scene/lighting.ts`), ADR 133/142 (character), #270 (floor pods).

> This captures a decision Nick and I reached in a working session on **2026-07-11** — during the office
> **lighting** work — that was agreed but never built. The lighting shipped; the room it was meant to
> shine into did not. Nick's original question, verbatim: _"do we need walls, windows and ceiling as
> well?"_

## The decision (2026-07-11)

- **Ceiling — no. Never.** The office is a bird's-eye orthographic view; a ceiling would occlude the entire
  room. This is _why_ the overhead lights are pools of light on the floor, not fixtures you can see
  (`lighting.ts` `overheadOn`). Nothing to build.
- **Walls — yes, but only the two the iso already exposes:** the back-left and back-right edges of the
  floor diamond. Two short back walls give the room a **boundary** instead of furniture floating on a
  diamond, and — the real reason — they **give windows somewhere to live**. The commit history was already
  reaching for this: #234 "seat the door flush in the back-left wall" describes a wall that does not exist
  (the door is a freestanding glass panel). The `--wall` design token has sat unused since.
- **Windows — the actual payoff.** A window is the one element that is _both_ a visible object _and_ the
  natural-light source, so it justifies the whole exercise. Put windows in the back walls and cast a **warm
  angled light-parallelogram across the floor** from each, its colour and strength driven by the existing
  PST day-cycle (`LightEnv.skyTint` / `.skyStrength` / `.daylight`). Morning is long and amber, midday
  short and white, night dark — the daylight overlay finally has a _source_ on screen.

## What's already there to build on

The lighting model is done and is the single source of truth — **do not add a second one.** Windows read
from `LightEnv` exactly like the desk lamps and the night veil already do:

- `env.daylight` 0..1, `env.skyTint` (warm→cool rgb), `env.skyStrength` — drive the glass colour + the
  floor beam.
- `env.veilAlpha` / `env.veilColor` — the night veil already paints over the whole canvas in
  `drawInteriorLight`, so walls and windows darken at night for free.
- `env.overheadOn` — could tint the interior wall face when the ceiling fill is on (optional polish).

## Geometry (the part that needs care)

The floor diamond's **back corner is `(0,0)`** (top of screen). The two back walls rise from the two upper
edges meeting there:

- **back-right wall** — the `ly = 0` edge, `lx` from `0 → FLOOR`.
- **back-left wall** — the `lx = 0` edge, `ly` from `0 → FLOOR` (the door at `ENTRANCE` sits in this one).

Both walls are drawn **once, as a backdrop, immediately after `drawFloor` and before the depth-sorted
items** — _not_ as depth-sorted items. A wall spans many depths (it is one plane), so it cannot take a
single depth key; but nothing on the floor is ever _behind_ the back edges, so a backdrop drawn first and
painted over by every furniture piece and character is correct at every position. The floor light-beams are
likewise drawn on the floor before the items, so furniture correctly sits _on_ the light.

Shade the two wall faces like `box()` does its side faces (left face one step darker than right), so the
walls sit in the same implied light as the furniture.

## Acceptance

- The room reads as an interior with a back-left + back-right wall and 1–2 windows per wall.
- A warm daylight parallelogram falls from each window across the floor, **driven by real PST time** — long
  and amber at golden hour, short and white at midday, gone at night.
- At night the windows go dark and the veil covers everything (no beam) — consistent with the existing
  lamp/veil behaviour; an empty night office still reads dark.
- No depth-sort artefacts: furniture and characters always paint over the back walls; the beams sit under
  the furniture.
- The door (`drawEntrance`) reads as _set into_ the back-left wall, not floating in front of it.
- Theme-aware: the wall colour comes from the `--wall` token (like `--floor`/`--wood`), with a fallback.
- Gates green.
