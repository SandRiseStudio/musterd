# Office room dressing — nameplate, whiteboard, shelves, fixtures, windows, clock

**Date:** 2026-07-30
**Approved by:** nick (in-session)
**Owner:** miley
**Surface:** `packages/web` — `src/live/office-scene/{render,layout}.ts`, `src/live/office-scene/index.ts`, `src/live/Live.css`
**Spec A of three.** Siblings: [life, motion & sound](./2026-07-30-office-life-motion-sound-design.md) (B), [reception](./2026-07-30-office-reception-design.md) (C).
**Supersedes** the whiteboard section (§3) of [office presence chrome](./2026-07-30-office-presence-chrome-design.md); its nameplate section (§1) is amended here.

## Problem

The office scene shipped its furniture and set dressing in bulk, and bulk shows. Nick's read
(2026-07-30), item by item: the nameplate is muddy and too wide; the whiteboard doodle is crowded;
every bookshelf is identical; the kitchenette is undersized; the hanging planter is flat; there are
only two pieces of art; the lounge and huddle furniture is welded together; the meeting table has no
conference phone; all four windows are the same; the clock has no numbers.

The through-line: **the room is uniform where a real room is varied, and dense where a real room
breathes.** Almost every fix is variation or spacing, not new machinery.

## The constraint that shapes everything

The office fits at **scale ≈ 0.52 on `/live`**. Logical units are roughly half a screen pixel each.
That is the single fact that decides how much detail is worth drawing:

| Thing | Logical | On `/live` |
| --- | --- | --- |
| Clock face | `R = 25` | ~26 px across |
| Book spine | `8 × 13` | ~4 × 7 px |
| Desk | `100 × 68` | ~52 × 35 px |

**Rule for this pass: nothing below ~10 logical units may carry meaning.** Detail under that
threshold is texture — it must read as *character* at `/live` and resolve into its intended form on
`/broadcast` and `/office-preview`, where the scale is larger. Marks that only work up close are
wasted; marks that turn to hash at `/live` are worse than nothing (that is exactly the whiteboard
bug).

## Perf

The `packages/web` contract (ADR 151) applies. **Everything in this spec is static set dressing and
belongs on the baked still layer** — none of it may enter the per-frame loop. No new dependencies;
all of it is existing canvas primitives (`box`, `quad`, `ellipse`, `wallRect`, `wallDisc`). Byte cost
is code only; run `pnpm perf:check` and log if a budget moves.

**Trap (carried forward):** `vite preview` caches `dist` at start — restart it after every build or
pages go blank with 404'd chunks.

---

## 1 · Nameplate (amends presence-chrome §1)

**Problem:** one wide pill — `● name · harness · model` — with the meta at 8px in `#8a6508`, a muddy
olive on warm paper. Too wide over each head, and the secondary ink reads dirty.

**Shape:** two tight stacked lines.

```
● miley
opus 5
```

- **Line 1:** posture dot + name, `--lc-paper-ink`, bold. Unchanged in weight.
- **Line 2:** short model label only. **Harness leaves the always-on plate** — it is the least
  surprising field (nearly everyone is on the same one), so it earns its place on hover, not over
  every head.
- **Ink:** the model line uses `--lc-paper-ink` at reduced alpha — the *same hue* at lower alpha,
  which is the rule `Live.css` already states for softer inks ("grey on warm paper reads dirty";
  `#8a6508` was a third hue and failed the same way). Re-check AA on the darkened paper stock.
- **Delete** the mustard `·` separator element (`.lc-gl-label__sep`).
- **Width:** drop `max-width` from `16rem`. The plate should not exceed roughly a desk's screen
  width; truncate the model label with ellipsis before it does.

**Hover/focus** (unchanged intent, now carrying more): full surface/harness, full model id, role
when non-empty, optional workspace. Identity only — never the lane title.

