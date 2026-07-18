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

| Chunk                 | Raw                                         | Gzip       |
| --------------------- | ------------------------------------------- | ---------- |
| index (entry)         | 320 KB                                      | 100 KB     |
| routes                | 114 KB                                      | 41 KB      |
| dist (protocol)       | 72 KB                                       | 18 KB      |
| render                | 38 KB                                       | 15 KB      |
| live                  | 33 KB                                       | 11 KB      |
| office-scene          | 25 KB                                       | 10 KB      |
| **All JS**            | **674 KB**                                  | **216 KB** |
| **All CSS**           | **125 KB**                                  | **38 KB**  |
| Fonts in dist (woff2) | 948 KB total; /live loads ~117 KB (7 files) | —          |

### Live-data latency (event → dashboard WS frame)

- Daemon handles the `POST /messages` in **~23 ms** (server-side, temp daemon).
- CLI probe start → WS frame at the page: **491–717 ms**, but the CLI process itself takes
  650–920 ms (Node startup + post-send inbox reads) — the daemon→page push is a small fraction.
  Treat **≤ ~100 ms send→pixel** as the real transport budget; the harness reports the
  CLI-bounded number (`cmdStartToFrameMs`).

## Optimization log

| Date       | Change                                          | Result (throttled Lighthouse)                                                                    |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 2026-07-18 | Finding #1: daemon br/gzip + Cache-Control/ETag | **49 → 71** · LCP 7.2 s → 4.3 s · FCP 5.5 s → 3.1 s · TBT 540 → 310 ms · transfer 1,077 → 471 KB |

## Findings, ranked by expected win

1. **~~The daemon serves everything uncompressed with zero caching headers.~~ SHIPPED (2026-07-18).**
   `sendFile` now negotiates brotli/gzip for text types (`Accept-Encoding`, compressed bytes cached
   so it's paid once), sets `Cache-Control: …immutable` on content-hashed `/assets/*`, and gives the
   app shell a weak ETag + `no-cache` that answers `If-None-Match` with a 304. Measured: entry chunk
   320 KB → 87 KB brotli, /live transfer **1,077 KB → 467 KB (−57%)**, throttled Lighthouse **49 →
   71**, LCP **7.2 s → 4.3 s**. Residual `uses-text-compression` (~85 KB) is the API JSON on the
   `/teams/*` path, which does not go through `serveStatic` — a separate lever.
2. **Entry chunk is heavy and half-unused.** `index-*.js` is 320 KB raw; Lighthouse estimates
   **154 KB of unused JS** on /live. The marketing-site code (LiquidGlass engine, Lenis, Hero,
   Roadmap) and the dashboard share one entry — route-level splitting should keep /live from
   paying for the landing page.
3. **Backfill render causes the LCP outliers and frame hitches.** The worst runs show a ~1 s
   long task during load and 460–790 ms worst frames in the runtime window, consistent with
   rendering the full `GET /messages` backfill in one commit (~6,900 DOM nodes). Windowing or
   incremental rendering of the stream would cap this.
4. **Fonts:** 948 KB of woff2 ships in dist across 5 families; /live pulls 7 files (~117 KB).
   Subsetting/limiting weights is a smaller but easy win.

## Prod-serving caveat (2026-07-17)

The shared daemon (:4849) was serving build `40065c5` — **14 commits behind main**, predating the
asks strip / speech bubbles / re-font. This baseline was taken against a fresh-main build on a
temp daemon instead. Any perf numbers eyeballed against the shared daemon are stale until a
`musterd service refresh`.
