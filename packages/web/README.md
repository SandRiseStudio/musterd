# @musterd/web

The foundation of the musterd web surface. Today it serves one page — the **roadmap** — as a
bleeding-edge, immersive landing experience. It is built on the same stack the future stateful
dashboard will grow into, so that surface adds routes here rather than starting over.

## Stack

- **TanStack Start v1** (React 19, Vite + Rolldown) — type-safe file routing, SSR-capable, but the
  roadmap route is **prerendered to static HTML** for top load performance.
- **three.js** + the **anime.js Three.js adapter** — the immersive hero (a drifting mustard particle
  field; the entrance is timeline-driven through the adapter). Loaded client-only and code-split.
- **Liquid glass** — a single tasteful SVG-displacement refraction accent (ported from the reference
  CodePen), over DOM content only.
- Aesthetic direction and its guardrails: `docs/decisions/037-web-surface-aesthetic.md` +
  `docs/design/brand.md` §7. Content is the typed roadmap **source of truth**
  (`src/content/roadmap.data.ts`), imported directly here; **the repo's `ROADMAP.md` is generated
  from it** (`pnpm roadmap:gen`, ADR 041). Edit the data module, not `ROADMAP.md`.

## Develop

```bash
pnpm --filter @musterd/web dev       # http://localhost:5173
pnpm --filter @musterd/web build     # prerenders / → dist/client/index.html
pnpm --filter @musterd/web preview    # serve the build locally
pnpm --filter @musterd/web typecheck
```

The static artifact is `dist/client/` — deployable to any static host (Cloudflare Pages, Vercel,
Netlify, …). The page's text is in the prerendered HTML and never depends on JS; reduced-motion
users get a static gradient instead of WebGL.

## Serving

### musterd.io — the public landing page

```bash
pnpm --filter @musterd/web deploy:site   # build → stage → wrangler deploy
```

One command, three steps, and the middle one is the important one:

1. `pnpm build` prerenders **every** route, `/live` and `/board` included.
2. `pnpm stage:site` (`scripts/stage-site.mjs`) copies **only** `index.html` + `assets/` into
   `dist/site`, and prints the routes it withheld. This is a deliberate allowlist: `/live`,
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

- WebGL is client-only, lazy-initialized after first paint, DPR-capped, and paused when the tab is
  hidden; all GL resources are disposed on unmount.
- All heavy motion (WebGL, smooth-scroll, the liquid-glass lens) is gated behind
  `prefers-reduced-motion`.
- Chromatic aberration in the liquid-glass lens is left off — it is the expensive two-pass path the
  reference flags for mobile.
