# 133 — The office character is a procedural skeleton, not a Rive rig

- Status: accepted — 2026-07-13
- Date: 2026-07-13

## Context

The `/live` office (ADR 079) draws every member from `public/office/character.riv`, a Rive rig authored
through the Rive Editor MCP and driven by an `officeToRig` input contract (`rig.ts` / `rive-rig.ts`,
spec: `docs/design/office-rive-character-spec.md`). It shipped, it works, and it produced characters
that **glide**: they have arms and legs, and neither ever moves.

That is not a bug in the integration — it is baked into the asset. The spec records why, in its own
as-built notes:

- the `mode` states are **"all keyframed (position-only, to avoid touching bound props)"**;
- the gestures are **"authored as whole-cluster translations so nothing detaches on the flat ungrouped
  rig"**.

The rig is **flat and ungrouped** — it has no joint hierarchy, so there is nothing to bend. Every state
is the whole body translated as a unit. `mode = 1 ("working")` was a _convention_: the code never seated
anyone, so a "seated" member was drawn standing on the floor behind their desk, sunk to the neck. Three
compounding defects, all visible on the live dashboard:

1. **Walkers glide.** No walk cycle exists to play.
2. **Nobody sits.** There is no seated pose and no chair contact anywhere in the scene.
3. **Only the tops of heads show.** The desk stood **46 units tall against a 92-unit character** — taller
   than a seated person's shoulders — and both the desk _and_ the chair were single depth items that a
   member straddled, so whichever side they sorted on, furniture swallowed them.

The obvious move is to fix the rig in Rive. Two things argue against it, and one of them is decisive:

- **The asset is not the artistic asset it would need to be.** The characters are 96-unit flat-shaded
  blocks. There is no hand-crafted vector art to preserve; rebuilding the rig with a real bone hierarchy
  is a from-scratch authoring job either way.
- **The iteration loop is broken.** The MCP cannot export a runtime `.riv` (spec §"Remaining"). Every
  polish pass — and animation quality _is_ polish passes — requires a human to open the Rive editor and
  hand-export over `packages/web/public/office/character.riv`. Animation converged by a human-gated
  round-trip converges slowly or not at all. This is the same reason the hair-colour, hair-style, and
  gesture work has sat "code-side ready, `.riv` side pending" since 2026-07-02.

## Decision

**Retire the Rive rig. Animate the character procedurally, from a skeleton.**

The character becomes two files with a hard line between them:

- **`office-scene/skeleton.ts` — the animation, and no renderer.** `solveSkeleton(input) → Skel` is pure:
  given a member's state (gait phase, sit blend, facing, typing, gesture) it returns **joint positions in
  the character's own 3D space** — x right, y up, z forward, origin at the feet, in the same logical units
  as the floor plan. The walk cycle, the sit, and the typing ripple are expressed as **joint curves**.
- **`office-scene/character.ts` — the painter, and no animation.** It flattens those joints onto the 2:1
  iso canvas, rotates character space by the facing (one skeleton serves all four directions — no mirrored
  art), and depth-sorts the limbs _within_ the character so the near arm swings in front of the torso.

Two properties of the skeleton are load-bearing, and both are the difference between "animated" and
"believable":

- **The gait phase advances with distance travelled, not with wall-clock time.** A stride is a fixed
  length of _floor_ (`STRIDE`), so feet plant on the ground they cover. Driven off a clock instead, the
  legs cycle at a rate unrelated to the body's speed — which is exactly what reads as skating. An urgent
  run's legs cycle faster because the body is _going_ faster, with no separate "run rate" to keep in sync.
- **The legs are solved by inverse kinematics from a foot path, not by swinging bones on a sine.** The
  foot follows a plant-and-lift loop and the knee is whatever angle reaches it, so a foot can never punch
  through the floor to satisfy a curve. The same IK that walks the character also folds it onto a chair.

Sit and stride are **eased blends** (`Pose.sit`, `Pose.stride`), not booleans: a member folds onto the
chair and unfolds off it, and a walker settles out of its stride instead of snapping to attention.

Alongside it, the furniture is corrected so a seated member can actually be seen:

- **The desk height is derived from the seat**, not hand-tuned: `DESK_UP` now lands ~14 units above the
  seated hip (46 → 36), and the keyboard is pulled back to `KEYBOARD_ALONG`, which the skeleton's
  `DESK_REACH.z` is _derived from_ — so tucking the chair in moves the hands with it instead of leaving
  them grasping at air.
- **The chair is two depth items** (`chairBase` / `chairBack`), because a sitter is _inside_ it: the
  cushion they sit on paints before them, the backrest at its own footprint. A seated member's depth key
  comes from the chair, so they land between the two at every facing.
- **A seated member is drawn in two depth slots**: the body at the chair (the desk correctly occludes
  their legs — that is what a desk does), and the **forearms again on top of the desk slab**, because
  their arms are resting on the surface. Without it the hands vanish into the desk and the typing is
  invisible.

## Consequences

- **The office rests less.** A member at a desk who is `working` breathes and types, so their frame
  changes every tick and the scene must keep drawing. This is the trade ADR 086 explicitly deferred ("if
  we later want always-on breathing, it's a deliberate perf trade recorded then") — recorded here. It is
  bounded three ways: the loop is **capped to the ambient ~20fps** when that is the only thing happening,
  it stops dead on a hidden tab or under reduced-motion, and **a room where nobody is working still parks
  at 0 rAF/sec** on the baked frame. Typing is _bursts_ — a member types, then pauses to think — so it is
  also punctuation, not a metronome.
- **`@rive-app/canvas-advanced`, `character.riv`, `rig.ts` and `rive-rig.ts` are deleted**, along with the
  WASM payload and the sprite-cache machinery that existed to make Rive affordable. The code-drawn avatar
  fallback goes too: there is no longer a path that can fail to load.
- **The animation is now testable.** `skeleton.test.ts` pins the things a screenshot cannot check and a
  reviewer cannot eyeball: feet never pass through the floor at any phase, each foot leaves the ground
  exactly once per stride, the arms counter-swing the legs, the seated shoulders and head clear the desk,
  the hands reach the keys within actual arm length, and a half-blend is genuinely between the two poses.
  A rig in a binary asset could be verified by none of these.
- **The 3D door stays open — and this is the point.** A 2:1 iso canvas with painter's-order depth sort
  cannot _become_ real 3D incrementally; that needs a z-buffer and a WebGL renderer. But everything above
  the renderer (`seating`, `actors`, `nav`, `layout`) is already pure floor-space simulation, and the
  character is now a **skeleton emitting joint transforms — exactly what a glTF rig consumes**. A future
  three.js path replaces `character.ts` and binds the same joint curves to real bones on an artist's
  model. The art gets replaced; the walk cycle survives.
- `docs/design/office-rive-character-spec.md` is **superseded** (header added, kept for the archaeology).
  The hair-style / hair-colour items it lists as "`.riv` side pending" are now moot — the painter tints
  hair from the member's own colour directly.
