# Verifying web changes in the Browser pane

Which instrument to reach for, and the specific ways the in-app Browser pane lies to you once you
are in it. Every trap below cost a seat real time, and each one reads as "my change broke the page"
when nothing is wrong.

## Reach for the cheapest instrument that answers the question (2026-09-01)

**chrome-devtools is the browser every seat uses. Playwright is not available** — nick, 2026-09-01:
"lets always use chrome-devtools-mcp for all musterd agents from now on. never playwright." The
`playwright@claude-plugins-official` plugin is disabled in `~/.claude/settings.json`, so this is
structural rather than a rule to remember; if you find yourself reaching for a `browser_*` tool that
is not there, that is why.

**Why**, measured the same day on this laptop (falsify:
`ps -eo rss,args | grep -E "playwright/mcp|chrome-devtools-mcp"`): six concurrent sessions were each
booting **both** MCP servers at startup — 25 processes, ~490 MB resident — with no Chromium running
at all and neither server called in most of those sessions. The standing cost was the idle servers,
not the browsers; the per-run cost is a whole second Chromium, where chrome-devtools drives the
Chrome already open.

**And often the answer is no browser at all.** `renderToStaticMarkup` from `react-dom/server` runs
in the existing vitest suite with no jsdom, no testing-library and no new dependency — React is
already a `packages/web` dependency. Worked example:
`packages/web/src/live/AsksStrip.render.test.ts` asserts what the asks rail renders for an ask past
its deadline, in ~1.6s. Two limits to state when you use it: effects never run, so it sees the first
frame only; and the suite's `include` is `*.test.ts`, not `.tsx`, so build the tree with
`createElement` rather than widening a repo-wide glob for one file. Use a browser when the question
is genuinely about paint, layout or a real event loop — not to read markup you could have rendered.

## The pane's own lies

The in-app Browser pane lies in three specific ways — a stale vite preview, a permanently hidden document, and React-batched clicks — and each one reads as "my change broke the page" when nothing is wrong.

## The traps (2026-07-28, each cost real time; falsify: reproduce in the Browser pane)

- **`vite preview` caches dist at server start** — after every web build, stop and restart the preview or the served HTML points at chunk hashes that 404 and the page renders blank with no console error (~30 min lost to a false "my change broke the route").
- **The Browser pane always reports `document.hidden === true`**, so visibility-gated code appears dead. Override the getter (`Object.defineProperty(document, 'hidden', {get: () => !window.__visible})`) and dispatch `visibilitychange` to exercise both branches.
- **Two `.click()`s in one JS statement are batched by React** — both read the same stale state, so a toggle appears broken. Click, return, then read.
## Verifying the PUBLIC site (2026-08-21, ADR 302; each cost real time)

The public routes are prerendered content, which breaks the habits above in three more ways. Falsify
any of these by rebuilding `packages/web` and repeating the step described.

- **`pnpm stage:site` deletes and recreates `dist/site`, so a static server started before it keeps
  serving the DELETED directory.** The server answers 200 with old chunk hashes forever, and the
  page you are measuring is the previous build. It cost ~20 minutes and two "my CSS fix did not
  work" conclusions — the built CSS on disk had the fix, `getComputedStyle` in the page did not.
  **Restart the server after every stage**, and when a fix appears not to apply, compare the
  stylesheet hash the page loaded against the one on disk before touching the CSS again.
- **`vite preview` serves the app shell only, so a content route looks empty.** A prerendered
  `/docs/<slug>` is ~8 KB of real text on disk but ~12 KB of shell through preview, with no body
  copy. Serve `dist/client` (or the staged `dist/site`) with a plain static server instead.
- **Grepping the built HTML for a link finds nothing even when the link is there.** Content routes
  serialize their HTML into the hydration payload, so an anchor is on disk as
  `\x3Ca href=\"/docs/spec\">`, invisible to `grep 'href="/docs/spec"'`. Grep the escaped form, or
  serve the page and click it (sloane, verifying #989).

## More pane traps

- **`resize_window` reports success and the viewport does not move.** It returns
  "Successfully resized window ... to 375x812" and `innerWidth` stays exactly where it was —
  measured 1155 across two consecutive resize attempts on 2026-08-24, while `outerWidth` read 679,
  so the two disagree with each other as well. Anything width-dependent measured in the pane after a
  resize is therefore measured at the WRONG width, with a success message on the record saying
  otherwise. Use chrome-devtools `emulate {viewport: "375x812x3,mobile,touch"}`, which does set it
  (`innerWidth` 375 immediately after); `resize_page` alone also fell short, landing at 500.
  Falsify: resize the pane and read `innerWidth` — if the claim is wrong it equals the width asked
  for.
- **Screenshots land in the repo, and nothing was ignoring them (2026-09-01; falsify: take one and run `git status`).** The Playwright MCP server writes `page-*.yml` snapshots and `console-*.log` beside every screenshot in `.playwright-mcp/`, and a `filename` with no directory lands in the **repo root**. Neither path was gitignored: one worktree held 102 files / 5.4 MB there plus 3.6 MB of loose root PNGs, and 16 of the `.yml` were swept into two unrelated PRs (#960, #996) by `git add -A` — nobody noticed, because a page snapshot in a diff looks like nothing. `.playwright-mcp/` is ignored as of #1149 (dolly caught this reading #1148, which is her own ADR 338 drift re-run page); **name screenshots into it** (`filename: '.playwright-mcp/thing.png'`), never bare, or they land in the root where nothing ignores them.
- `computer {action:'zoom'}` is not supported in the pane — to inspect a region of a tall canvas, `drawImage` the crop into a `position:fixed` overlay canvas on a rAF loop.