**Not on the plate:** lane title, progress, governance chips. The work stack (`WorkStack.tsx`) keeps
that job.

---

## 2 · Whiteboard

**Problem:** the doodle is a crowding failure caused by scale. Shapes rendered at ~half size under
wall shear collapse into hash.

### Baseline — read this before starting

A denser second cut of this board existed as uncommitted work and was **discarded on nick's call**
(2026-07-30). It was landscape `112×68`, frameless with a hairline rim, carried an iso marker tray
with three markers and an eraser, and drew six objects with four text labels (`api` / `web` / `db` /
`cdn`, the last two at 5.5 logical units — about 3 px at `/live`). That density is the complaint.

It is recoverable at `git stash` — *"whiteboard v2 from stopped agent"* — if the tray is ever wanted
back. **Do not restore it wholesale.**

So the baseline to build from is the committed painter: **portrait `92×80`, framed**, with two boxes,
a connector arrow, a cylinder and a cloud — five objects, no labels, no tray.

### Fix — subtract

- **Three shapes, two arrows, at most one label.** The current five objects come down to three.
- Every mark ≥ ~10 logical units; stroke weight up so lines survive the downscale. Any label that
  cannot be set at ≥ 10 units is cut, not shrunk.
- Majority of the board stays **white**. Mostly negative space with a small diagram in it — which is
  also what a real whiteboard mid-week looks like.
- **Keep portrait and keep the frame.** The tall geometry is the documented iso-shear constraint for
  this wall (a wide board shears its bands into diagonals), and the frame matches the other wall
  objects. Landscape and frameless were part of the discarded cut and are not adopted here.
- Marker ink stays musterd orange; the no-roster rule is unchanged (presence-chrome §3).
- **A tray is optional and out of scope for this pass.** If it comes back later it is a separate,
  additive change — it was never the problem.

**Acceptance:** at `/live` fitted scale the diagram reads as *a diagram* — you can count the shapes.
If you cannot count them, cut one more.

---

## 3 · Bookshelves and their books

### 3.1 Carcasses

`SHELF_LONG / SHELF_DEEP / SHELF_H` are module constants (58 / 20 / 66), so all four units are
identical. **Move the dimensions onto each `Bookshelf` entry** in `BOOKSHELVES`, with the current
values as defaults, and give the four units three archetypes:

| Archetype | Shape | Note |
| --- | --- | --- |
| **Tall narrow** | shorter along the wall, taller | reads as a bookcase |
| **Low wide** | long along the wall, credenza height | its top becomes a real surface |
| **Standard** | roughly today's box | the baseline the others vary from |

Style variation beyond size: vary the shelf-band count with height, and vary carcass tone slightly
between units (a room accumulates furniture; it does not buy a matched set).

### 3.2 Shelf-top decor

Each unit gets **one** object on top, chosen per unit — not a random shuffle, a deliberate set:

- a trailing plant
- a leaning framed photo (leaning, not hung — leaning is what makes it read as *placed*)
- a stack of horizontal books
- a small trophy or a mug someone left

The low-wide unit is the one that most rewards this: its top is at a height where an object reads.

### 3.3 The reversed shelf

**One unit on the right wall** is shelved spine-in — page-edges facing the room. Rendered as a pale
cream block where the others are colored spines. It should read, correctly and without comment, as
somebody having done that wrong.

### 3.4 The books themselves

Today: 5 books per row × 3 rows, all `8 × 3 × 13`, cycling six colors. Uniform in every dimension.

- **Size variation.** Width ~5–11 and height ~10–16 logical units, varied per book. Vary the count
  per row with the widths so rows stay full rather than gapped. Bigger books are also what make the
  spine marks below possible at all.
- **Color.** Widen the palette and explicitly include **white and black** spines — a shelf of only
  saturated mid-tones is the tell that a palette was picked rather than accumulated. Keep the warm
  bias; white and black are the punctuation, not the body.
