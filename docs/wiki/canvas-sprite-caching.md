# Canvas sprite caching

What a canvas sprite cache costs as well as saves — measured on the office scene, 2026-09-17: rasterizing part of a scene moves where compositing happens, and a blit is a second composite.

Context: the office's per-item sprite cache (`packages/web/src/live/office-scene/sprite-cache.ts`, spec `docs/superpowers/specs/2026-09-17-office-scene-sprite-cache-design.md`). The lessons are about canvas 2D, not about the office.

## An additive pass cannot be separated from what it adds to (2026-09-17; falsify: rasterize `drawWindowBeams` into its own sprite, blit it over the floor sprite, and compare `getImageData` against the direct render — the beams land as flat paint instead of light) <!-- claim: other -->

`globalCompositeOperation = 'lighter'` adds the source to **what is already on that canvas**. Draw it into an empty offscreen and it adds to transparency; blit that back source-over and it *replaces* the pixels it was supposed to brighten.

The office shell was first split into two sprites so the live wall fixtures could keep their exact position in the draw order. The bulb strand and the daylight beams are additive and ended up in the second sprite, adding to nothing. Every one of the ten states in `pnpm scene:pixel-check` failed, at ~14% of all pixels.

The rule that came out of it: **an additive pass belongs in the same sprite as the surface it brightens, or it stays live on the stage.** The office keeps the left wall's strand cached (its wall face is in the same sprite) and the right wall's strand live (its fixtures split the two apart). Source-over content has no such constraint — source-over is associative, so a chain of it can be cut anywhere.

An op-sequence test is blind to it (2026-09-17; falsify: run `render.test.ts`'s cache-equivalence test against the two-sprite shell that failed the gate — it is green). The cached path emitted exactly the same calls in exactly the same order; only a rasterizer knows they landed on a different surface. <!-- claim: other -->

## Unpremultiplied pixel comparison is meaningless near zero alpha (2026-09-17; falsify: compare two renders of the same scene by raw `getImageData` bytes and plot the deltas — they cluster on 255, 128, 85, 64, 51, 42) <!-- claim: other -->

`getImageData` returns **unpremultiplied** RGBA. Canvas stores premultiplied, so recovering colour divides by alpha, and at alpha 1/255 a single stored step becomes a 255-step swing in the reported colour. A pixel at alpha 1 that reads `[0,0,0]` in one render and `[255,255,0]` in the other is the same invisible pixel twice.

The office gate's first report was `maxDelta 255` on 161k pixels, and the delta histogram gave the diagnosis away: the values were 255/n for small n — 255, 128, 85, 64, 51, 42 — which is that division and nothing else. Comparing **premultiplied colour plus alpha** (`round(c·a/255)` per channel, and `|Δa|`) is comparing what a viewer gets, and it took the same run's worst delta from 255 to 19.

## Blitting is a second composite, so ~13% of a detailed scene differs by one step, forever (2026-09-17; falsify: `pnpm scene:pixel-check` after any change to the cache, and read `beyond1` against `differing`) <!-- claim: other -->

Measured across ten scene states at 1920×1080 (1,377,600 pixels), premultiplied comparison:

| | pixels | share |
|---|---|---|
| differ by exactly one step | ~172,500 | ~12.5% |
| differ by more than one step | ~4,000 | ~0.29% |
| worst single-pixel delta | 88 | one desk edge |

One step is what the extra composite costs: the direct path paints an antialiased edge straight onto the floor, the cached path paints it onto transparency and then composites the result. The office floor is drawn plank by plank, so "every antialiased edge" is a large share of the room. `__office.spriteCrops(x, y, r)` renders magnified PNGs of both paths at a pixel; at the worst pixel of the whole matrix the two crops are indistinguishable by eye.

So **"pixel-identical" is not an achievable acceptance criterion for a sprite cache** — the reachable one is "no visible difference, with a stated bound and a gate that enforces it". Which of those a product wants is a person's decision; the measurement is what makes it a decision rather than a guess.

## The win is smaller than "how much of the frame is static" suggests, and the laptop cannot answer for the stream (2026-09-17; falsify: re-run the A/B on the rented Fly machine and compare it to the laptop numbers below) <!-- claim: other -->

The premise was that ~39 ms of the office's ~56 ms per draw is static furniture ([broadcast stream](broadcast-stream.md)), so caching it should take most of that back. Interleaved A/B/A/B on one Chrome at 8× CPU throttle, same page and same room:

| arm | ms/draw |
|---|---|
| direct | 42.0, 40.4 |
| cached | 34.9, 35.8 |

About 15%, with both direct arms consistent. Two reasons the share of the frame does not convert into a share of the time: a near-full-stage sprite costs real memory bandwidth to blit every frame, and everything that stays live (actors, the interior lighting pass, the vignette) was never part of the 39 ms in the first place.

**Which surface this number belongs to matters more than the number.** The two office surfaces do not run in the same place: `/live` renders in a viewer's browser — on this laptop, with a GPU — while the broadcast renders on a Fly `performance-4x` that `musterd stream start` rents per stream and destroys after, reaching the laptop's daemon over Tailscale ([broadcast stream](broadcast-stream.md), ADR 157). Nothing stream-related runs locally. So a laptop A/B is a **direct** measurement of what the cache does for `/live` and only a **weak proxy** for the stream, where there is no GPU and half the frame's CPU was native raster under gradients and text. Copying a large image and rasterizing a gradient trade places between those two machines, which is exactly why the 25 ms acceptance has to be measured where the stream actually runs.

**Answered on the box, 2026-09-18.** That falsifier has now been run. Interleaved off/on/off/on on a `performance-4x` against a populated room, `/broadcast` at the stream's own `fps=20`, `beats` delta 0 on every arm:

| arm | ms/draw | draws/s |
|---|---|---|
| direct | 71.5 | 14.00 |
| cached | 57.4 | 17.42 |

**+24% on the box against ~15% on the laptop** — so the laptop understated it, and the "weak proxy" caveat above was right about the direction being unknowable rather than small. The cache is the larger of the two cuts available, because the box's cost is dominated by per-operation work rather than painted area, and collapsing hundreds of static-furniture ops into one `drawImage` is exactly a per-op cut ([where a canvas scene's time actually goes](canvas-raster-vs-js.md)).

