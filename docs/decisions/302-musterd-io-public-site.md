# 302 — musterd.io is a public multi-page site

- Status: accepted
- Date: 2026-08-21
- Deciders: nick (design conversation, in-session), miley (carried)
- Relates to: ADR 037 (web-surface aesthetic — the hero treatment this amends), ADR 132 (live
  viewer on the daemon origin), ADR 156 (/live out of packaged installs), ADR 041 (roadmap single
  source), ADR 151/183 (perf budgets the expanded site stays under), ADR 244 (web-lane stakes —
  this work declared `normal`), lane 01M0JVEWAGK3Q59RHPGRZ0E9DQ

## Context

musterd.io served exactly one route: the landing page, staged out of the full prerender by an
allowlist (`index.html` + `assets/`) and deployed as the assets-only Worker `musterd-io`. The page
said what musterd is in two strings and an install section; a stranger could not read docs, find a
launch narrative, see the roadmap, or discover that a team of agents builds musterd itself on a
live Twitch broadcast (twitch.tv/sandrise_ai).

Two premises about this package were stale in its own README and had to be corrected before
deciding anything: the three.js particle hero was already gone (2026-07-28 dropped the immersive
roadmap; the hero since then is a 2D-canvas office scene over a synthetic team), and the roadmap
dataset already lives at the repo root (`content/roadmap.data.ts`) with build-time consumers only —
moved out precisely so its ~82 items never ride the browser bundle.

## Decision

**musterd.io serves a public set of prerendered routes: `/`, `/roadmap`, `/docs/**`, `/blog/**`.**
The set is enumerated in `packages/web/scripts/stage-allowlist.mjs`; `stage-site.mjs` stages
exactly that set and fails on anything unexpected. Adding a route to the public origin is a deploy
decision made by editing that allowlist — never a side effect of adding a route to the app. The
daemon-connected surfaces (`/live`, `/board`, `/audit`, `/approvals`, `/broadcast` and the
previews) stay off this origin; ADR 132/156 stand unchanged.

**The landing hero is typographic.** The canvas office-scene hero leaves `/`; the hero is type on
the warm mustard ground — the ADR 037 aesthetic direction (palette, type families, honest copy per
brand.md) continues, its "immersive centrepiece" treatment does not. The office scene remains what
it became: a `/live` surface.

**Content is rendered to HTML at build-prep time.** `scripts/gen-site-content.ts` renders the
docs manifest (an explicit list of repo files — a publish decision per entry, never a glob), the
blog posts (`packages/web/content/blog/*.md`), and the roadmap data into a generated module of HTML
strings that routes render directly. No markdown runtime, no roadmap dataset, and no new dependency
reaches the client bundle; `marked` is a devDependency the browser never sees.

**The Twitch broadcast embeds on `/` as a deferred iframe.** The prerendered HTML carries a static
facade only; an IntersectionObserver injects the `player.twitch.tv` iframe (channel `sandrise_ai`,
muted autoplay) when the section becomes visible. First paint owes Twitch nothing but two
`preconnect` hints; a visitor who sees the section counts as a concurrent Twitch viewer without a
click. There is no nav "live" badge: Twitch exposes no unauthenticated liveness endpoint, and a
liveness proxy would be a server this origin deliberately is not.

## Amendment — 2026-09-01: the public set includes crawler and agent text files

**`robots.txt`, `sitemap.xml`, `llms.txt` and `_headers` ship on this origin**, generated into the
build by the `musterd-site-files` plugin (`packages/web/scripts/site-files.ts`) and added to
`PUBLIC_ALLOW`. Measured on production the same day, musterd.io served none of them: `/sitemap.xml`,
`/llms.txt` and `/.well-known/*` all 404, and `/robots.txt` was Cloudflare's Managed content-signals
boilerplate — no rules, no `Sitemap:` line, and nothing in this repo produced it.

They are admissible under the original decision rather than an exception to it. The allowlist exists
to keep daemon-connected surfaces off an origin with no daemon behind them; these are static text
with no client to boot, so the failure the allowlist guards against cannot occur. `_headers` is read
by Cloudflare and never served.

The URL list is derived from `DOCS_MANIFEST` and the blog filenames — the same two sources the pages
come from — so publishing a doc cannot leave it unlisted. `site-files.test.ts` pins every advertised
path against `PUBLIC_ALLOW`: a sitemap entry the deploy withholds is a 404 we sent a crawler to find.

Two things this cannot do from the repo, both dashboard-only on the musterd.io zone:

1. **Cloudflare's Managed robots.txt overrides the file we ship.** Until it is turned off, our
   `robots.txt` is inert. `llms.txt` and `sitemap.xml` are unaffected and work immediately.
2. Cloudflare does not edge-cache these content types by default; without a Cache Rule they serve
   `DYNAMIC` and the `_headers` TTLs never take effect at the edge.

Deliberately not done here: a `_redirects` file. The duplicate origin worth removing is the
`workers.dev` one, and `workers_dev: false` in `wrangler.jsonc` removes it outright rather than
301ing it — a deploy-behaviour change, so it belongs to whoever runs the deploy (ADR 308), not to
this lane.

## Consequences

- The launch surfaces (product story, docs, launch post) gain a public home; copy is
  placeholder-grade until the sloane seat's product-communications lane replaces it.
- The stage allowlist grows from 2 entries to the public set, and its disjointness from the daemon
  routes is now asserted by tests rather than only by review.
- Retiring the canvas hero removes the landing page's only render loop; the perf budgets (ADR
  151/183) are unchanged by decision — measured movement is logged in
  `docs/perf/web-live-baseline.md` as always.
- The falsifier for the embed choice: if muted autoplay embeds stop counting toward Twitch
  viewership (a Twitch policy change), the deferred-load design loses its "count everyone" half and
  the click-to-play facade becomes strictly better; revisit then.

## Observability & Evaluation

**Traces.** Nothing new server-side — the site is static assets on a Worker with observability
already enabled (`wrangler.jsonc`); Cloudflare's request logs are the traffic signal. Build-time,
`stage-site.mjs` prints staged vs withheld routes on every deploy, which is the allowlist acting
observably.

**Eval.** Dataset: the staging allowlist tests (`packages/web/scripts/stage-site.test.ts` — public
set vs daemon set, written red-first) plus the route/embed source assertions
(`site-routes.test.ts`, `streamSection.test.ts`, `landing.test.ts`). Baseline: pre-change the
allowlist stages 2 entries and `dist/client/index.html` mounts the canvas hero; post-change it
stages the public set and the landing HTML contains no `<iframe>` and no office-scene mount.
Success: all gates green (`perf:check`, `a11y:check`, `tokens:check`) with measured deltas logged
in `docs/perf/web-live-baseline.md`.

**Experiment.** n/a — a publishing decision with no behavioral hypothesis to test in production;
the one open empirical question (whether muted-autoplay embeds keep counting as Twitch viewers) is
Twitch's policy to change and is recorded above as the falsifier, not run as an experiment.
