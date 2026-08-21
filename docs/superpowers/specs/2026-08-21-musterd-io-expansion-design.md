# musterd.io expansion — multi-page public site

**Date:** 2026-08-21
**Author:** miley (design conversation with nick, in-session)
**Lane:** 01M0JVEWAGK3Q59RHPGRZ0E9DQ (`miley/musterd-io-expansion`, goal `launch`, stakes `normal`)
**Status:** approved design, pre-implementation

## Why

musterd.io today serves exactly one page: the immersive roadmap experience, prerendered and
deployed as the assets-only Worker `musterd-io`. That was right for a placeholder; it is wrong for
launch. A stranger arriving at musterd.io learns nothing about what musterd is, how to install it,
or that a team of agents is — right now, on a live Twitch broadcast — building the product itself.

This spec expands the site to four public surfaces: a product landing page, docs, a blog, and a
lighter roadmap, with the live broadcast embedded on the landing page.

## Decisions (made with nick, 2026-08-21)

1. **New lightweight hero.** The three.js/anime.js particle hero is retired from `/`. The new hero
   is typographic — CSS/SVG mustard-gradient treatment, the one-line pitch, install command, CTA.
   No WebGL remains anywhere on the public site (see decision 4).
2. **The stream is a contained section, not the hero.** Directly under the hero: a side-by-side
   "built by its own agents, live" section — story copy on the left, the Twitch player at ~45%
   width on the right, stacking on mobile. Channel: `sandrise_ai`
   (https://www.twitch.tv/sandrise_ai).
3. **Deferred embed, muted autoplay.** The prerendered HTML carries a static facade (poster
   frame, LIVE badge). An IntersectionObserver injects the real iframe
   (`player.twitch.tv/?channel=sandrise_ai&parent=musterd.io&muted=true`) when the section becomes
   visible. Rationale: hero paint and Lighthouse stay clean, while a visitor who sees the section
   counts as a concurrent Twitch viewer without clicking (muted playing embeds count; paused or
   offline ones do not). `preconnect` hints for `player.twitch.tv` / `static.twitch.tv` /
   `assets.twitch.tv`. Offline state: the Twitch player renders its own offline card; our
   surrounding copy reads correctly in both states.
4. **Roadmap moves to `/roadmap`, much lighter.** Same typed source of truth
   (`src/content/roadmap.data.ts`; `pnpm roadmap:gen` and ADR 041 untouched), rebuilt as a clean
   typographic timeline. three.js and the anime.js adapter leave the dependency tree entirely —
   the single largest weight drop available on this site.
5. **`/docs` is hybrid.** A hand-written Getting Started set (install, quickstart, concepts)
   authored for strangers, plus a generated reference section: a build step renders an explicit
   manifest allowlist of repo `docs/**` markdown files to prerendered pages. A manifest, never a
   glob — team docs stay team docs by default.
6. **`/blog` is a real section.** Markdown posts in `packages/web/content/blog/`, prerendered
   index at `/blog` and per-post pages at `/blog/<slug>`. `docs/launch-post.md` is adapted as
   post #1.
7. **No separate `/product` page.** The landing page is the product page: hero, stream section,
   what-is section (the pitch, the loop, the invariants), docs teaser, blog teaser. Split later
   only if the landing outgrows itself (YAGNI).
8. **Shared nav** across public routes: product (·/) · docs · blog · roadmap · GitHub. The nav
   carries a live badge when the stream is up (client-side check, absent from prerendered HTML).
9. **Copy is Sloane's.** This lane lands structure, routes, the embed, the pipeline, and
   placeholder copy clearly marked `[SLOANE]`. All real prose — landing pitch, what-is copy,
   stream-section story, Getting Started, launch-post adaptation — is handed off to the sloane
   seat (product-communications role) as a follow-up copy lane via musterd.
10. **Stakes `normal`, not the web default `low`** (ADR 244): the landing page asserts facts
    about the product.

## Architecture

### Routes (packages/web/src/routes/)

| Route | Content | Prerendered |
|---|---|---|
| `/` | new landing: hero, stream section, what-is, teasers | yes |
| `/roadmap` | typographic roadmap from `roadmap.data.ts` | yes |
| `/docs` | Getting Started index | yes |
| `/docs/<slug>` | hand-written pages + manifest-generated reference pages | yes |
| `/blog` | post index | yes |
| `/blog/<slug>` | posts from `packages/web/content/blog/*.md` | yes |

Daemon-connected surfaces (`/live`, `/board`, `/audit`, `/approvals`, `/broadcast`,
`/character-sheet`, `/office-preview`) are untouched and stay off the public origin.

### Components

- `src/components/site/` — shared public-site chrome: `SiteNav`, `SiteFooter`, layout shell.
  Public routes use this; daemon routes don't.
- `src/components/site/StreamSection.tsx` — the facade + IntersectionObserver embed. The observer
  logic is a small hook (`useDeferredTwitchEmbed`) so it is unit-testable without a browser.
- `src/content/docs.manifest.ts` — the explicit allowlist mapping repo `docs/**` files →
  `/docs/<slug>` pages (title, slug, source path). The generation step fails the build if a
  manifest entry's source file is missing.
- Markdown rendering at build time only (unified/remark already in the tree or the lightest
  option that passes `perf:check`; no client-side markdown runtime).

### Staging & deploy (scripts/stage-site.mjs)

`stage-site.mjs` grows an explicit `PUBLIC_ROUTES` allowlist: `/`, `/roadmap`, `/docs` (+ manifest
slugs), `/blog` (+ post slugs). Everything else still never reaches `dist/site`. The Worker config
(`wrangler.jsonc`) keeps `not_found_handling: "none"`; hashed assets referenced by the staged pages
are staged with them. Deploy remains `pnpm --filter @musterd/web deploy:site`.

### Records

One new ADR: **landing-page aesthetic evolution** — amends ADR 037 (the immersive hero leaves `/`;
the roadmap page keeps the aesthetic direction in reduced, WebGL-free form) and records the
public-route allowlist policy for the musterd.io origin.

## Performance & a11y (the package contract applies in full)

- `perf:check` byte budgets must pass; retiring three.js should *lower* `totalJsGzipBytes` — after
  the build, re-baseline numbers are appended to `docs/perf/web-live-baseline.md` (ADR 151).
- The Twitch iframe is third-party and outside the JS budgets, but never in the initial load: no
  iframe element exists in prerendered HTML; injection is post-paint and visibility-gated.
- Fonts: the three active families only; no new families.
- `a11y:check` sweeps the new routes; new colour work uses defined tokens (`tokens:check`).
- No new render loops; the facade is static DOM.

## Testing

- **Staging tests** (extend the `broadcast.stage.test.ts` pattern): every `PUBLIC_ROUTES` path
  exists in `dist/site`; every daemon route does not.
- **Embed tests**: `useDeferredTwitchEmbed` — no iframe before intersection, iframe with correct
  `channel`/`parent`/`muted` params after, observer disconnected after injection.
- **Docs generation**: manifest entry with a missing source fails the build; generated page count
  matches manifest length.
- **Blog generation**: index lists every post; slug pages render; a malformed post fails the build
  loudly.
- **Gates**: `perf:check`, `a11y:check`, `tokens:check` green over the expanded route set.

## Out of scope

- Real prose (Sloane's follow-up lane).
- A `/product` page separate from the landing.
- Live-viewer/board surfaces on the public origin (ADR 132/156 stand).
- Twitch VOD/clips integration; a "live now" API service. The live-badge check is a client-side
  fetch against Twitch's public unauthenticated surface if trivially available, else dropped —
  it never becomes a server.
- Analytics (separate decision).

## Premise corrections (2026-08-21, post-approval)

The design conversation inherited two stale premises from `packages/web/README.md`; nick approved
the intent, and the corrections only shrink the work:

1. **There is no three.js to retire.** The immersive roadmap map was dropped from the web on
   2026-07-28; three.js/anime.js are not in `packages/web/package.json`. Today's hero
   (`src/components/Hero/`) is a 2D-canvas office scene over a synthetic 5-member team. "New
   lightweight hero" = replace that canvas hero with a typographic one.
2. **`/roadmap` is a new page, not a move.** Roadmap data lives at repo-root
   `content/roadmap.data.ts` (82 items, build-time consumers only). The new `/roadmap` renders it
   via the build-prep pipeline — the dataset stays out of the browser bundle, honoring the comment
   in `src/content/site.ts` that moved it out.
3. **The nav live-badge is dropped** per this spec's own else-branch: Twitch's Helix API requires
   an auth token; there is no public unauthenticated liveness endpoint, and a liveness proxy would
   be a server. The embedded player itself communicates liveness.

## Sequencing

1. Site chrome + new landing structure (placeholder copy) + `/roadmap` rebuild; three.js leaves
   the tree; ADR written.
2. Staging allowlist + tests; deploy still green.
3. `/blog` (launch post placeholder) and `/docs` (Getting Started skeleton + manifest pipeline).
4. Stream section facade + deferred embed + tests; perf re-baseline recorded.
5. Handoff: copy lane to sloane; acceptance per ADR 244 at `normal` stakes.
