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

## Serving (static now, daemon-serve later)

This is the **static now** half of the agreed plan. The **daemon-serve later** half — having
`@musterd/server` serve the built `dist/client/` from disk under a path, behind a flag — is
intentionally not wired yet (it would add untested surface to the server package's coverage-gated
core). When it lands it belongs in `packages/server/src/transport/http.ts`, which already does
manual path routing: a small static-file handler guarded by a config flag, pointed at this build
output. Tracked as a follow-up.

## Accessibility & performance notes

- WebGL is client-only, lazy-initialized after first paint, DPR-capped, and paused when the tab is
  hidden; all GL resources are disposed on unmount.
- All heavy motion (WebGL, smooth-scroll, the liquid-glass lens) is gated behind
  `prefers-reduced-motion`.
- Chromatic aberration in the liquid-glass lens is left off — it is the expensive two-pass path the
  reference flags for mobile.
