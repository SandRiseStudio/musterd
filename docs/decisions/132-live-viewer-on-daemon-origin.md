# 132 — The `/live` viewer is served by the daemon; `--live` becomes a build-publisher

- Status: accepted — 2026-07-12
- Date: 2026-07-12

## Context

ADR 124 made the `/live` viewer a managed service, which was the right instinct — it killed the
hand-started `pnpm dev` in a random worktree that kept serving stale, WIP-coupled bundles. But it
codified the wrong **transport**: the viewer is a **Vite dev server** (`pnpm dev --port 5173`) run as a
`KeepAlive` LaunchAgent, plus a second `StartInterval` agent that restarts it when `main` moves. Two
consequences fell out of that in daily use:

- **A dev server is running as production.** The `/live` dashboard is served unminified, with HMR
  machinery, from `:5173` — a *different origin* than the daemon (`:4849`), which only works because of
  the Vite proxy that forwards `/teams`/`/ws` and strips `Origin` (ADR 062 §Context). It's heavier, and
  it's indistinguishable from the throwaway `pnpm dev` servers a developer spins up in a feature
  worktree to preview WIP — so "is the change live, and on which port?" is a recurring confusion.
- **Two origins where one would do.** ADR 062 already built (and tested) the thing that makes a separate
  web host unnecessary: the daemon serves the built web bundle from its *own* origin (`--web-root`,
  same-origin WS gate). That capability shipped but was never wired into the deployment — "packaging
  deferred" (ADR 062 §Decision). So the one-origin path existed and sat unused while a dev server stood
  in for it.

The one genuinely valuable property ADR 124 delivered — **`/live` tracks `origin/main` with zero manual
steps, without bouncing the daemon** — must be kept. Members rely on the dashboard reflecting merged
work within a minute, and the daemon (a shared coordination backend) must not restart just to ship a UI
change (ADR 047).

## Decision

Serve `/live` from the **daemon's own origin** (ADR 062), and turn `--live` from a *dev server* into a
*build-publisher*.

1. **The daemon serves the UI.** The daemon runs with `--web-root <MUSTERD_HOME>/live/web` (a stable,
   service-owned directory, baked into the daemon's `serveArgs` by default). `GET /live` and assets come
   off `:4849` — the same origin as `/teams` and `/ws`, so no proxy, no CORS, and the browser's
   same-origin WebSocket passes the ADR 040 gate. When the web-root is empty (viewer never installed) the
   daemon 404s the UI and the API is unaffected — static-serve stays zero-impact off (ADR 062).

2. **`--live` is a single build-publisher**, not a two-agent dev-server bundle. One `StartInterval`
   LaunchAgent (`studio.sandrise.musterd-live`): on each poll, if `origin/main` moved past the viewer
   worktree (or nothing is published yet), it advances the dedicated `…/agents-live` worktree to
   `origin/main`, runs `pnpm --filter @musterd/web build`, and **atomically publishes** `dist/client`
   into the daemon's web-root (build into a staging dir on the same filesystem, then `rename` it into
   place — so a request never sees a half-written or emptied bundle, unlike serving a live Vite
   `emptyOutDir` build dir). The daemon serves the fresh files on the next request — **no daemon
   restart**. A failed web build keeps the previously-published bundle.

This keeps ADR 124's best ideas — a dedicated detached-on-`origin/main` worktree (so it never contends
for the `main` branch the daemon's checkout owns), everything generated from versioned builders in
`launchd.ts`, reboot-survival, one-command setup — and drops only the dev server and the redundant second
agent. `refresh --live` forces a publish now; `status --live` probes the daemon's `/live` (the real
serving surface) instead of a `:5173` dev port; `uninstall --live` also boots out the retired ADR 124
agents (`musterd-live` KeepAlive server + `musterd-live-sync`) so an in-place upgrade is clean.

The daemon's own `service refresh` is unchanged and still the path for *server*-side updates; it already
runs `pnpm -r build` (which builds the web app too), but the viewer's currency no longer depends on it.

## Consequences

- `/live` is one origin with its data (`http://<host>:<port>/live`), a production bundle, one background
  agent, and it still tracks `main` within the poll interval without ever bouncing the daemon. The
  `:5173` dev server, its proxy, and the second LaunchAgent are gone.
- The daemon's default `serveArgs` now carry `--web-root <home>/live/web`. This is inert until the
  publisher populates that dir, so API-only daemons and their tests are unchanged (the path simply has no
  `index.html`, and `serveStatic` 404s the UI — ADR 062).
- Dev-side WIP previews are unaffected: a developer still runs `vite dev` in their feature worktree to
  see un-merged changes; that is explicitly an inner-loop tool, now clearly distinct from *the* viewer
  (the daemon's origin), not a look-alike on a sibling port.
- macOS-only via the same `serviceSupported` seam as the daemon (ADR 045); a non-checkout packaged
  install can't build the web app, so `install --live` surfaces the `git worktree add` failure — a
  dev-side feature, acceptable.
- Supersedes ADR 124's transport (dev server on `:5173`). ADR 062 (daemon static-serve) is the mechanism
  this builds on and stays in force.

## Observability & Evaluation

- **Traces:** n/a — human-side, machine-local dev infra (a LaunchAgent that builds a static bundle + a
  daemon serving flat files). It emits no protocol acts and touches no team state; the daemon it feeds
  (`:4849`) is separately instrumented (ADR 089–091). Its own signal is the generated build log
  (`<home>/live/build.log`, surfaced by `service logs --live`) and the `status --live` daemon `/live`
  probe.
- **Eval:** n/a — a mechanical transport/hosting change (build + atomic publish + serve), no agent-facing
  model decision to score. Same class as ADR 045/062/118/124.
- **Experiment:** n/a — no behavioural variant; the pure builders and injected-runner lifecycle ops are
  covered by unit tests (`service/live.test.ts`, `service/launchd.test.ts`).
