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

## Two depth bugs, and the instruments that tell them apart (measured 2026-09-14; falsify: re-run the probes below)

Three defects nick reported watching /live were really two different questions wearing the same symptom, and the cost of not separating them is a session spent fixing the wrong one.

**A desk needs two items, and the near one's key depends on who is sitting at it.** The first attempt (#1394) moved the whole desk's key from its centre to its near corner and was reverted (#1400): on an N or W desk the chair is on the NEAR side, so that desk's own sitter also keys past the centre, and a forward slab buried their head and torso. One scalar cannot answer both questions — the passer-by asks "am I in front of the front edge?" and the sitter asks "am I in front of the whole desk?", and they want opposite results from the same comparison.

What works (2026-09-14, shipped; falsify: re-run the four-facing ordering tests in render.test.ts, or seat a member at an N desk and check them head-to-foot): the desk keeps its centre key and everything depending on it (all props, the seated arms overlay) is untouched, and a SECOND item redraws the camera-near half of the slab, keyed at the near corner **except never past this desk's own sitter** (`deskNearDepth`). Same pixels in the same colours, so on empty floor the second pass is invisible; it changes the picture only where a body has landed between the two keys. Two traps, both caught by tests rather than by eye: the near half is `+lx/+ly`, a property of the projection and NOT of `FWD` (on N/W desks the facing points away from the viewer), and the key has to take the sitter as an argument because geometry alone cannot see them. <!-- claim: other -->

**The painter sorts one scalar key per item, and furniture was keyed at its CENTRE.** `depth(lx,ly) = lx+ly`. A desk is 100x68, so its centre sits 84 logical units behind the edge the viewer sees — a member standing plainly in front of that edge still keyed lower than the desk and painted behind it. `nearDepth(lx,ly,w,d)` in iso.ts is the written account of the arithmetic and is deliberately NOT used by the painter — applying it wholesale is what #1394 did. Small near-square items (plants, chairs, the printer) would not benefit anyway: centre and edge agree within a pixel there.

**A carried object was not in the body's own depth sort.** `drawCharacter` collects legs, torso and arms into `parts` and sorts them, then called `drawCarry` *after* the sort — so a laptop tucked under the far arm painted over the back that should hide it. A carried thing is an object at a place, not chrome; it is a sortable part now, keyed on the point `drawCarry` actually draws at.

**Members really do clip the furniture, and `walkable()` cannot tell you that** (2026-09-14, measured; falsify: re-run `floorSamples()` and count `inside` on moving members). `walkable` inflates every footprint by `BODY_R` (14) because it answers a PLANNING question — may a path route here, given a body has width. Use it as a collision test and it over-reports by exactly the inflation: the first measurement came back 1696/3200 samples "blocked" and meant nothing. `insideSolid(lx,ly)` (nav.ts) is the pad-0 collision question, measurement only. <!-- claim: defect -->

Measured on the fixture room over 500 ticks, separating walkers from sitters by whether their position changed between samples:

| | samples | inside the drawn footprint |
| --- | --- | --- |
| moving | 1879 | **302 (16%)** — every walker: Hana 99, Cy 97, Ada 71, Eli 35 |
| still | 2121 | 1617 — correct; a seated member is inside their desk |

So the walkers are inside solid furniture 16% of the time — and then a second measurement said most of it is not a defect at all.

**Separate the episodes, not the samples.** A contiguous run of "inside a footprint" either ENDS AT REST (the member arrived and sat — `findPath` tolerates blocked endpoints by design, and a chair lives inside its own desk's footprint) or EXITS STILL MOVING (the member passed through — the real thing). Over 900 ticks on the fixture room:

| episodes | ended at rest | exited still moving | exited deep (inset > 20) |
| --- | --- | --- | --- |
| 1028 | **986 (96%)** | **42 (4%)** | **8** |

Every clipped footprint was `desk-*` or `chair-*`, i.e. exactly the ones that contain a walk endpoint — nothing else on the floor was ever crossed. So the honest reading is that "members walk through the furniture" was mostly the painter (the desk sorting, since reverted) plus the legitimate last hop into a seat, and the genuine residue is ~4% of episodes.

**The residue is the SEAT HOP, and mostly the way out.** The first and last hops of a route are deliberately unchecked — a chair lives inside its own desk's footprint, so the hop that seats you (or gets you up) has to touch solid geometry, and `clear()` is the inflated planning grid which refuses every cell near a desk. What that hop must not do is cross a DIFFERENT footprint, or cross its own desk's slab to reach a chair on the far side. `nearestFree` chose the endpoint cell by distance alone, so when a chair's aisle is swallowed by the `BODY_R` inflation it could pick a cell across the desk.

Making `nearestFree` prefer a cell whose seat hop is clear at pad 0, measured on the fixture room over 900 ticks:

| | exited still moving | deep (inset > 20) | of those deep, began from rest |
| --- | --- | --- | --- |
| before | 56 | 17 | 21 of 56 overall |
| after | 42 | **8** | **7 of 8** |

So the visible defect — a body crossing a slab — is now 8 episodes, and 7 of them are DEPARTURES: standing up and leaving through the desk rather than round it. Everything else that still registers is a graze: median inset 5 units for 2 samples, a shoulder catching a corner in passing, well under a body width.

Watch the metric you optimise. The same change measured as a share of SAMPLES moves 17% → 15.4% and looks not worth shipping; measured as deep episodes it halves them. Samples are dominated by arrivals, which were never the defect.

Do not raise `BODY_R` as a first move — a larger radius can close narrow gaps the room depends on (desk aisles, the doorway) and strand walkers.

**The probes.** `OfficeHandle.floorSamples()` returns every posed member's logical position with both tests, read from CDP like `ambientLog`. `/character-sheet?carry=laptop|box|plate|bottle|mug|phone` draws the turnaround with something in hand — the sheet hardcoded `carry: null`, so the one defect class that is about FACING was the one class the body-review tool could not draw.

## Ownership

Standing rule (nick): all frontend web UI is miley's, and must be magical/warm/quirky/on-brand — coordinate through the lane, don't restyle in passing.
