# Where a canvas scene's time actually goes

Profiling the office on 2026-09-17 found the JS was never the cost — a GPU laptop and a GPU-less server disagree by 11x on the same draw, and what separates them is rasterization, which makes "how many pixels changed" the only number that predicts the server.

Context: the office scene (`packages/web/src/live/office-scene/`) renders `/live` in a viewer's browser and `/broadcast` on a rented Fly `performance-4x` ([broadcast stream](broadcast-stream.md), ADR 157). The lessons are about canvas 2D on two very different machines, not about the office.

## A GPU laptop cannot price a software rasterizer, and the gap is 11x (2026-09-17; falsify: run `/broadcast?team=<slug>&fps=20` on a `performance-4x` with a CPU profile attached and read JS self-time as a share of the draw — a share near this laptop's means the gap is clock, not raster) <!-- claim: other -->

The same page, the same bundle, the same 1920x1080 stage at DPR 1: **~5 ms per draw (p95) on an M-series laptop, 56.1 ms on the box.** Canvas 2D is GPU-backed on macOS and software-rasterized on the box, which has no GPU. Every fill, gradient and glyph that costs the laptop a command buffer entry costs the box real CPU cycles filling pixels.

The consequence is a rule for choosing cuts: **a cut that removes JS work cannot move a software rasterizer, and a cut that removes rasterized pixels moves it nearly 1:1.** A profile taken on the laptop ranks the JS honestly and says nothing about the rest.

