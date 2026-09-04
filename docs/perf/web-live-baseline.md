# Web UI performance baseline — /live

**Date:** 2026-07-17 · **Commit:** `8932ef9` (main @ ADR 150 foundation) · **Author:** miley

First recorded performance baseline for the /live dashboard, taken after the recent feature wave
(ADR 149 asks strip #317, speech bubbles #321, re-font #322). All future perf-affecting changes
should be compared against these numbers by re-running the harness.

> **Enforcement (ADR 151):** byte budgets derived from this log live in `budgets.json` beside this
> file and are enforced in CI by `pnpm perf:check`. Raising a budget happens in the PR that needs it,
> with the measured cost appended to the optimization log below. The working contract for agents in
> the web package is `packages/web/AGENTS.md`.

## Method (reproducible)

```sh
pnpm build
# throwaway daemon on :4890 against a COPY of the real DB (never restart the shared daemon):
sqlite3 ~/.musterd/musterd.db ".backup '/tmp/musterd-copy.db'"
MUSTERD_DB=/tmp/musterd-copy.db MUSTERD_PORT=4890 node packages/cli/dist/bin.js serve \
  --web-root packages/web/dist/client &
node scripts/perf/live-baseline.mjs "http://127.0.0.1:4890/live?team=revive" --window 12000
npx --yes lighthouse@12 "http://127.0.0.1:4890/live?team=revive" --quiet \
  --chrome-flags="--headless=new" --only-categories=performance --output=json
```

`scripts/perf/live-baseline.mjs` is dependency-free (headless Chrome over CDP, native `fetch` +
`WebSocket`). `/live?team=<slug>` auto-provisions an observer seat, so the page measured is the
**connected** dashboard with the real team's data (roster, backfill, office scene), not the
unauthenticated shell. For the live-data latency probe, point a copy of `.musterd/binding.json` at
the temp daemon (`server: http://127.0.0.1:4890`) — the binding's embedded `server` overrides
`MUSTERD_CONFIG`, so a probe run from the real worktree posts to the real team.

## Baseline numbers

### Local, unthrottled (median of 3 connected runs, headless Chrome, M-series Mac)

| Metric                                 | Value                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------- |
| TTFB (document)                        | 7–29 ms                                                                   |
| FCP                                    | ~300 ms                                                                   |
| LCP                                    | ~300 ms typical, **outliers to 2.3 s** (backfill-render long task)        |
| DOMContentLoaded / load                | ~120 ms / ~270 ms                                                         |
| CLS                                    | 0.004                                                                     |
| Long tasks during load                 | 2–3, totaling 120 ms–1.0 s (worst observed single task ~1 s)              |
| FPS over 12 s (office scene animating) | 56–60 avg · p95 frame ~18–21 ms · **worst frame 42–794 ms**               |
| JS heap after settle                   | 11–14 MB                                                                  |
| DOM nodes                              | ~6,900                                                                    |
| Requests / transferred                 | 28 / **1,077 KB** (Script 622 · Fetch 120 · Font 117 · CSS 115 · Doc 103) |

### Lighthouse 12, simulated throttling (slow 4G + 4× CPU)

| Metric                       | Value             |
| ---------------------------- | ----------------- |
| **Performance score**        | **49 / 100**      |
| FCP / Speed Index            | 5.5 s / 5.5 s     |
| LCP / TTI                    | **7.2 s / 7.2 s** |
| Total blocking time          | 540 ms            |
| Main-thread work / JS bootup | 4.7 s / 1.3 s     |
| Total byte weight            | 1,076 KiB         |

### Bundle (vite build, raw / gzip)

| Chunk                 | Raw                                                                              | Gzip       |
| --------------------- | -------------------------------------------------------------------------------- | ---------- |
| index (entry)         | 320 KB                                                                           | 100 KB     |
| routes                | 114 KB                                                                           | 41 KB      |
| dist (protocol)       | 72 KB                                                                            | 18 KB      |
| render                | 38 KB                                                                            | 15 KB      |
| live                  | 33 KB                                                                            | 11 KB      |
| office-scene          | 25 KB                                                                            | 10 KB      |
| **All JS**            | **674 KB**                                                                       | **216 KB** |
| **All CSS**           | **125 KB**                                                                       | **38 KB**  |
| Fonts in dist (woff2) | 838 KB → **335 KB** (Inter+JetBrains dropped, #4); /live loads ~117 KB (7 files) | —          |

### Live-data latency (event → dashboard WS frame)

- Daemon handles the `POST /messages` in **~23 ms** (server-side, temp daemon).
- CLI probe start → WS frame at the page: **491–717 ms**, but the CLI process itself takes
  650–920 ms (Node startup + post-send inbox reads) — the daemon→page push is a small fraction.
  Treat **≤ ~100 ms send→pixel** as the real transport budget; the harness reports the
  CLI-bounded number (`cmdStartToFrameMs`).

## Optimization log

| Date       | Change                                                                              | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-18 | Finding #1: daemon br/gzip + Cache-Control/ETag                                     | throttled Lighthouse **49 → 71** · LCP 7.2 s → 4.3 s · FCP 5.5 s → 3.1 s · transfer 1,077 → 467 KB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-18 | Finding #5: API JSON (`/teams/*` reads) compressed                                  | /live backfill Fetch **124 → 39 KB (−69%)** · transfer 467 → 381 KB · `uses-text-compression` audit cleared · throttled Lighthouse ~82 (median of 3), LCP ~3.6 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-07-18 | Finding #3: stream DOM windowing (bounded rows)                                     | DOM **4,461 → 1,564** (audit 0 → 0.5) · TBT ~210 → **10–20 ms** · load long-tasks 120 ms–1 s → **53 ms** · heap 12 → 8 MB · worst frame 794 → 21 ms · score ~85                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-07-18 | Finding #4: drop dead font families + izzocam canvas                                | dist **−503 KB** (Inter+JetBrains removed) · render-blocking `global.css` **56 → 14 KB** · office/character canvas now paint izzocam via type tokens · /live font download unchanged (7 files, ~117 KB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-07-19 | Office loop: suspend while panel collapsed                                          | collapsed office **~18 draws/s → 0** (was full-scene repaint at `opacity: 0`) · expanded/alive unchanged (18 draws/s ambient cap, ~2.5% core) · re-expand still instant (fresh bake + one sync frame)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-20 | Re-font body `--font-sans` Fraunces → Inter (latin)                                 | editorial serif read too magazine-y for dense stream/office message UI. Swapped body face to Inter (latin subset, 4 weights); Grotesk/Mono unchanged; Fraunces `@import`s dropped. `perf:check` fonts **708 → 554 KB** (Inter latin < Fraunces ×4), CSS gzip 16.9 → 16.7 KB, JS unchanged. Allowlist `fraunces` → `inter`. Canvas bubbles re-font via `canvasFont.ts` token + fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-07-28 | Asks strip → rail + floating sheet (budget raise)                                   | CSS gzip **19.4 → 19.9 KB** (+534 B): the strip's header/count/quiet block is gone, but the rail adds a shrink chain, three responsive tiers, an origin-anchored sheet transition, and a reduced-motion block. Trimmed first — both rail buttons reuse `.lc-ask__btn` instead of redeclaring the pill, and the rail dropped its `backdrop-filter`. `totalCssGzipBytes` **20,000 → 21,000**. JS +0.0 KB, fonts unchanged. **NB: main measured 19,867 / 20,000 B (99.3%) BEFORE this change** — the CSS budget was already spent, so the next CSS-touching PR of any size would have failed it too. The raise restores ~1 KB of working headroom rather than buying this feature specifically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-07-28 | Office overlay → steerable member reel (budget raise)                               | CSS gzip **20,368 → 20,961 B (+593 B)** for two rounds of redesign: the full-bleed scrim and its lane stack are gone (the office got its bottom fifth back), replaced by a contained lower-third card, a segmented cycle rail, and — new — the `/live` steering group (chevrons, position counter, hover lift, focus ring, paused-rail state). Trimmed first: the card's accent set is four local custom properties rather than repeated literals, `.lc-ov__src`/`.lc-ov__more` share one rule, and no `backdrop-filter` anywhere (a blur here is a per-frame GPU readback on the 30 fps capture). JS +0.8 KB (the reel's steering state), fonts unchanged. **NB: main measured 20,368 / 21,000 B (97%) BEFORE this change** — the ceiling raised this morning for the asks rail was already 97% spent by lunchtime, so this raise again restores working headroom rather than buying this feature. Two raises in one day is the signal: the next CSS-heavy feature should come with a trim pass, not a third bump. `totalCssGzipBytes` **21,000 → 22,000**.                                                                                                                             |
| 2026-07-29 | ADR 183: split the JS budget in two + first re-baseline                             | Added `initialJsGzipBytes` (worst route's eager graph, **124.1 KB** on `/asks-preview`) beside the existing all-chunks total (**201.7 KB**, 29 chunks) — the two were ~40% apart, and the single total could not be moved by the lazy-loading its own failure text recommended. Re-baselined every budget to measured **+15%**: total JS **250,000 → 238,000**, fonts **760,000 → 653,000** (both _tightened_ — the roadmap removal and the Inter re-font were never captured), CSS unchanged at 22,000, and `maxChunkGzipBytes` **held at 112,000** because measured+15% would have loosened it to 115,000. That is the ratchet guard: a re-baseline may tighten freely, but any loosening is an ordinary budget raise and follows the raise protocol.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-08-13 | Retire `/asks-preview` — and discover the initial budget was under-counting `/live` | The fixture route was deleted (its rail is exercised on the connected `/live` gate now). Rolldown re-chunked, and `/live`'s **measured** initial went 126.4 → 146.3 KB — but no bytes were added: the checker reads the route HTML's modulepreload list, and before the deletion that list carried 12 chunks while `/live`'s true static import closure was **17 chunks / 150.1 KB** (protocol `dist` 20 KB, `asks`, `OfficeOverlay`, `wallboard`, `presenceLabel` all loaded eagerly at runtime, none preloaded, none counted). Verified by walking `from"./…"` specifiers through the built chunks. So the previous 126.4 was an accounting artifact, the deletion made the HTML honest, and `initialJsGzipBytes` was RAISED 146000 → 152000 to fit the first accurate reading (146.3 KB measured + ~4% — a raise, not a re-baseline, because it loosens). Total JS **fell** 234.2 → 231.2 KB, which is the deletion's real effect. If a lazy split of `/live` is ever chased, start from the closure number, not the preload list.                                                                                                                                                    |
| 2026-08-05 | Lazy-load the sound engine off the eager graph                                      | initial JS gzip **133.3 → 130.6 KB (−2,760 B)**, headroom 9.3 → 12.0 KB against the 142.6 KB budget. The WebAudio synths (`soundEngine.ts`: both engines, the cue table, the 18 life-event synths) now sit behind `import('./soundEngine')`, fired from the click that turns sound on. `sound.ts` keeps the preferences, the pure life-roll/keyboard logic, and two façades with the same API the call sites always used — 1.1 KB gzip eager, so a toggle still renders in the right position on first paint without fetching a synth. Lazy chunk **3,376 B gzip**; total JS 227.8 → 228.4 KB (+0.6 KB, the expected façade+chunk overhead — lazy-loading never moves the total, ADR 183). **The 44 KB of source is only 3.4 KB gzipped** — WebAudio calls plus prose compress hard, so do not size a split off its line count. Verified in the browser: with both prefs ON, a reload fetches **zero** engine bytes and both toggles still render on; the chunk arrives on the first gesture. AudioContext reaches `running` from the toggle click despite the import landing a microtask later — user activation is STICKY, not transient, which is what makes this split legal at all. |
| 2026-08-21 | Per-goal flow on the goal card + insight rail (ADR 295)                             | initial JS gzip **147.7 → 147.8 KB**, CSS gzip **24.5 → 24.6 KB**, total JS 230.3 → 230.6 KB — measured by building `packages/web` at `main` and again on the branch, not estimated from the diff. Both budgets pass with ~650 B of initial-JS headroom, which is where the ceiling already sat before this change. Worth recording because the *source* diff looks much larger than the bytes: 132 added lines gzip to ~2.0 KB as text, but the shipped cost is ~0.1 KB — the additions are mostly prose comments and a CSS block, and the minifier plus lightningcss strip comments entirely. Same lesson as the sound-engine row from the other direction: **do not size a web change off its line count, in either direction.** No new dependency, no new font, no new colour token (the card line reuses the measured `--gg-ink-quiet`). |

## Office scene loop (measured 2026-07-19)

The animation loop was already architected frugally — parks on a baked still frame when nothing
moves, ~20 fps ambient cap for breathing/typing, full rate only for walks/cues, hidden-tab pause,
CSS-only ambient overlays. Measured (prod daemon, 15 s windows, `clearRect` ≈ one painted frame):

| State                                     | rAF/s | draws/s | JS busy              | main-thread |
| ----------------------------------------- | ----- | ------- | -------------------- | ----------- |
| /live, seats working ("rest" in practice) | 59    | 17.9    | 25 ms/s (~2.5% core) | ~203 ms/s   |
| /office-preview (walk choreography)       | 59    | 58      | 78 ms/s (~7.8% core) | ~387 ms/s   |

Two findings: (1) the parked state almost never engages on a working team — any `working` seat keeps
`living()` true, so the ambient ~18 fps **full-scene** repaint runs continuously; (2) a **collapsed**
panel (`opacity: 0`, canvas kept mounted for instant re-expand) kept that repaint running for
invisible pixels. Shipped: `OfficeHandle.setSuspended` driven by the `collapsed` prop — parks the
loop + ambient beats, resumes with one synchronous bake+frame (verified: 60 → collapse **0.0** →
expand 18 draws/s, 5-check CDP suite).

**Deliberately not done** (measure-first verdicts, revisit only with new evidence):

- **Split-bake so breathing doesn't repaint the room** — the ambient frame redraws floor + walls +
  furniture to animate chest-rise. A behind-actors/actors/in-front-of-actors layer split would cut
  the ~25 ms/s to a fraction, but the painter is depth-sort-interleaved (sitters split across two
  depth slots, ADR 133) — real surgery for ~2% of one core. Poor ROI at current cost.
- **Lower the ambient cap** (20 → ~12 fps): halves the always-on cost with one constant
  (`AMBIENT_FRAME_MS`), but visibly chunks the breathing/typing feel — a product call, not a perf
  default.

## Findings, ranked by expected win

1. **~~The daemon serves everything uncompressed with zero caching headers.~~ SHIPPED (2026-07-18,
   #326).** `sendFile` now negotiates brotli/gzip for text types (`Accept-Encoding`, compressed bytes
   cached so it's paid once), sets `Cache-Control: …immutable` on content-hashed `/assets/*`, and
   gives the app shell a weak ETag + `no-cache` that answers `If-None-Match` with a 304. Measured:
   entry chunk 320 KB → 87 KB brotli, /live transfer **1,077 KB → 467 KB (−57%)**, throttled
   Lighthouse **49 → 71**, LCP **7.2 s → 4.3 s**.
2. **~~Entry chunk is heavy and half-unused.~~ INVESTIGATED — not a real lever (2026-07-18).** The
   premise (marketing code shares the dashboard's entry) was wrong: the landing components
   (LiquidGlass/`engine-*`, Lenis, Hero, Roadmap) already live in the `/`-only `routes-*.js` and lazy
   chunks — /live never downloads them. The 320 KB `index-*.js` it _does_ load is the framework
   runtime (React 19 + TanStack Router/Start) + protocol; Lighthouse's "154 KB unused" is
   coverage-of-framework-paths, not dead marketing code, and isn't cheaply extractable. Compression
   (finding #1) already took this chunk to 87 KB on the wire. Parking unless a concrete split target
   appears.
3. **~~Backfill render / stream DOM weight.~~ SHIPPED (2026-07-18).** Profiling first corrected the
   premise: the stream's _render CPU_ was already cheap (~4 ms; the "~1 s long task" was one-run
   variance), but its DOM was 94% of the page (4,214 of 4,490 nodes — Lighthouse `dom-size` score
   0). Fix: the stream mounts only the newest ~60 rows (`live/window.ts` math + windowed
   `Stream`); older history stays in memory behind a top "N earlier" pill that auto-reveals in
   steps on scrollback with exact manual scroll anchoring (`overflow-anchor: none`), collapses
   back at the live edge, and `scrollToMessage` became an event the stream answers by widening the
   window before scrolling (quotes/asks/bubbles unchanged). `useLiveStream` caps memory at the
   newest 1,000 envelopes. Typewriter, stick-to-bottom, day dividers, and the "now" marker are
   verified preserved by a 12-check CDP behavioral suite. Deliberately no `content-visibility`:
   its placeholder sizing corrects itself after our anchoring runs and the viewport drifts.
4. **~~Fonts.~~ SHIPPED (2026-07-18).** Two of the five families in dist — Inter (387 KB) and
   JetBrains Mono (116 KB) — were the retired musterd-default type; the active tokens use the
   izzocam trio (Fraunces / Space Grotesk / Space Mono), so those 503 KB were `@font-face`-registered
   but never fetched on any page (they only sat in `var()` fallback stacks the primary always
   resolves past). Removed their imports: **dist −503 KB**, and the render-blocking `global.css`
   dropped **56 → 14 KB** (73 → 27 `@font-face` rules). In the same pass the two canvas painters that
   still hard-named the old fonts — the office scene (`"Inter"`) and character sheet (`"JetBrains
Mono"`) — now read the type tokens via `live/canvasFont.ts` (so a future re-font sweeps the canvas
   too) and paint the already-loaded izzocam faces; /live's font download is unchanged at the same 7
   files (~117 KB). Further glyph-subsetting of the active families would need a build step — not
   pursued (diminishing returns; the LCP is no longer font-bound with `font-display: swap`).
5. **~~API JSON responses served uncompressed.~~ SHIPPED (2026-07-18).** `sendJson` now negotiates
   brotli/gzip (fast levels — dynamic bodies aren't cacheable) for responses over ~1.4 KB, encoding
   picked once per request. The /live message backfill (`GET /teams/:slug/messages`) drops **124 KB →
   39 KB**; Lighthouse's `uses-text-compression` residual is cleared.

## Prod-serving caveat (2026-07-17)

The shared daemon (:4849) was serving build `40065c5` — **14 commits behind main**, predating the
asks strip / speech bubbles / re-font. This baseline was taken against a fresh-main build on a
temp daemon instead. Any perf numbers eyeballed against the shared daemon are stale until a
`musterd service refresh`.

## Roadmap map dropped from the web UI — total JS gzip 243.3 → 201.5 KB (2026-07-29)

**−41.8 KB JS gzip (−17%), −1.6 KB CSS gzip.** Headroom against the unchanged 250,000-byte budget
goes from **0.8 KB to 42.6 KB**.

nick, 2026-07-28: drop the roadmap from the web UI. `components/Roadmap/*` is deleted, and
`roadmap.data.ts` — ~82 items of authored prose, 130 KB of source — moved from
`packages/web/src/content/` to `content/` at the repo root. Every consumer of that module is
build-time (`gen-roadmap`, `check-roadmap-truth`, the ADR 112 steward scan); it lived under
`packages/web` only because the landing page used to render a map from it, so the browser was
downloading the entire roadmap to draw a page that mostly says three paragraphs and a hero.

The two strings the landing page still needs (`TAGLINE`, `WEDGE`) moved to
`packages/web/src/content/site.ts`. Leaving them behind in the data module would have dragged all of
`RAW` back into the bundle to render two paragraphs, which is the entire cost this move avoids.
`gen-roadmap` imports `WEDGE` from there — one source of truth, pulled toward the consumer that is
picky about bytes.

Dead with the map: the `--status-*` tokens in `tokens.css` (both themes), which only `Roadmap.css`
ever read.

**The budget was NOT raised.** PR #484 proposed 250,000 → 258,000 when headroom was 0.8 KB; this
reclaim is fifty times that raise, so #484 was closed without merging and only its finding was kept
(below). ADR 151 says shrink first — this is what that looks like when the shrink is available.

**Worth a re-baseline.** At 201.5 KB against 250,000, headroom is now ~21%. The 2026-07-19 numbers
were set with ~12% and were exhausted in nine days by ordinary shipping, so a periodic review of all
four budgets is still the right follow-up — see the CSS raise and the JS analysis logged above.

### Finding (carried over from the closed #484): this budget cannot be satisfied by lazy-loading

`scripts/perf/check-budgets.ts` sums the gzip of **every** `.js` under `dist/client`, lazy chunks
included. So code-splitting cannot reduce `totalJsGzipBytes` — it can only raise it slightly, by the
per-chunk overhead. Measured, not reasoned: splitting the default-off room-tone engine into its own
chunk moved **1.3 KB** out of the live route's initial payload and moved the gate the _wrong_ way,
**243.3 → 243.7 KB**. That split was reverted; 0.5% off initial load did not justify an extra module
boundary and a round-trip.

It matters because `perf:check`'s own failure message tells you to "shrink the change (lazy-load,
…)", and the first remedy it names provably cannot move the number it enforces. Two honest readings,
and choosing between them is an ADR 151 decision:

1. **Total shipped JS is the right metric** — it tracks how much code the product carries, which is
   what actually rots. Then the failure message should stop recommending lazy-loading, and splitting
   should be justified against the Lighthouse baseline instead.
2. **Initial payload is the right metric** — what a viewer downloads before the page is interactive.
   Then the budget wants an `initialJsGzipBytes` (entry + route chunk) alongside a looser
   `totalJsGzipBytes`, and the current advice becomes correct.

**RESOLVED 2026-07-29 — ADR 183 took reading (2), keeping both budgets.** The finding above stands as
written; what it was missing is how far apart the two numbers actually are. Measured on `0acb669`:
total shipped JS is **201.7 KB** across 29 chunks, while the worst route's _eager_ graph is
**124.1 KB** — so **~40% of shipped JS is already lazy on every route**, and the single-budget gate
gave that architecture no credit whatsoever. Per-route eager payload, gzip:

| route               | eager chunks | initial JS gzip |
| ------------------- | ------------ | --------------- |
| `/asks-preview`     | 6            | 124.1 KB        |
| `/live`             | 11           | 120.1 KB        |
| `/board`            | 9            | 115.1 KB        |
| `/broadcast`        | 6            | 106.7 KB        |
| `/audit`            | 6            | 106.3 KB        |
| `/office-preview`   | 6            | 106.0 KB        |
| `/approvals`        | 6            | 104.9 KB        |
| `/` (home)          | 5            | 104.2 KB        |
| `/character-sheet`  | 5            | 103.0 KB        |
| `/approval-preview` | 5            | 102.1 KB        |

The gate now enforces `initialJsGzipBytes` against the **worst** route, measured from each
prerendered route's `index.html` (its entry `<script>` plus one `modulepreload` per statically
imported chunk). Verified that a lazy-load moves it, which is the claim the whole change rests on —
and it was worth verifying, because a bundler that emitted `modulepreload` for _dynamic_ imports too
would have invalidated the measurement. A throwaway `lazy()` split of `AsksStrip` on
`/asks-preview` took that route **124.1 → 118.3 KB** (6 eager chunks → 5, dropping exactly the
5.9 KB `AsksStrip` chunk) while total JS rose **201.7 → 201.9 KB**: the two budgets moving in
opposite directions, as designed. The probe was reverted — it existed to test the gate, not to ship
a split.

So the guidance inverts cleanly, and each `perf:check` failure now carries the remedy that can move
_that_ number: lazy-loading for `initialJsGzipBytes`, and deleting code or dropping a dependency for
`totalJsGzipBytes`. **The removal shape still works for both, and is the only thing that works for
the total.**

## CSS budget RAISED 22,000 → 25,300 bytes gzip (2026-08-04) — a raise, not a re-baseline

**This is a deliberate raise and it should be read as one.** ADR 183's re-baseline ritual resets a
budget to measured + 15% and **may only tighten**; here measured + 15% is 25,290 bytes against a
22,000-byte budget, so it loosens, which makes it a raise no matter what it is called. Recording it
under the honest name is the whole point of the ritual.

### What forced it

`perf:check` failed on a 68-byte CSS addition (four small rules for the ADR 222 asks-rail sign-in).
The failure was correct and the addition was not the problem:

| Measurement (node `zlib.gzipSync`, as `check-budgets.ts` uses) | Bytes  | Headroom |
| -------------------------------------------------------------- | ------ | -------- |
| Before the ADR 222 rail change                                 | 21,923 | **77**   |
| After it                                                       | 21,991 | **9**    |

**The budget was already 99.65% consumed before the change that tripped it.** Note the measurement
trap: the `gzip` CLI reports ~10 bytes/file more than `zlib.gzipSync` because it writes a filename
and mtime header. Over 8 CSS files that is ~170 bytes — enough to make a passing build look like a
failing one. Measure with node, the way the gate does.

Per-file, gzip, at the time of the raise:

| file                 | gzip   |
| -------------------- | ------ |
| `Live.css`           | 15,190 |
| `global.css`         | 2,272  |
| `routes-D.css`       | 1,902  |
| `ReceptionScene.css` | 1,668  |
| `approvals.css`      | 393    |
| `Broadcast.css`      | 291    |
| `audit.css`          | 217    |
| `brand.css`          | 58     |
| **total**            | 21,991 |

### Trimming was attempted first, and there is nothing to trim

Each of these was measured, not assumed. **Do not re-chase them without new evidence:**

1. **Dead selectors: zero of 373.** A naive "class in CSS but not in `src/`" sweep flags 57, and all
   57 are false positives — they are built dynamically (`` `lc-ask__tier--${tier}` ``,
   `` `lc-ask lc-ask--${ask.state}` ``, `` `lc-badge--${kind}` ``). Matching on constructed prefixes
   takes it to 0. **A dead-CSS sweep on this codebase must resolve template-literal prefixes or it
   will confidently delete live styles.**
2. **Comments are already free.** `Live.css` is 146,305 raw bytes of which 43,391 are comments, but
   the shipped chunk is 15,190 gzipped — the minifier strips them. Deleting comments buys nothing
   and costs the reasoning, which in this file is most of its value.
3. **`cssMinify: 'lightningcss'` is byte-identical** to the default esbuild minifier here: 21,991
   either way. Tried and reverted.
4. **Duplicate declaration blocks total ~500 raw bytes** across the whole file (the largest is a
   3× `color: var(--lc-dim); border-color: var(--lc-border-2);`). Below the noise floor after gzip.

### The growth is real feature work

Since the 2026-07-29 re-baseline, `Live.css` took **+1,019 / −245 lines across 13 shipped commits** —
the cork pin board and board-off-the-wall overlay (#586), enamel nameplates, the reception lane and
nameplate expand animation (#591), task-chair legs and the 18-desk floor (#593), presence chrome and
room dressing (#548). None of it is waste. CSS grew 19.1 KB → 21.99 KB, consuming a 15% headroom in
**six days**.

### The thing to watch

**A 15% headroom lasted six days at current office-CSS velocity, so this raise buys roughly a week.**
If the next ceiling arrives on the same schedule, the answer is not a third raise: it is either a
deliberate decision that the office's visual richness is worth a permanently larger CSS budget (say
so, and set it once, high), or a structural change — `Live.css` is 4,500+ lines and 69% of all shipped
CSS, and it is the only file that has ever moved this number.

## 2026-08-12 — the goals-grid front door (raise, not re-baseline)

The board's new default view (goals-front-door design: `goalGrid.ts` model, `GoalGridView.tsx`,
`GoalGrid.css`, route drill-in, overlay toggle) landed with both totals >99% consumed and tipped
them: **total JS 238,899 B vs 238,000 budget; total CSS 25,395 B vs 25,300 budget.** The swimlane
regroup it replaces (`groupByGoal` + its suite) was deleted in the same change, so the delta is
net of the retirement. Initial JS is untouched (grid rides the existing lazy board chunk).
Raised `totalJsGzipBytes` 238000 → 241000 and `totalCssGzipBytes` 25300 → 26400 — measured + ~1%
headroom on JS, +4% on CSS; both were tight-fit ceilings, not calibration drift.

## 2026-08-21 — ADR 302 site expansion (initial raise; landing re-composition)

Branch `miley/musterd-io-expansion`: the public site grows to `/`, `/roadmap`, `/docs/**`,
`/blog/**`; the landing swaps the canvas office-scene hero for typographic sections
(SiteNav/LightHero/StreamSection/WhatIs/Teasers). The Twitch player is third-party and deferred
(no iframe in prerendered HTML; IntersectionObserver injects it), so it touches no JS budget.

Measured (this box, `perf:check` after `pnpm --filter @musterd/web build`; main baseline is the
2026-08-13 log entry):

- **initial JS (worst route /live): 146.3 KB → 150.4 KB.** The new landing sections ride the entry
  chunk because the index route is part of it, and /live's eager graph includes entry. Raised
  `initialJsGzipBytes` 152000 → 156000 (measured 154,010 B + ~1.2% slack, the 2026-08-12 shape).
- **The lazy remedy was measured and REJECTED** (findings-log entry, do not re-chase without new
  evidence): splitting the landing component into `index.lazy.tsx` moved the sections out of entry
  but rolldown re-chunked shared modules — `fileRoute` (10.8 KB gzip) and `jsx-runtime` (2.9 KB)
  became separate eager chunks in every route's graph — for a WORSE initial (152.1 KB) and
  **+26 KB total** (35 → 37 chunks, churn + duplication).
- **total JS: 234.3 KB / 241000 budget — passes.** The generated content module (docs/blog/roadmap
  HTML) ships as **zero client JS**: content routes load it in loaders behind `import.meta.env.SSR`,
  the prerender dehydrates each page's own data, and the client build dead-code-eliminates the
  import. First measured shape (content in a shared chunk hoisted into entry) was 259.0 KB total /
  121.2 KB entry — the SSR guard is what fixed it.
- **CSS: 26,406 B vs 26,400 — 6 bytes over; trimmed** (two redundant declarations in the new site
  CSS) rather than raised.
- Dead code removed in passing: `LiquidGlass/` (no consumers), `lenis`, `@fontsource/fraunces`.

## 2026-08-24 — Delight 0: the CSS budget splits by surface (ADR 313)

Branch `miley/delight0-css-budget-split`, measured on main @ 6bcc8c4a the way the gate measures
(`gzipSync` default level over `dist/client`): CSS 26,394 / 26,400 (**6 bytes free**), initial JS
154,372 / 156,000, total JS 240,456 / 241,000.

- **The canvas-substitutability question the delight spec asked is answered, by rebuild rather than
  arithmetic** (sections deleted from `Live.css`, package rebuilt, shipped bundle re-gzipped):
  pure decoration over the canvas (Tier-A ambient FX, watermark, one dead section) is **−832 gzip
  bytes = 5.3%** of Live.css's 15,810; adding the interactive over-canvas chrome (nameplates,
  speech bubbles + rich tokens + hover-expand, board hotspot, work stack) reaches **−4,143 gzip
  bytes = 26.2%**. The spec's 15% falsifier passes only by counting the interactive tier, whose
  canvas rewrite would spend JS bytes the JS budgets (1,628 / 544 B free) do not have. Route 2
  rejected as runway; evidence and decision in ADR 313.
- **`totalCssGzipBytes` (26,400) replaced by per-surface budgets**, each measured + 15%:
  `appCssGzipBytes` 24,700 (measured 21,492), `siteCssGzipBytes` 2,900 (measured 2,538),
  `sharedCssGzipBytes` 2,700 (measured 2,364). A deliberate loosening under ADR 183's ritual —
  implied total 26,400 → 30,300 — justified by the structural defect it removes: the office and the
  eight-route public site shared one ceiling set when the site was one page, and on 2026-08-23 a
  site-only table rule was blocked by office bytes.
- **Classification is closed**: `check-budgets.ts` fails on any CSS bundle not named in
  `budgets.cssBundles` (exercised: a stray `Mystery-abc123.css` fails; an over-budget group fails
  naming only its own bundles as the remedy).

## 2026-08-24 — Shared Seeds drawer (total-JS raise)

Measured on main @ `5d63094d` and PR #1025 after rebasing to that commit, using `gzipSync` over the
same production build that `perf:check` reads:

| build | `/live` eager JS | total JS | chunks |
| --- | ---: | ---: | ---: |
| main | 154,479 B | 240,813 B | 35 |
| Shared Seeds, eager drawer | 156,242 B | 242,341 B | 35 |
| Shared Seeds, lazy drawer + Seed client | **155,194 B** | **243,065 B** | 36 |

The read-only drawer is an opt-in interaction, so its component and Seed schema now load only when
opened. That keeps initial JS within the unchanged 156,000 B ceiling (806 B free). The boundary adds
724 B to total JS versus the eager shape, but removes 1,048 B from every `/live` initial load; this
is the intended ADR 183 tradeoff. No dependency was added and no superseded feature code exists to
delete. `totalJsGzipBytes` is therefore **RAISED 241,000 → 246,000**: measured 243,065 B plus ~1.2%
headroom, matching the 2026-08-12/21 raise shape. App CSS measures ~21.7 KB against its ADR 313
24.1 KB surface budget, so CSS is unchanged.

The same build exposed an ADR 313 checker defect: Vite emitted `Live-Cs78-rix.css`, and the checker
treated the legal hyphen inside the hash as part of the pre-hash basename. Classification now
matches the closed declared basename prefix and has a regression test for hyphenated hashes; no CSS
bundle was added or reclassified.
## 2026-08-24 — surface_globs → scope: +157 B of skew compat on the pre-Seeds ceiling

Branch `stanley/scope-rename` (PR #1041), measured the way the gate measures over `dist/client`:
main @ b08cc251 total JS 240,175 / 241,000 (**825 bytes free locally**); branch 240,332 — the
rename's whole cost is **+157 gzip bytes** (LaneSchema preprocess adoption of the legacy key, the
`surface_globs` mirror on the full Lane shape, `mirrorLegacyScopeOnSend`). CI's toolchain gzips the
same tree ~0.7 KB higher than a local build (both invocations are `gzipSync`; the delta is the
minified output, not the measurement — same class as the gzip-CLI-vs-zlib trap logged 2026-08-04),
so on CI the 241,000 budget was already fully consumed before this change and the gate failed twice
on `235.4 KB > 235.4 KB`.

- A raise to 242,000 was prepared under ADR 183's ritual, then **superseded before it landed**: the
  Shared Seeds raise above (241,000 → 246,000, PR #1025) merged first and absorbs these bytes with
  room. No budget change ships from this lane; the measurement stands as the record of the compat
  contract's cost — the bytes drop with the mirror in a later epoch.
- Falsify: build the branch and `pnpm perf:check`; delete `mirrorLegacyScopeOnSend` and the
  mirror lines and the total returns to within ~40 B of main's.
## 2026-08-24 — owned empty desks (+~0.6 KB total JS; rode the Seeds raise, no raise of its own)

Presence-honesty §4 (lane 01M0GVNXHC, PR #1046) adds the owned-desk pass to the office canvas:
offline owners keep desks in `assignSeats`, and `drawWorkstation` bakes a nameplate, a fading
screen afterglow and the `disconnected` glint. Measured on the branch (`pnpm --filter @musterd/web
build && pnpm perf:check`): total JS gzip 241,0xx locally / 241,4xx in CI against 241,000 — the
ceiling had ~0.5 KB free before the change. The helpers were inlined into the prop pipeline first
(−~0.3 KB); no dead JS was found to trade. A 241,000→242,000 raise was prepared, then dropped in rebase: the Shared Seeds raise to 246,000 landed first and covers it. Trap re-paid in this change: `perf:check` reads the last build — run
the build in the same breath or the number you defend is the previous commit's.
## 2026-08-25 — seeded idle life E1a: +698 B total JS for the shared ambient seam (raise 246,000 → 249,000)

Branch `miley/seeded-idle-life-e1a` (lane 01M0GVPFKT, spec #1058), measured the way the gate
measures over `dist/client` after a fresh build on both sides:

- main @ b53cb94a: **245,531 B** gate-style (`gzipSync` default level; the level-9 CLI-style number
  is 245,159 — same ~0.3% trap logged 2026-08-04).
- branch: **246,229 B** — the feature's whole cost is **+698 B**, inside the spec §4 estimate
  (≤1.0 KB), all of it in the lazy `office-scene` chunk plus its call-site threading. Initial JS is
  untouched: 151.9 KB against 152.3 KB, `/live`'s eager graph does not import the seed module
  eagerly beyond what `index.ts` already carried.

The ceiling had 469 B free locally and effectively none on CI (CI's toolchain gzips the same tree
~0.7 KB higher — the 2026-08-24 `stanley/scope-rename` measurement), so the gate fails on exactly
this feature's bytes. No trim was available inside the change: the module is 90 lines of hash +
decision logic and the threading replaces `Math.random()` call sites one-for-one. Raised
totalJsGzipBytes 246,000 → 249,000 (measured 246,229 + ~1.2%, the Shared Seeds precedent).

- Falsify: build main and the branch and run the byte walk in this entry's method; delete
  `ambientSeed.ts` and revert the call sites and the total returns to within ~50 B of main's.
## 2026-08-25 — seeded idle life E1b: occupancy-scaled density, constants pinned (no byte change worth logging)

Branch `miley/e1b-density` (lane 01M0GVPFKT, PR #1066). The measured table the `ambientSeed.ts`
docblock and `scripts/perf/ambient-density.mjs` header point here for — three sequential 8-minute
arms, one headless Chrome at a time, against `/office-preview?quiet&team=revive` on a vite dev
server (method at the top of the harness):

| arm            | fire obs/exp | beats/idle-min | playRate |
| -------------- | ------------ | -------------- | -------- |
| E1a floor n=2  | 0.25 / 0.40  | 0.75           | 1.00     |
| E1b n=2        | 0.23 / 0.27  | 1.12           | 0.82     |
| E1b n=8        | 0.50 / 0.70  | 2.50           | 0.83     |

`AMBIENT_P_FULL = 0.7` is pinned by the saturation argument, not the point estimate: the n=8
observed fire rate ceilings at ~0.5 (3σ below p) because a playing beat holds `quiet()` false, so
raising p buys almost nothing. `AMBIENT_P_QUIET = 0.27` reproduces the analytic pre-E1a delivered
rate (0.4 per 20 s slot × fallthrough playRate ≈ 1 → 1.2/min; E1b n=2 measures 1.12, within 7%).
8-minute arms put ±0.55 on the n=8 point.

- Falsify: re-run the harness per its header (`--slot-ms 20000` for pre-E1b builds); if n=8
  delivered density moves materially above 2.5/idle-min without a code change, the saturation
  argument was wrong and P_FULL wants re-deriving.

## 2026-08-31 — totalJsGzipBytes 249000 → 252000 (Delight E3 milestone moments, PR #1118)

The E3 moments (fanfare / door / askbell voices + the `moment` dispatch and throttle) ride the
lazy `soundEngine`/`soundLife` chunk, so `initialJsGzipBytes` is untouched (151.6 KiB, and the
E2 `soundLife` split had already *reduced* it from 152.4). But total counts every chunk:

| tree | total JS gzip (gate style) |
| --- | --- |
| main @ 90a8b331 (E2), local | 248,422 B |
| branch a803c722 (E3), local | 248,934 B |
| branch, CI | 249,344 B (the known ~0.7 KB CI toolchain delta, 2026-08-24) |

Feature cost ≈ +0.5 KiB against a ceiling with ~600 B free locally and none on CI. No lazy
remedy exists by construction (the code already sits on the lazy chunk — ADR 183: lazy-loading
cannot move total), and no deletable twin was found: the voices reuse the existing `click`/
`ping`/noise helpers rather than duplicating shapes. Raise to CI-measured + ~1.2%, matching the
2026-08-24 (Shared Seeds) and 2026-08-25 (E1a) precedents.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit; total
  should read ≈243.5 KiB against 246.1 KiB (252,000 B).

## 2026-09-01 — initialJsGzipBytes 156000 → 158000 (lapsed asks, PR #1158)

#1158 added `applyTierClock`, the `lapsed` state and the elapsed-note card to `asks.ts`,
`AsksStrip.tsx` and `AsksReel.tsx`. Those modules are the /live strip and the /broadcast reel —
the eager graph itself — so ADR 183's initial-budget remedy (a dynamic import) has nothing to move:
the code is the surface. The PR's own gates passed with bytes to spare; the merge commit did not.

| tree | initial JS gzip, worst route /live (gate style) |
| --- | --- |
| #1158 branch @ ca4e48dc, CI (its own gates, green) | 152.3 KB against 152.3 KB |
| main @ db1099de, local | 152.3 KB against 152.3 KB (passes) |
| main @ db1099de, CI | 152.4 KB against 152.3 KB (**red**) |
| #1155 @ 0540ee3f rebased on that main, CI | 152.4 KB — same failure, no web change in the PR |

The ~0.1 KB is the 2026-08-24 CI gzip toolchain delta landing on a ceiling that had bytes free
locally and none on CI — the same shape as the 2026-08-25 and 2026-08-31 raises. Raise to
CI-measured + ~1.2% (156,058 → 158,000), matching those precedents. Reviewed on the PR by dolly
(mutation-verified, 768/768); the budget was not checked at review time, which is the process gap
this note records: **a PR that reads "N KB / N KB" on its own gates will read over on main.**

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit; initial
  should read ≈152.3 KB against 154.3 KB (158,000 B), and main's CI gates go green.

## 2026-09-02 — initialJsGzipBytes 158000 → 154500 (the raise above, repaid; PR #1168)

The first entry in this log that gives bytes back. The raise directly above was correct triage —
main was red and taking every rebased PR with it — but its premise, *"the code is the surface"*,
holds only for #1158's own bytes. It is not true of the route they landed on.

| tree | initial JS gzip (/live eager) | |
| --- | --- | --- |
| `d7cb401c` (#1158's parent), local | 155,721 B | CI green |
| `db1099de` / `5cc8aa68` (main), local | 155,964 B | **CI red** |
| this branch, local | **152,540 B** | |

#1158 cost **243 B** against a ceiling with **279 B** free, and all 243 are feature:
`applyTierClock`, the loudness guard in `answerableCount`, and the lapsed note's copy. Nothing
there is shaveable without taking the honesty out of the surface it was built for. So the bytes
came from somewhere else, and the somewhere else had been hiding in plain sight.

`BoardOverlay`'s header has said since it was written that the board is *"kept out of /live's
eager graph (ADR 151: heavy, occasional code gets a lazy chunk, never the entry)"*. Only the inner
`Board` ever was. The 219-line modal shell — plus `useBoardData`, `goalGrid` and
`boardOverlayMath` through its static imports — rode the entry chunk on a route that renders none
of it until a reader reaches for the wall, behind an already-conditional
`{boardOpen && <BoardOverlay/>}`. Making the shell lazy too costs one `Suspense` boundary:

| step | initial JS gzip | Δ |
| --- | --- | --- |
| main | 155,964 B | — |
| dedupe the `?still` / `?asks-open` flag readers | 155,960 B | −4 B |
| **lazy `BoardOverlay` shell** | **152,540 B** | **−3,439 B** |

About 14× what #1158 borrowed. The flag-reader dedupe is kept for being better code, not for its
bytes: gzip had already collapsed the duplicated `try`/`catch`, which is worth remembering the
next time a shave looks obvious on the page.

Per ADR 183 the total moved the other way, exactly as that ADR predicts a lazy split will:
249,509 → 250,547 B (+~1 KB of per-chunk overhead, 36 → 38 chunks), still inside the 252,000
ceiling.

`preloadBoardOverlay` keeps the promise the old `preloadBoard` made — the wall hotspot's first
hover/focus now warms *both* halves (shell, then board), so a click still lands on a loaded chunk
and the "comes off the wall" flight is not waiting on a network round trip.

### Two measurement traps, both of which cost time here

- **`perf:check` does not build.** It only reads `packages/web/dist/client`. A reading taken
  without `pnpm --filter @musterd/web build` first is the *previous* tree's dist — which is how
  two commits 243 B apart both measured 155,964 B and looked identical.
- **A PR reading "N KB / N KB" on its own gates will read over on main** — the process finding
  from the note above, kept, because it is what this ceiling's headroom was hiding.

New budget is measured 152,540 + the CI toolchain delta + ~1.2% slack (the 2026-08-12 precedent),
leaving ~1.9 KiB of genuine headroom where 279 B had made *any* web change a coin flip against
CI. A re-baseline may only tighten (ADR 183); this one does.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` — initial should read ≈149.0 KiB
  against 150.9 KiB (154,500 B). If a future change puts `BoardOverlay` back into the eager graph,
  this budget is now tight enough to say so instead of absorbing it silently.

## 2026-09-02 — totalJsGzipBytes 252000 → 255000 (musterd.io agent surfaces, PR #1177)

**The 28 bytes are not the story; the ceiling is.** Tier 3 of the musterd.io discoverability
arc is almost entirely build-time work — the markdown mirrors, `llms-full.txt` and
`blog/rss.xml` are emitted by `scripts/site-files.ts` through the vite config and never enter
the bundle. Its whole client-side cost is `markdownAlternate()` and `feedAlternate()` in
`siteMeta.ts` plus the three route `links` arrays that call them: the `<link rel="alternate">`
tags that announce a mirror from the page it mirrors.

| tree | total JS gzip (gate style) | free against 252,000 |
| --- | --- | --- |
| main @ 0c4315fa, local | 251,125 B | 875 B |
| branch @ 8e4f5fe8, local | 251,153 B | 847 B |
| main @ 0c4315fa, CI (green) | 246.0 KiB against 246.1 KiB | **under 100 B** |
| branch @ 8e4f5fe8, CI | 246.1 KiB against 246.1 KiB (**red**) | none |

Feature cost, measured both ways: **+28 B**. Main was already consuming 99.96% of the ceiling
on CI, and 28 bytes was more than it had left.

No remedy exists on this budget by construction: ADR 183 is explicit that lazy-loading cannot
move total (it adds per-chunk overhead), and the remedies that can — delete code, drop a
dependency — have nothing to take here. The two helpers are five lines and they *are* the
feature: without the head link, an agent that lands on the HTML has no way to find the mirror
except by guessing at a URL convention. An `import.meta.env.SSR` guard was considered and
**rejected**: it would drop the tags from the client build and React would then remove them
from the head at hydration, so a JS-rendering crawler — Googlebot included — would see the
announcement disappear. A tag that exists only until the page hydrates is worse than no tag.

A re-baseline was checked first per ADR 183 and is not available: measured + 15% would be
~289,000, which loosens, and a re-baseline may only tighten. So this is a raise, recorded as
one, to CI-measured (~252,02x) + ~1.2%, matching the 2026-08-24 / 08-25 / 08-31 precedents. It
leaves ~3.8 KB of true headroom where under 100 B had made any web change a coin flip against
CI — the same failure shape the 2026-09-01 entry above records for the *initial* budget, now
observed on total.

**The thing to watch**: this is the fourth raise of `totalJsGzipBytes` since 2026-08-24
(241,000 → 246,000 → 249,000 → 252,000 → 255,000) with no re-baseline between them. Every one
was justified on its own measurement, and the trend is still a trend. The 2026-09-02 initial-JS
entry above is the counter-example worth copying: its remedy was found in code that had
described itself as lazy for months and was not.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit; total
  should read ≈245.3 KiB against 249.0 KiB (255,000 B), and main's CI gates stay green.

## 2026-09-02 — `initialJsGzipBytes` 154,500 → 144,000 (re-baseline, tightening): zod was never architectural

The entry above it, written by me the same day, is wrong, and this is the correction. It records
that /live's real headroom "needs architecture (defer roster parsing), not an import tidy". The
reasoning was: `packages/web/src/live/format.ts` value-imports three pure helpers from the
`@musterd/protocol` **barrel** and looks like the culprit, but `live/client.ts` also value-imports
the zod schemas it parses the roster with and genuinely needs them — so moving format.ts alone
could not move zod off the eager graph.

Measured, that has it backwards. **format.ts was the only eager path into zod.**

| | eager `dist-` chunk | /live eager graph |
|---|---|---|
| main @ dac0f083 | 23,031 B gzip | 154,197 B (150.6 KiB), 13 chunks |
| deep imports | 10,048 B gzip | **141,341 B (138.0 KiB), 13 chunks** |

The change is two lines. `normalizeModelId` and `reviewGrade` come from
`@musterd/protocol/model` and `resolvePosture` from `@musterd/protocol/posture` instead of the
barrel, with those two subpaths added to the protocol package's `exports` (enumerated, not a `./*`
wildcard — a wildcard would make every internal module public API of a published package as a side
effect of a perf fix). With no eager importer left, rolldown tree-shakes zod out of the shared
protocol chunk; it lands in a lazy `posture-` chunk fetched alongside the roster request instead of
before first paint.

**Nothing was deferred, deleted, or made less strict.** `fetchRoster` still validates every row
with `MemberSummarySchema` exactly as before, per-row tolerance intact (ADR 148); 964 web tests,
typecheck and the build are unchanged and green. The architectural remedy the previous entry
described — defer roster parsing — is **not needed for these bytes** and should not be chased for
them. If it is ever wanted, it will have to earn its own justification.

Per ADR 183 the total moved the other way as predicted: 247.1 → 247.8 KiB (+~0.7 KiB per-chunk
overhead, 37 → 38 chunks), inside the 255,000 ceiling. That ceiling is now **99.5% consumed** and
is the number to watch — the trend the entry above flags as a trend is unchanged by this.

New budget is measured 141,341 + the known ~0.7 KB CI gzip delta + ~1.2% slack (2026-08-12
precedent) = 144,000, leaving ~2.6 KB of true headroom. Deliberately **not** padded further for the
dwell work in flight (lane 01M1JQENBK): sizing a budget for work that has not landed is the
calibration failure this file keeps re-learning.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit — initial
  should read ≈138.0 KiB against 140.6 KiB (144,000 B). Then revert the two imports in `format.ts`
  to the barrel, rebuild, and watch the eager graph go back to ≈150.6 KiB: that is the whole claim.

## 2026-09-03 — un-splitting to recover `totalJsGzipBytes`: measured and REJECTED

`totalJsGzipBytes` is the binding constraint and has been for a week: 248.3 KB against a 249.0 KB
ceiling on main @ `cd4d2934`, **715 bytes free**, 38 chunks. It has been RAISED five times since
2026-08-24 with no tightening between them. ADR 183's ritual cannot repair it — a re-baseline may
only tighten, measured + 15% loosens (so a re-baseline is unavailable), and tightening toward the
measured 248.3 leaves zero headroom against the known ~0.7 KB CI gzip delta, which makes every web
PR a coin flip. The trend is the finding.

**The hypothesis.** This file and `budgets.json` both say only deleting code or dropping a
dependency can move total, because lazy-loading cannot. That pair looked incomplete against this
file's own evidence: splitting has RAISED total twice — 36 → 38 chunks cost ~1 KB (BoardOverlay),
37 → 38 cost ~0.7 KB (the zod deep-import directly above). Per-chunk overhead is real and additive,
so **un-splitting should lower total**, and nothing in ADR 183 forbids it. Eleven chunks measure
under 1.5 KB gzip (5,208 B); four are near-empty public-site route stubs (`docs._slug` 289 B,
`docs.index` 310 B, `blog._slug` 305 B, `blog.index` 327 B) whose real content is prerendered HTML.
Bounded estimate: 1.5–2.5 KB recovered, 2–3x the headroom that exists.

**Measured, it goes the wrong way.** A `build.rollupOptions.output.manualChunks` grouping the four
route source files into one `site-routes` chunk:

| | total JS gzip | initial (/live) | chunks | largest chunk |
|---|---|---|---|---|
| main @ `cd4d2934` | 248.3 KB / 249.0 | 138.6 KB / 140.6 | 38 | 97.5 KB |
| `manualChunks` | **249.7 KB (RED)** | **139.9 KB** | 38 | 86.0 KB |

Both budgets got worse and the chunk count did not move.

**Why — the part worth keeping.** The four stubs *survived as four separate chunks* (275–314 B
each, ~1,177 B). What the grouping actually did was hoist 16.1 KB of shared page code out of the
entry chunk into a new `site-routes-` chunk (entry 99.6 → 87.9 KB). The route stubs TanStack Start
emits are **virtual modules created by the plugin's route-splitting**, not the `src/routes/*.tsx`
files on disk; a `manualChunks` predicate matching source paths therefore cannot address the stubs
at all — it grabs the real page components instead and splits *more*, paying fresh per-chunk
overhead (+1.4 KB total) and dragging /live's eager graph up with it (+1.3 KB). A stray
`site-routes-*.css` bundle also appeared and correctly failed the ADR 313 classification gate,
which is that gate working as designed.

This is the same shape as the 2026-08-21 `index.lazy.tsx` rejection recorded above: an intuitive
chunk-boundary change that rolldown answers by re-chunking shared modules into a worse arrangement.
**Two rejections now share one lesson: you cannot steer this build's chunk graph from the outside
by naming source files.**

**What survives and what does not.** The hypothesis is *not* disproved — per-chunk overhead is
still real, and un-splitting is still the only lever besides deletion that can move total. What is
disproved is that `manualChunks` over source paths can reach it. Any future attempt has to go
through the Start plugin's own splitting behaviour, and it should be measured before it is
believed. The dependency arm is separately closed: `react`, `react-dom`, two TanStack packages, two
`@fontsource` packages and the workspace protocol — nothing droppable without an architecture
change. Do not re-chase either arm on intuition.

`budgets.json`'s "only deleting code or dropping a dependency" note is corrected in this pass to
name the third lever and its one measured failure, so the next reader does not spend the hour again.

- Falsify: re-apply the `manualChunks` predicate from this entry on top of `cd4d2934`, rebuild, and
  run `pnpm perf:check` — total should read ≈249.7 KB RED with the four stub chunks still present
  and a ~16 KB `site-routes-` chunk beside them. If instead the stubs merge and total falls, the
  Start plugin's splitting has changed and this entry is stale.

## 2026-09-03 — `totalJsGzipBytes` 255,000 → 258,000 (office surfaces batch, PR #1265)

Lane 01M1MM1Y5H: bubbles drop the sender's own `name:` prefix, the act mark on a bubble grows from a
15 px tag to a 22 px coin, and `/broadcast` carries a notice (the feed may blink while the room ships
the thing being watched) and a contact line (`musterd.io`, `revive@musterd.io`) in a new `cornerSlot`
on `OfficeScene`. Two of those are facts asserted on a public surface and are not shaveable.

| | total JS gzip | headroom |
|---|---|---|
| main @ 179235bd, local | 254,536 B (99.82% of 255,000) | 464 B |
| branch, local | 254,849 B | 151 B |
| branch, CI | 249.2 KiB against 249.0 KiB (**red**) | none |

Feature cost: **+313 B** local. CI read ~0.3 KB above local on this PR (the delta the 2026-08-25
entry records as ~0.7 KB has narrowed, not gone). Trimming came first and recovered what it could:
`stripSenderPrefix` compacted to three lines, the per-team contact map folded to a literal. What
is left is the notice's two sentences, the address, the coin's CSS (not counted here) and the
slot's one conditional — the feature.

No remedy on this budget by construction: lazy-loading cannot move total (ADR 183), the
dependency arm is closed (2026-09-03 entry above), and the un-splitting lever was measured and
rejected the same day. A re-baseline may only tighten and measured + 15% loosens, so this is a
raise, recorded as one, to CI-measured (~255,150) + ~1.2% per precedent.

**The finding, restated because it has grown**: sixth raise of `totalJsGzipBytes` since 2026-08-24
(241,000 → 246,000 → 249,000 → 252,000 → 255,000 → 258,000) with no tightening between them, and
after the un-splitting rejection there is no known lever that repays it. Every raise was justified
on its own measurement. The budget is now measuring the product's growth, not catching waste — which
is a different instrument from the one ADR 151 set up, and worth its own decision rather than a
seventh entry here.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit — total should
  read ≈248.9 KiB against 252.0 KiB (258,000 B), and main's CI gates stay green.

## 2026-09-04 — zod leaves the browser: the repayment the six raises were owed

Decision: [ADR 380](../decisions/380-the-protocol-has-a-validator-free-face.md).

nick's steer, after the entry above named the trend and found no lever: **find and land the
repayment, or write the decision that says why the ceiling moves — not a seventh raise.** This is the
repayment.

The 2026-09-02 entry got zod out of the **eager** graph by deep-importing three helpers from
`@musterd/protocol/model` and `/posture`. It stayed in the **product**: both of those modules import
their vocabularies from `acts.ts`, which builds `z.enum`s at module scope, so a lazy 13.5 KB
`posture` chunk was still fetched with the roster and the protocol barrel chunk still carried its
whole `z.object(...)` graph. An import tidy could not reach that — the reachability is structural.

So the structure changed. Every closed set and pure derivation the browser reads now lives in a
validator-free `*.wire.ts` module, and the zod module beside it **builds its enum from that tuple
and re-exports the name** — `acts`, `ask`, `capabilities`, `envelope`, `goals`, `lanes`, `offline`,
`posture`, `seeds`, `working-hours`. One list per vocabulary, so `@musterd/protocol` and the new
`@musterd/protocol/wire` subpath cannot disagree about what the wire allows; nothing was copied.
The eight web parse sites read through `packages/protocol/src/guards.ts`, and `/wire` is the
browser's whole door into the contract.

| | before (main @ 9ab435f0) | after | delta |
|---|---|---|---|
| total JS gzip | 249.1 KiB (38 chunks) | **228.6 KiB (36 chunks)** | **−20.5 KiB** |
| `/live` eager JS gzip | 139.1 KiB (13 chunks) | **132.0 KiB (12 chunks)** | **−7.1 KiB** |
| zod in `dist/client` | 13.5 KiB `posture` chunk | **absent** (no chunk matches `ZodError`) | — |

Budgets **re-baselined, both tightening** (ADR 183 permits only that direction): `totalJsGzipBytes`
258,000 → **237,000**, `initialJsGzipBytes` 144,000 → **137,000**, each measured + the known ~0.7 KB
CI gzip delta + ~1.2% slack per the 2026-08-12 precedent. That repays five of the six raises since
2026-08-24 and leaves ~2 KB of true headroom on each.

**What the browser gave up, precisely — and what it did not.** Two different jobs, and the
difference is deliberate:

- `readMemberSummary` **validates for real**, field by field, because something acts on the result:
  a row this build cannot read is counted into `unreadable` and the roster says so (ADR 148). A
  guard that waved rows through would make that count a lie. `guards.test.ts` runs it and
  `MemberSummarySchema` over one 44-row corpus and asserts they accept, reject and normalize
  identically — including the legacy `idle` → `active` transforms and the `.default()` fills — so
  it cannot drift from the schema unnoticed.
- The response readers (lane board/result, audit, report, seed list) check the **envelope of the
  response** and fill the older-daemon defaults, and stop there. In the browser the deeper check had
  no consumer: nothing branches on it, the page renders typed fields it either has or doesn't, and a
  strict parse of a response from a **newer** daemon is precisely the ADR 148 failure `fetchRoster`
  was rewritten to stop — an unreadable page instead of a calm hint.

The write path is untouched: the daemon still parses every envelope and every lane body with zod on
ingest, which is the boundary that decides what becomes durable. `makeEnvelope` keeps its parse for
every caller inside the daemon; the browser composes with `buildEnvelope` and posts to an endpoint
that validates.

**Trap, for the next person here.** The lever is *reachability*, not import style. Adding a value
export to a `*.wire.ts` module that a zod module also imports is free; adding one that imports a
zod module is not, and the cost is invisible in the diff — it appears as a chunk. `grep -l ZodError
packages/web/dist/client/assets/*.js` after a build is the check, and it should print nothing.

- Falsify: `pnpm --filter @musterd/web build && pnpm perf:check` on the merge commit — total should
  read ≈228.6 KiB against 231.4 KiB (237,000 B), initial ≈132.0 KiB against 133.8 KiB, and the grep
  above should find no chunk.
