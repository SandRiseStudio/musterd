# Web UI performance baseline — /live

**Date:** 2026-07-17 · **Commit:** `8932ef9` (main @ ADR 150 foundation) · **Author:** miley

First recorded performance baseline for the /live dashboard, taken after the recent feature wave
(ADR 149 asks strip #317, speech bubbles #321, re-font #322). All future perf-affecting changes
should be compared against these numbers by re-running the harness.

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

| Date       | Change                                               | Result                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-18 | Finding #1: daemon br/gzip + Cache-Control/ETag      | throttled Lighthouse **49 → 71** · LCP 7.2 s → 4.3 s · FCP 5.5 s → 3.1 s · transfer 1,077 → 467 KB                                                                                                      |
| 2026-07-18 | Finding #5: API JSON (`/teams/*` reads) compressed   | /live backfill Fetch **124 → 39 KB (−69%)** · transfer 467 → 381 KB · `uses-text-compression` audit cleared · throttled Lighthouse ~82 (median of 3), LCP ~3.6 s                                        |
| 2026-07-18 | Finding #3: stream DOM windowing (bounded rows)      | DOM **4,461 → 1,564** (audit 0 → 0.5) · TBT ~210 → **10–20 ms** · load long-tasks 120 ms–1 s → **53 ms** · heap 12 → 8 MB · worst frame 794 → 21 ms · score ~85                                         |
| 2026-07-18 | Finding #4: drop dead font families + izzocam canvas | dist **−503 KB** (Inter+JetBrains removed) · render-blocking `global.css` **56 → 14 KB** · office/character canvas now paint izzocam via type tokens · /live font download unchanged (7 files, ~117 KB) |

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