**It is still not enough on its own, and that is the decision this number exists for.** 17.42 against a 20 fps cap. Stacked with a clip covering ~1% of the stage the same box reaches 19.2 draws/s, so the two cuts compose — neither is sufficient alone. ~56 ms remains after the static room is blitted: the actors, the interior lighting and vignette passes, and the blits themselves.

## The fidelity number was measured on the wrong canvas and the wrong rasterizer, and the box is four times kinder (2026-09-18; falsify: run `spriteParity()` on the box against `/broadcast` and read `beyondRounding` as a share of the stage — a share at or above the laptop's 0.29% would mean software raster is no kinder than the GPU) <!-- claim: other -->

`docs/perf/office-sprite-parity-2026-09-17.json` was the artifact certifying the fidelity bar, and it was taken on a GPU laptop against `/office-preview`'s **1,377,600**-pixel canvas. The stream is **2,073,600** pixels in software raster — neither the right canvas nor the right rasterizer, and the direction of that error was unknown until it was run.

Run on the box against `/broadcast` (`spriteParity()`, both paths painted into fresh 1920x1080 surfaces):

| | laptop (GPU, 1,377,600 px) | box (software, 2,073,600 px) |
|---|---|---|
| differing | 176,769 — 12.83% | 192,241 — 9.27% |
| of which ±1 | — | 190,753 — **99.2% of all differences** |
| beyond rounding | 4,028 — 0.292% | 1,488 — **0.072%** |
| maxDelta | 88 | 100 |

**The box is 4.1x kinder on the statistic that matters** and marginally worse on the extreme. 99.2% of every difference is a single step — the unpremultiply rounding this page already documents, invisible by construction. The residue is **1,488 pixels of 2,073,600**, scattered, at up to 100/255.

**It is still not pixel-identical, and no measurement will make it so.** A blit is a second composite; that is the mechanism, not a bug to be fixed. So `equal: false` stands and the bar as written ("pixel-identical") does not survive contact with it either way.

~~**Decided 2026-09-18: the cache goes on for the stream, off for `/live`.**~~ **REVERSED THE SAME DAY, BEFORE ANYTHING SHIPPED — the cache is DARK on `main` and reachable only at `&sprites=1`.** This paragraph asserted a decision for about an hour and was never true of the code; it is struck rather than deleted because it was on `main` and someone may have read it.

**What I argued, and why it was refused.** The case was that 0.072% of the stage at up to 100/255 is worth +24% on a box that otherwise cannot hold 20 fps, because the stream is delivered as H.264 at a fixed bitrate and a lossy encoder's own quantization error on a 1080p frame is larger than a scattered 0.072% — so the canvas-level bar measures a fidelity no viewer receives, while 14-vs-17.4 fps is one every viewer does.

**That argument rested on a measurement nobody has taken**, and it was used to step past a numeric criterion this cut had MISSED BY MORE THAN A FACTOR OF TWO: the implementing lane's criterion 3 is ≤25 ms/draw and the cache reaches 57.4 ms, with criterion 4 making the default flip conditional on 3. Nick's ruling (2026-09-18): leave it dark until something *measures* its way under 25 ms. A bar that bends to an argument is not a bar.

**So the falsifier below is still worth running, and it settles less than it looks like it does.** Render one frame each way, encode both through the stream's own ffmpeg settings, decode, and compare against how much two encodes of the *same* frame differ from each other. If the cache's delta does not survive encode, the fidelity half of the case becomes evidence instead of assertion — but it says nothing about criterion 3, which is about speed, so it would justify re-scoping that criterion openly rather than stepping around it. Follows-up: 01M2V0KX8TDFWE811CG2GFQY8Z

**One gap in the evidence, stated rather than buried:** the bench box was destroyed before capturing *where* the 1,488 beyond-rounding pixels sit. Scattered singles and one clump on a face are the same number and not the same product.

## Measure a sprite's box, do not estimate it (2026-09-17; falsify: set `SPRITE_PAD` to 200 and re-run the gate — the differences do not move) <!-- claim: other -->

The spec planned to derive each sprite's bounding box from footprint geometry plus a fixed padding. `measureBounds` (in `sprite-cache.ts`) instead dry-runs the draw function against a context that tracks only the CTM and the extent of every point touched — path commands, rects, arcs, ellipses, images, and an estimate for text. It is JS-only and runs once per cache miss.

That removed clipping from the list of suspects for free: when the gate went red, raising the padding from 24 to 200 device pixels changed nothing, which ruled out a whole class in one run instead of a session of box arithmetic.

## Related

- [broadcast stream](broadcast-stream.md) — where the 56 ms/draw and the "the room, not who is in it" measurement come from.