- **Lean.** A few books per shelf tilt a small angle off vertical, resting against their neighbour —
  which means a leaning book needs a gap on its lean side. Most books stay upright; the lean is
  seasoning. This is the single highest-value item in §3, because uniform verticals are what make
  the current shelves read as a texture swatch rather than as books.
- **Spine titles.** A spine is ~4 × 7 px at `/live`, so **real glyphs are not on the table there**.
  Titles are rendered as **procedural lettering marks**: one or two short horizontal bars at a
  consistent cap-height fraction, in an ink lighter or darker than the spine. At `/live` this reads
  unmistakably as *lettering seen across a room*; at `/broadcast` and `/office-preview` scale it
  resolves into type-like texture. Actual glyphs only on a book wide enough to survive measurement —
  and only if a measured pass says they do.

  *State plainly in the painter's comment why these are marks and not strings*, or the next pass
  "fixes" them into unreadable text.

**Determinism:** all per-book variation is seeded from the shelf index and book index (the
`deskRnd`/`scrRnd` pattern already in `render.ts`), never `Math.random()` — this is baked-layer
content and must be identical across repaints.

---

## 4 · Kitchenette scale

**Problem:** the sink and counter read small beside 100-unit desks.

Scale the nook fixtures up so the run reads as a galley kitchen:

- Longer counter run and a deeper sink basin.
- An **upper cabinet band** on the wall above the counter — the strongest single cue that this is a
  kitchen and not a table with a bowl on it.
- Taller coffee machine; re-check the fridge and cooler against the new run so the cluster stays
  proportionate to itself.

Constraint: the nook's leisure spots and nav must still work — check `NOOK_SPOTS`, `SINK_STAND`,
`COFFEE_STAND`, `FRIDGE_STAND`, `COOLER_STAND` against the new footprints so nobody stands inside a
counter.

---

## 5 · Hanging planter

**Problem:** it reads flat — a silhouette, not an object.

Give it what `drawPlant` already has and it does not:

- A **tapered vessel** with a visible **rim ellipse** — the rim is what states "this is a container
  with an opening," and it is the single mark that kills the flatness.
- **Interior shadow** just inside the rim.
- **Cords converging** to a ceiling point in perspective, not parallel lines.
- **Depth-sorted trailing foliage** — leaves in front of and behind the vessel, shaded differently,
  rather than one flat fan.

---

## 6 · Art

**Problem:** two identical framed pieces.

Go to **six**, varied in three independent ways — size, orientation, and treatment:

- A **salon cluster of three** small pieces hung as a group.
- One **large landscape** piece.
- One **leaning canvas** on a bookshelf top (ties into §3.2 — leaning reads as placed, and it breaks
  the "everything is hung at one height" grid).
- Treatments differ: an abstract color field, a line drawing, a soft gradient. Frames vary in
  thickness and tone; one piece is unframed.

Spread across both usable walls. **Wall constraint (carried):** `+t` runs screen-left on the
back-left wall, so text mirrors there — the back-right wall is the only one that can carry type.
None of these pieces need type, which keeps both walls available.

---

## 7 · Lounge

**Problem:** the couch, two chairs and coffee table read as one welded assembly.

- **Real gaps** between the seating and the table — a coffee table sits a stride from a couch, not
  against it.
- **Chairs angled toward each other** rather than axis-locked. Furniture arranged for conversation
  points inward; furniture arranged by a layout engine points along the grid.
- **Cushions and a throw** on the couch, breaking its top edge.
- A **tray and books** on the coffee table.

Check `LEISURE_SPOTS` and `MIN_SPOT_GAP` after moving anything — occupants must still land on the
furniture they are sorted with (`depthAt`).

## 8 · Huddle

**Same problem, sharper:** the three poufs are flush against the low table. Currently the poufs sit
at ±52/±54 around a 66-wide table — touching.

