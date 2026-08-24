# Web performance — the /live arc, the gate, the public site, the measurement traps

What the byte gate covers, what it does not (page height, unlisted routes), and the traps that produce confident wrong numbers — the 2026-07 /live arc took Lighthouse 49 → 85 (transfer 1077 → 381 KB, DOM 4461 → 1564) and its ranked backlog is EXHAUSTED — the numbers live in docs/perf/web-live-baseline.md, and `pnpm perf:check` (ADR 151) gates the budgets in CI.

## The gate (ADR 151, #333)

`docs/perf/budgets.json`: total JS gzip, per-chunk, CSS, font bytes, font-family allowlist — baselines + 10 % headroom. Raise protocol: the increase goes in the same PR that needs it, with the measured cost appended to the baseline doc's optimization log. `perf:check` needs `pnpm build` first (dist is gitignored). `packages/web/AGENTS.md` carries the non-machine-checked contract (suspend unseen rAF loops, windowed lists, canvasFont tokens).

## Don't re-chase (findings that corrected the doc, 2026-07-19)

- "Entry chunk shares marketing code" — false; the entry is React 19 + TanStack runtime. Parked.
- `content-visibility: auto` on stream rows drifts placeholder sizes after manual anchoring — measured 3082 px; don't reintroduce.
- The "~1 s backfill long task" was one-run variance; the real cost was DOM weight (94 % of nodes), fixed by windowing (#328).

## Page LENGTH is a perf property too, and vh padding attacks it invisibly (2026-08-24)

The gate measures bytes. It does not measure how tall the page is, and on the public site that was
the thing actually wrong: musterd.io shipped at **desktop 2,657px / mobile 3,749px** of mostly air.

**Section padding sized in viewport HEIGHT grows a section on exactly the screens that already had
room.** `clamp(48px, 9vh, 104px)` gives its maximum on a tall window and its minimum on a short one,
so the page expands where it was already emptiest and tightens where it was already cramped —
backwards, and invisible on the author's machine, where one viewport height is the only one ever
seen. Two of the three biggest offenders were vh: `GetStarted` at `clamp(48px, 9vh, 104px)` and the
footer at `clamp(40px, 7vh, 80px)` plus a `clamp(40px, 8vh, 96px)` margin.

One width-based `--section-y` token (`clamp(22px, 2.4vw, 32px)`) now carries every section and the
footer. Measured in a browser against the built site, #1005 / `ef550f4d`: **desktop 2,657 → 1,931px
(−27%), mobile 3,749 → 2,874px (−23%)**, no horizontal scroll and nothing overflowing at 375px. CSS
gzip unmoved at 25.8 KB — this cost nothing the byte gate can see, which is the point.

Falsify: set a section's padding back to a `vh` clamp, then measure `document.documentElement.scrollHeight`
at two viewport HEIGHTS with the width held constant. If the claim is wrong the two readings match.

## Wide content scrolls in its own box, never the body (2026-08-24)

`/docs/spec` scrolled sideways on a phone: `scrollWidth` **686** against a 375px viewport, from a
`<table>` 667px wide with no overflow container (`Prose.css` had no `table` rule at all). The `<pre>`
blocks were already correct — `overflow-x: auto`, scrolling inside themselves — which is exactly the
shape the tables needed and did not have. Fixed in #1013 by wrapping each table at generation time
rather than `display: block` on the table, which fixes the overflow by dropping the table semantics.

Two things this cost that are worth carrying:

- **The CSS budget is effectively full.** Baseline 26,305 bytes gzip against a 26,400 budget — 95
  bytes of headroom, and `totalCssGzipBytes` has been raised twice since the last re-baseline. A
  30-line stylesheet addition did not fit; it took four trims to land at 26,394. **Six bytes is not
  headroom** — the next web change should re-baseline rather than shave.
- **Measure the way the gate measures.** A first reading said 156 bytes UNDER budget while the gate
  said over: `scripts/perf/check-budgets.ts` calls `gzipSync` at the DEFAULT level, and the reading
  had used level 9. Same family as the gzip-CLI-vs-zlib trap already recorded in `budgets.json`.
  Falsify: gzip the same dist at level 6 and level 9 and compare — if they agree, this is wrong.

## A green contrast gate only covers routes on its list (2026-08-24)

`scripts/a11y/contrast-gate.mjs` sweeps "one representative per template (Prose.css carries the
rest)". That premise holds only while every template's elements APPEAR on the representative, and it
broke the moment `.prose th/td` got colours: `/docs/getting-started` has no tables, so the new cell
colours would have shipped unmeasured behind a green gate. `/docs/spec` was added to the list in
#1013 (14 routes, 1,233 elements on that page alone, 0 below AA). Add a route whenever a rule paints
something no listed route renders.

## Measurement traps (falsify: re-run scripts/perf/live-baseline.mjs)

- Never restart the shared daemon — measure on a temp daemon over a `.backup` DB copy (see [temp-daemon-probe](temp-daemon-probe.md)).
- `/live?team=...` measures the CONNECTED page; without `?team` you get the shell, 2× lighter.
- `.musterd/binding.json` embeds `server:` and OVERRIDES `MUSTERD_CONFIG` — a CLI probe run from a worktree posts to prod; probe from a scratch dir with a rewritten binding.
- Lighthouse single runs are noisy (±7); median of 3. CDP `Network.*` timestamps are monotonic, not epoch. CLI `send` costs 650–920 ms of Node startup — never read CLI-bounded latency as transport latency.
- Presence on a DB copy decays in ~45 s, so an office on a temp daemon self-parks — send a probe act to make the room alive before measuring; and vite preview caches dist, so restart it after EVERY build or you measure blank pages.
