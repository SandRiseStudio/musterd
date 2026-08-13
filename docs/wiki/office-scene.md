# The office scene — reference, ceilings, and layout traps

The /live isometric office derives from a specific Figma asset pack with a measured palette, and its hard constraint is scale: at office fit-scales the room's entire back wall is ~63–74px tall, so canvas type in the room is only viable for 2–3 glyphs.

## The reference (nick's canonical, 2026-07-29; falsify: fetch the design URL)

Figma fileKey `NXNGjVDkhlqyNj9X9e2ZBj`, room scene node `3:30`. The community URL form (`figma.com/community/file/<id>`) is NOT fetchable — 403, and the id is not a fileKey; only the `/design/` URL works. Measured palette: floor `#f9b953`, wood `#9e581c`, cream `#fce6bc`, 87 % warm pixels with a single blue rug carrying the whole cool accent. Deliberately NOT copied (settled, not backlog): gradient shading/AO/bevels (fights the flat canvas aesthetic and the perf contract), `--wall` changes (paper-chrome contrast was tuned against that exact cream), global corner rounding.

## The scale ceiling (measured 2026-07-29 at 1280px; falsify: re-measure fitFloor on /live)

Office column 456px → scale ~0.34 → back wall 63px tall; 12 seats would get 5.3px per row where legible type needs ~12. Removing windows buys width; the shortage is height. Consequence, settled: roster names live in `OfficeBoard.tsx`, a DOM noticeboard under the room (type independent of fit scale); canvas type is for the wall clock and counts only.

## Layout traps

- **The office panel has THREE shapes that disagree about which fit limit binds** (2026-07-30, #533/#534): three-column is width-limited, both-panels-collapsed is height-limited, /broadcast is full-bleed. A stage aspect-lock verified only in one shape shrank another 26 %. The settled rule: the band is content-sized and the stage takes every remaining pixel (can never shrink the room); measure at 1280 three-column AND ~2000 collapsed before shipping office layout changes. Band framing is opt-in via `bandSlot` — /broadcast stays full-bleed.
- **`.lc-board*` belongs to the /board route** — office noticeboard classes are `.lc-notice*`; a new office class once silently inherited /board's grid and would not stretch.
- **Sub-pixel grid overflow raises a scrollbar on a board that visibly fits** — `minmax(w, 0.34fr)` sums over 1fr; use fixed tracks + `overflow-x: hidden`.

## Ownership

Standing rule (nick): all frontend web UI is miley's, and must be magical/warm/quirky/on-brand — coordinate through the lane, don't restyle in passing.