- Push the poufs out by a genuine gap.
- **Rotate each a few degrees off-axis**, by different amounts. Used furniture is never square to
  its table; a perfect triangle of chairs is a CAD assembly.
- Widen the rug if the enlarged cluster overruns it.

Same `LEISURE_SPOTS` check as §7.

## 9 · Conference speakerphone

A **starfish speakerphone puck** centred on the `MEETING` table: a low three-lobed body with a
darker speaker grille and **one small LED**. Small, dark, and unmistakable — it is the object that
tells you a table is a conference table.

Static. The LED does not blink (that would put it on the animated layer for no gain).

---

## 10 · Windows

**Problem:** four identical windows. **Constraint from nick: warmer and more magical, but they must
stay believable windows with real utility** — no overdone fantasy.

Four changes, each small:

- **Two mullion patterns** instead of one, alternating.
- **A warm sill on each**, with a small object on two of them — a plant on one, a mug on another.
  Sills are what make a window part of a room rather than a hole in a wall.
- **Per-window sky gradient variation**, consistent with a *single* light direction — windows nearer
  the sun read brighter. This is the change that does the most for "warm" while costing nothing in
  realism, because it is what actually happens.
- **A soft bloom at the head** of each window where the light spills onto the wall.

The existing `drawWindowBeams` floor beams stay; check they still align with the varied brightness.

## 11 · Clock numerals

**Constraint:** the face is `R = 25` → ~26 px on `/live`. Nick's call: **keep the size, design the
numerals as texture.**

- **Hand-lettered wobble numerals** in the same marker-ink character as the whiteboard — drawn
  strokes, not a font. (Canvas type must go through `src/live/canvasFont.ts` tokens; hand-drawn
  numeral strokes sidestep the font question entirely and are the reason this works at all at 26 px.)
- **12 / 3 / 6 / 9 set larger** than the rest. The size difference gives the ring rhythm and weight
  at `/live`, where individual numerals are below the legibility floor — the eye reads the *pattern*
  of four heavy marks and eight light ones as a clock face, which is the whole trick.
- At `/broadcast` and `/office-preview` scale the numerals resolve into legible hand-lettered
  characters, and the quirk lands.
- Existing tick marks are replaced by the numerals, not layered under them.

**Acceptance:** at `/live` the face reads as a clock with a numbered dial (not a blank disc, not
mush). At preview scale the numerals are individually readable and have visible hand character.

---

## Testing

`render.test.ts` is the home for this. Per-item, the checks that are worth having:

- **Nameplate:** the plate carries no harness text; the model line exists and is truncated at the
  cap; the separator element is gone.
- **Determinism:** the same shelf/book seed produces the same geometry twice (guards the
  `Math.random()` regression, which would otherwise flicker the baked layer).
- **Book variation:** across a shelf, spine widths, heights and colors each take more than one value;
  the palette includes a white and a black; at least one book is leaning and at least most are not.
- **Reversed shelf:** exactly one unit renders page-edge fill rather than spines.
- **Shelf carcasses:** the four units do not all share one width/height.
- **Whiteboard:** the mark count is at or under the cap, and no mark is under the 10-unit floor.
- **Clock:** twelve numerals, four of them at the larger size.
- **Nav/spots:** after §4/§7/§8 move furniture, existing layout and seating tests still pass — these
  are the ones that catch an occupant standing inside a counter.

Visual verification per the standing recipe: `vite preview` + CDP against `/office-preview` and
`/live`, at both scales. **Not `vite dev`.** Restart preview after each build.

## Success check

- No two bookshelves, windows, or art pieces are identical.
- The whiteboard diagram is countable at `/live`.
- The kitchenette reads as a kitchen beside a desk.
- The hanging planter reads as a container with something growing out of it.
- The lounge and huddle read as furniture someone arranged, not furniture a grid placed.
- The clock reads as a numbered dial at `/live` and is charming up close.
- The nameplate is narrower than a desk and its second line is not muddy.