It also means a *laptop* A/B of a rasterization change reads low by construction. The office sprite cache measured ~15% on this laptop (PR #1550, unmerged — its own wiki page lands with it), and a blit-versus-rasterize comparison is close to a wash when a GPU does both — so that 15% was never the stream's number, in either direction. What it is worth on the box is still unmeasured.

## The JS micro-optimizations were all worth nothing, including the one that looked certain (2026-09-17; falsify: re-run the interleaved A/B below with the guard and read whether the arms separate by more than their own spread) <!-- claim: other -->

Profile of `/broadcast` (production bundle off the daemon, real team data, 20.0 draws/s, loop never parked, 96 s): **64% idle**, and JS self-time of roughly **1.4 ms per draw**. Ranked, the top entries were `set font` 2.4 s, `fill` 1.8 s, and the largest single application function 1.3 s — over the whole 96 s.

`ctx.font` looked like the certain win. The scene assigns it **80 times per draw across only 25 distinct values**, and the canvas font setter re-parses the CSS shorthand on every assignment; `canvasFont()` (`packages/web/src/live/canvasFont.ts`) caches the resolved *stack* but nothing guards the assignment. Interleaved A/B/A/B on one page, a last-value guard on the prototype descriptor:

| arm | mean rAF callback, ms |
|---|---|
| direct | 1.463, 1.437 |
| guarded | 1.430, 1.391 |

The arms overlap. Gradient allocation — the other candidate, 10 `create*Gradient` sites with several inside per-item loops — was `createRadialGradient` 0.22 s plus `addColorStop` 0.30 s of the same 96 s.

The generalisation worth keeping: **when JS is a single-digit percentage of a frame, the ranked profile is still true and still useless.** Its top entry is the top entry of something that does not matter. Check what share of the frame the profiler can even see before optimizing what it shows you.

## The office repaints 1,377,600 pixels to change about 13,000 (2026-09-17; falsify: diff consecutive `getImageData` frames on `/broadcast` and read the median changed share — a median near the bounding box's ~30% would mean damage is diffuse and dirty rects cannot pay) <!-- claim: other -->

**Corrected 2026-09-18:** ~~1,377,600 pixels~~ in the heading is wrong (headings are what `wiki:check` tracks sections by, so it stays as written and the correction lives here). The stage is 1920x1080 at DPR 1 = **2,073,600** device px, read back from the canvas itself on the bench box (`__clipProbe().stage`). The shares below were always ratios of the full stage and never depended on the absolute figure.

Sixty consecutive frame pairs on a live room, full-stage `getImageData` diff at 1920x1080:

| | changed share of stage |
|---|---|
| median | 0.97% |
| p90 | 1.2% |
| frames under 1% | 35 of 60 |
| frames over 10% | 1 of 60 (48.1%) |

The room is static and the actors are small. The **bounding box** of the changed pixels is ~30% of the stage even on frames where 0.3% changed, so a single damage rectangle is worth ~70% and per-region tracking is worth far more.

This is the number that makes dirty-rect damage tracking the cut that fits a held pixel-identical bar: pixels that are not redrawn are byte-identical, with no second composite — which is precisely what the sprite cache (PR #1550) could not offer, because a blit *is* a second composite. The open risks are antialiasing at clip boundaries (~~`pnpm scene:pixel-check` is the instrument~~ — corrected 2026-09-18: that script exists only on the unmerged #1550 branch, and `main` has no pixel-identity instrument yet; the dirty-rect lane has to land one before it can claim byte-identity), the occasional wholesale repaint, and threading damage through a 4,808-line renderer.

## Two thirds of the frame survives a clip that paints nothing, so the cost is per-op, not per-pixel (2026-09-18; falsify: clip `/broadcast` to a scatter of rects totalling 0.01% of the stage, time the draw with a `getImageData` readback inside the timed region, and compare with unclipped — a clipped draw near 1% of the unclipped cost would mean the cost really is the pixels) <!-- claim: other -->

The claim above says damage is ~1% of the stage and concludes dirty rects should pay ~1:1. **The first half is right and the conclusion is wrong.** Measured on a `performance-4x` against a populated room (7 posed), `/broadcast?fps=20` at 1920x1080 DPR 1, ten actor-sized clip rects, `beats` delta 0 on every arm, arms run strictly sequentially:

| clip coverage | median ms | vs unclipped |
|---|---|---|
| 100% (unclipped) | 50.7 | 100% |
| 30% | 45.6 | 90% |
| 5% | 40.9 | 81% |
| 1% | 37.5 | 74% |
| 0.01% | 33.9 | 67% |
| flush only, no scene | 0.1 | — |

**~34 of ~51 ms is area-independent.** Only ~16 ms scales with the pixels covered. That residue is Skia's per-operation cost — every path built, every clip tested, every shader set up — paid whether or not a single pixel of that op lands inside the clip. So a cut that removes *painted area* is capped at about a quarter of the frame, and dirty-rect damage tracking alone cannot reach 20 fps on this box (2026-09-18; falsify: implement damage tracking and read `stats().draws` over a minute at `fps=20` — 20 draws/s sustained from the clip alone falsifies this). <!-- claim: defect -->

The flush-only arm is what makes the floor readable rather than suspicious: it prices the `getImageData` readback at 0.1 ms, so the 33.9 ms is the room, not the instrument.

**The readback is load-bearing and the measurement is worthless without it.** Canvas 2D queues its draw calls. Timing them with `performance.now()` alone measures how fast JS can *submit* work — about 1.4 ms here — and reports every arm as identical no matter what the rasterizer does.

## The two cuts compose, and only together do they reach 20 fps (2026-09-18; falsify: run `/broadcast?fps=20&sprites=1` with and without a 1% clip, interleaved on one box, and read `stats().draws` — if the clipped arm does not beat the unclipped one by more than the arms' own spread, they do not stack) <!-- claim: other -->

Same box, same room, interleaved at the stream's own `fps=20` against a 20 fps cap:

| build | ms/draw | draws/s |
|---|---|---|
| stock | 71.5 | 14.00 |
| sprite cache (`&sprites=1`, PR #1550) | 57.4 | 17.42 |
| sprite cache + 1% clip | 23.6 | 19.2 |
| sprite cache, unclipped control | 33.7 / 33.6 | 17.4 / 17.8 |

The two unclipped controls agree to 0.1 ms, so the clipped arm is not box drift. They stack because **they remove different costs**: the sprite cache collapses hundreds of static-furniture ops into one `drawImage`, which is the per-op residue above; the clip removes painted area, which is the ~16 ms that scales. Neither alone clears the bar; together they leave 23.6 ms against a 50 ms budget.

**This is an optimistic bound, not a shipping number.** The 1% clip here is synthetic — a fixed scatter of rects with no damage tracking behind it. Real damage is median 0.97% but p90 1.2%, and 1 frame in 60 changes 48% of the stage and costs the full 33.6 ms. A real dirty-rect implementation lands **between 17.4 and 19.2 draws/s**, not at 19.2.

**Speed was never the open question anyway.** The sprite cache's fidelity is: its parity run recorded 4,028 pixels beyond rounding at a maximum delta of 88/255, and that run was taken on a GPU laptop against `/office-preview`'s 1,377,600-pixel canvas — not the stream's 2,073,600. On-box parity is still unmeasured, because `OfficeHandle.spriteParity()` is `import.meta.env.DEV`-only and is compiled out of the production build the box serves.

## Method notes

- `/broadcast` pins DPR to 1 and keeps animating unseen, so a laptop paints the **same 1920x1080 backing store** the box does. `/office-preview` does not — on a retina laptop it renders at DPR 2, which is 4x the pixels and not comparable.
- `beats` in `window.__office.stats()` only ticks once the rAF loop has **parked**. A `beats` delta of 0 across the measurement window is what proves the room was live; every draw metric reads plausibly while a parked loop makes them meaningless.
- Profile against the daemon's own origin (`:4849`), not `vite preview`: the daemon serves the production bundle *and* proxies the live data, and `vite preview` carries no proxy — the proxy config lives under `server:`, which is dev only.
- A 96 s trace is ~149 MB on disk. Delete it when done.
- **The bench fixture drew an empty room until 2026-09-18.** `scripts/perf/broadcast-bench-fixture.sh` claimed each seat with a plain `musterd claim`, which binds the folder and exits — and under ADR 377 the Presence dies with the process. Every seat read `offline` and the scene painted bare furniture. Seats now hold `inbox --watch` open for the fixture's lifetime; check `curl /teams/<team>/members` for presence, and `__office.floorSamples().length` for posed actors, before trusting any number.
- **Nothing unclipped may touch the canvas while measuring a clip.** `drawStatic` blits the baked buffer over the whole canvas on a resting frame, which silently repaints everything a clipped `drawDynamic` just left alone — enough to make a clip look like it did nothing.

## Related

- [broadcast stream](broadcast-stream.md) — where the 56.1 ms/draw and the stream's topology come from.
- `docs/wiki/canvas-sprite-caching.md` on PR #1550 — the cut this profile reprices, and what a blit costs in fidelity. Link it here when that PR lands. Its speed on the box is measured above; its fidelity on the box is not.
