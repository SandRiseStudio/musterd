# @musterd/web

The musterd web surface. It serves the **public site** — the landing page plus `/roadmap`, `/docs`
and `/blog`, all prerendered to static HTML (ADR 302) — and the daemon-connected surfaces
(`/live`, `/board`, `/audit`, …) that only ever ship on the daemon origin. One stack for both, so
new surfaces add routes here rather than starting over.

## Stack

- **TanStack Start v1** (React 19, Vite + Rolldown) — type-safe file routing, SSR-capable; every
  public route is **prerendered to static HTML** for top load performance.
- **Typographic landing hero** — type-led, CSS-only (the earlier canvas office-scene hero, and the
  three.js particle hero before it, are both retired from `/`; the office scene lives on in
  `/live`).
- **Build-prep content pipeline** — `scripts/gen-site-content.ts` renders markdown (docs, blog) and
  the repo-root roadmap data to HTML strings at build time; no markdown runtime and no roadmap
  dataset in the client bundle.
- Aesthetic direction and its guardrails: `docs/decisions/037-web-surface-aesthetic.md` (as amended
  by ADR 302) + `docs/design/brand.md` §7. The roadmap **source of truth** is the repo-root
  `content/roadmap.data.ts`; **`ROADMAP.md` is generated from it** (`pnpm roadmap:gen`, ADR 041).
  Edit the data module, not `ROADMAP.md`.

## Develop

```bash
pnpm --filter @musterd/web dev       # http://localhost:5173
pnpm --filter @musterd/web build     # prerenders / → dist/client/index.html
pnpm --filter @musterd/web preview    # serve the build locally
pnpm --filter @musterd/web typecheck
```

The static artifact is `dist/client/` — deployable to any static host (Cloudflare Pages, Vercel,
Netlify, …). Every public page's text is in the prerendered HTML and never depends on JS.

## Serving

### musterd.io — the public site

```bash
pnpm --filter @musterd/web deploy:site   # build → stage → wrangler deploy
```

One command, three steps, and the middle one is the important one:

1. `pnpm build` prerenders **every** route, `/live` and `/board` included.
2. `pnpm stage:site` (`scripts/stage-site.mjs`) copies **only** the ADR 302 public set (the
   landing `index.html`, `assets/`, `roadmap/`, `docs/`, `blog/`) into `dist/site`, and prints the
   routes it withheld. This is a deliberate allowlist: `/live`,
   `/board`, `/audit`, `/approvals` and the previews are daemon-connected, so on a public origin
   with no daemon behind them they render dead UI — [ADR 132](../../docs/decisions/132-live-viewer-on-daemon-origin.md)
   puts the live viewer on the daemon origin and
   [ADR 156](../../docs/decisions/156-packaging-release-and-brew.md) keeps it out of packaged
   installs.
   The script fails rather than staging anything it did not expect.
3. `wrangler deploy` (pinned via `pnpm dlx`, so the deploy does not depend on whatever wrangler
   happens to be on your PATH) publishes `dist/site` as the assets-only Worker **`musterd-io`**,
   configured in [`wrangler.jsonc`](./wrangler.jsonc) with the `musterd.io` custom domain and
   `not_found_handling: "none"` — an unknown path 404s instead of falling back to the SPA shell and
   booting the board client-side.

The landing `<head>` is the share card: `og:image` / `twitter:image` point at the hashed
`src/brand/social-card.png` (source of truth `docs/design/assets/social-card.png`), which Vite
emits into `assets/` so it rides the existing stage allowlist. `og:title` is `musterd`, not the
retired roadmap title. After merge, `deploy:site` (or the next site publish) is what makes a
Slack/X unfurl pick up the new tags — the daemon's `/live` bundle is a different origin.

**Never point wrangler at `dist/client` directly** — that ships the whole prerender, which is the
one thing the staging step exists to prevent.

Wrangler is deliberately **not** a workspace dependency: `workers/*` sits outside the pnpm
workspace for the same reason, and a deploy-time CLI should not be in every contributor's install.
The version is pinned in the `deploy:site` script; bumping it is a deliberate edit.

### Daemon-serve (later)

The **daemon-serve** half — having `@musterd/server` serve the built `dist/client/` from disk under
a path, behind a flag — is intentionally not wired yet (it would add untested surface to the server
package's coverage-gated core). When it lands it belongs in
`packages/server/src/transport/http.ts`, which already does manual path routing: a small
static-file handler guarded by a config flag, pointed at this build output. Tracked as a follow-up.

## Accessibility & performance notes

- The public pages carry no render loops and no client-side content rendering; the only third-party
  frame (the landing page's Twitch player) is injected after first paint, visibility-gated, and
  never present in the prerendered HTML.
- Motion is gated behind `prefers-reduced-motion`; the perf contract and its gates live in
  [AGENTS.md](./AGENTS.md).
