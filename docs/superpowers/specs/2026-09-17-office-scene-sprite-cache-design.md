# Office scene sprite cache — design

**Date:** 2026-09-17 · **Lane:** to be opened on approval (parent investigation: `01M2RKFG60380P695GCP49B1Z6`) · **Owner:** miley

## Why

The broadcast page draws the whole room every frame. `drawDynamic` — the path the stream runs, because someone at a desk is always breathing or typing — calls `renderScene` in full: ground shadow, floor, walls, window beams, rugs, then ~30 depth-sorted items (plants, shelves, entrance, every workstation with its props, the pet, queue pads, actors), then the night veil, count pills and vignette. A bake exists (`bake()` → `drawStatic`) but only for the idle frame.

Measured on 2026-09-17 (wiki: `docs/wiki/broadcast-stream.md`, "The office never had headroom…"):

- `/broadcast` at 1920×1080 costs **56.1 ms per draw and reaches 15.35 draws/s on an idle performance-4x** — no ffmpeg, no screencast. It cannot hold 20 fps before the capture pipeline takes its share.
- The cost is the **room**, not who is in it: 39.1 ms/draw at one member, 43.1 at twenty-four. ~39 ms of the ~56 is static furniture re-rasterized every frame through SwiftShader (the box has no GPU).
- The live CPU profile is 50.4 % native Skia raster under canvas 2D gradients, fills and text; the scene's own JS is ~6 %.

So the cheapest real cut is to rasterize the static furniture once and blit it.

## Goal and non-goals

**Goal (nick, 2026-09-17):** hold 20 fps on the current box under the real pipeline. Acceptance: **≤ 25 ms per draw** on `/broadcast` at 1080p, measured interleaved A/B/A/B on one performance-4x, holding across both arms.

**Fidelity (nick, 2026-09-17):** **pixel-identical** to today's frame. The cached path must composite to exactly what the full redraw produces, and that is tested, not asserted.

**Non-goals:** caching `drawInteriorLight` (the night veil and lamp glows); changing any depth value or draw order; changing the stage size (ADR 157 fixes 1920×1080); changing the box.

## Approach

**Per-item sprite cache inside the existing depth sort.** Each static item is rasterized once into its own offscreen canvas, keyed on the inputs that change its pixels. The depth-sorted loop in `renderScene` stays exactly as it is; a cached item's `fn` becomes one `drawImage` instead of dozens of gradient and stroke calls. Depth ordering is preserved by construction because nothing about *where* items draw changes, only *how*.

Rejected: depth-band layers (ordering breaks when a walker crosses a band edge — a leg through a desk on stream) and a full static bake with occluders redrawn over actors (re-derives occlusion outside the sort; the seated-forearms-over-slab rule shows how easily that goes wrong).

## Components

### `office-scene/sprite-cache.ts` (new)

```ts
export interface SpriteBox { x: number; y: number; w: number; h: number } // device px, integer
export interface SpriteCache {
  /** Rasterize `draw` once for `key`, at device box `box`, and return the canvas. */
  get(key: string, box: SpriteBox, draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement;
  size(): number;
}
export function makeSpriteCache(opts: { dpr: number; max?: number }): SpriteCache;
```

- LRU, default `max` 128. ~30 items × a few variants at 1080p; sprites are typically 100–300 device px square, so a few MB total.
- Rasterizes at the item's **actual device position**: the offscreen canvas origin is `(floor(x), floor(y))` and `draw` runs under `setTransform(dpr, 0, 0, dpr, fracX, fracY)` — the same pixel grid the sprite is later blitted onto, so sub-pixel antialiasing is identical.
- Resets `globalAlpha`, `globalCompositeOperation`, shadow state, `lineWidth`, `lineCap/Join`, `font`, `textAlign/Baseline` to the canvas defaults before `draw`, so the offscreen context starts as the direct path's would.
- The blit is `ctx.drawImage(sprite, box.x, box.y)` under an identity transform — integer coordinates, no resampling.
- Pure apart from creating canvases; testable with a recording context.

### Item descriptors in `renderScene`

`items.push({ d, fn })` gains an optional `sprite`:

```ts
interface Item {
  d: number;
  fn: () => void;                       // the direct draw — unchanged
  sprite?: { key: string; box: SpriteBox; live?: () => void };
}
```

When a cache is supplied and `sprite` is present, the loop does `drawImage` of `cache.get(key, box, fn-at-origin)` and then calls `live()` if present. Otherwise it calls `fn`, exactly as today.

`live` is the escape hatch for the part of a "static" item that animates: the **monitor's screen panel** takes `t` (`screenPanel(..., t)` inside `monitor()` inside `drawWorkstation`), so the workstation sprite is the desk, chair, casing and props, and the screen panel is drawn live in the same depth slot immediately after the blit. Anything else discovered to depend on `t` or `Math.random()` at draw time follows the same split rather than entering a key.

Items that get a `sprite`: workstations, bench counter, plants, shelves, entrance. Items that stay live and untouched: actors (both depth slots), pet, queue pads, cues, count pills, `drawInteriorLight`, vignette, labels.

### Background layer

Ground shadow, floor, walls **without** the clock and the working-hours sign, window beams and rugs become one cached full-stage canvas. The clock and the sign are lifted out of `drawWalls` into `drawWallLive`, called right after the background blit — the same position in the sequence they occupy today (back wall, before the sorted loop), so no depth change.

### Opt-in per call

`renderScene(..., { sprites?: SpriteCache })`. `bake()` passes none — it is already one-shot, and keeping it byte-identical to today makes the pixel test's reference honest. `drawDynamic` passes the cache when the office was mounted with `sprites: true`.

## Keys

A key is exactly the set of inputs that change an item's pixels, joined with `·`. `t` is never in a key.

| item | key |
|---|---|
| workstation | `ws · slot.id · dir · lampLit · owned · working · hidden(sorted PropKinds) · fit.scale · dpr · paletteId` |
| bench counter | `bench · fit.scale · dpr · paletteId` |
| plant | `plant · index · species · fit.scale · dpr · paletteId` |
| shelf | `shelf · index · fit.scale · dpr · paletteId` |
| entrance | `entrance · fit.scale · dpr · paletteId` |
| background | `bg · round(veilAlpha/0.01) · lampsOn · paletteId · fit.w · fit.h · fit.scale · dpr · workingHoursId` |

`paletteId` is a stable hash of the resolved scene palette (theme cascade). `veilAlpha` is quantized at the existing `lightChanged` threshold of 0.01.

Invalidation is implicit: a changed input is a new key; the old entry ages out of the LRU. No dirty flags.

## Bounding boxes

Estimated from `PROP_SPEC` / footprint geometry via `project()` plus a fixed padding of 24 device px for shadows and stroke overhang. A box that is too small is a **pixel-test failure**, not a visual judgement call.

## Testing

The render tests run in vitest under `environment: 'node'` against a recording mock context; nothing rasterizes there. Two layers:

1. **Op-sequence equivalence — vitest, always on, the TDD loop.** For each cacheable item, draw it direct and through the sprite path against recording contexts; assert the sprite path's ops for that item equal the direct path's, translated by the sprite origin. Catches wrong boxes, wrong keys (two states sharing a sprite), leaked context state, drawing outside the declared box. Plus `SpriteCache` unit tests: hit/miss, LRU eviction, transform and state reset, integer origin with fractional remainder.
2. **Pixel identity — real Chrome, the gate.** `pnpm scene:pixel-check` (a script beside the existing perf/a11y scripts) loads `/office-preview` headless, renders the same scene state with and without the cache into two canvases, and asserts `getImageData` is byte-equal across a state matrix: day / night; lamps on / off; 1 / 8 / 24 members; a sipping owner (hidden mug); working vs offline owner; two themes. Uses Chrome, which the perf scripts already need — **no new native dependency**. Run before every measurement and before the default flips.
3. **Perf acceptance — measured, interleaved.** The A/B/A/B harness from 2026-09-17 on one performance-4x, `/broadcast` at 1080p, `&sprites=1` vs not on the **same live page**. Target ≤ 25 ms/draw, holding across both A arms. Recorded in the wiki with the falsifier.

## Rollout

- **Dark by default.** `OfficeOptions.sprites?: boolean`; `/broadcast` reads `&sprites=1`. The default flips on only after (2) is byte-equal across the matrix **and** (3) clears 25 ms. Viewers never see an intermediate.
- **Sequence:** (1) `SpriteCache` + tests → (2) workstations (most items, most cost) → (3) plants, shelves, entrance, bench → (4) background layer + lift clock and sign to live → (5) pixel gate script → (6) box measurement → (7) flip default, wiki claim, PR.
- **Exit criterion:** if after step 4 the interleaved measurement does not reach ≤ 25 ms/draw, stop and report the number. Reaching for the lighting pass or loosening pixel identity is a new decision for nick, not a scope change.
- **Memory:** LRU cap 128 sprites plus one full-stage background canvas (~8 MB at 1080p). Inside what the capture box already spends on Chrome.

## Risks

- **An item is not bit-reproducible** (draw-time randomness, state leakage). Surfaced by test layer 1 or 2; the item stays live rather than getting a fudge factor.
- **Boxes too small** for shadow/stroke overhang. Surfaced by layer 2; widen padding or the box estimate.
- **The win is smaller than the room's share suggests** — e.g. if SwiftShader's `drawImage` of a large sprite is itself expensive. This is exactly what step 6 measures and the exit criterion covers.
- **Theme changes mid-stream.** Keyed on `paletteId`, so a theme flip is one cold frame of re-rasterization, then cached again.
