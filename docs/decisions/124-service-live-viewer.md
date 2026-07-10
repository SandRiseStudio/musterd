# 124 — `musterd service --live`: the /live web viewer as a self-updating managed service

- Status: accepted — 2026-07-10
- Date: 2026-07-10

## Context

The web `/live` view (the split-canvas office + team stream, ADR 061/079/086) is served by a Vite dev
server. During dogfooding that server was just a bare `pnpm dev` a human started by hand in some
worktree, and it bit us repeatedly:

- It ran from an **agent's edit worktree** (`agents-stanley-izzo`), which was a commit behind `main`
  **and** carried that agent's uncommitted work — so `/live` served a stale, WIP-coupled bundle. A UI
  change that had already merged (the rich stream render, #211) didn't show, and diagnosing "why is the
  page unchanged" cost real time.
- Two git worktrees can't check out the `main` branch at once, so "just run it from a main worktree"
  isn't a stable answer — the running daemon's checkout owns `main`.
- Once fixed by hand it was a pile of untracked shell scripts + plists in `~/.musterd/live/`: not
  reproducible on another machine, not versioned, not tested, and it died on reboot.

The daemon already had `musterd service` (ADR 045) for exactly this class of problem — "run a long-lived
thing as a managed LaunchAgent" — and `service refresh` (ADR 118) for "get it onto latest main." The
viewer is the same shape of problem and deserved the same treatment, not a bespoke one-off.

## Decision

Make the `/live` viewer a **first-class managed service** under the existing `service` command, selected
with **`--live`**. `musterd service <verb> --live` retargets every verb at the viewer instead of the
daemon.

The viewer is a **two-agent bundle** in the user's launchd domain:

- **`studio.sandrise.musterd-live`** — a `KeepAlive` dev server. Its script (`~/.musterd/live/serve.sh`)
  checks out the tip of `origin/main`, rebuilds the one workspace dependency the web app imports as
  built dist (`@musterd/protocol`), then `exec pnpm dev --port 5173`.
- **`studio.sandrise.musterd-live-sync`** — a `StartInterval` (60 s) main-tracker. Its script polls
  `origin/main`; when it has moved past the viewer worktree, it `launchctl kickstart -k`s the server,
  which re-syncs, rebuilds, and reserves. So **`/live` tracks `main` with no manual step.**

A **full restart on change**, rather than an in-place `git checkout` under the running server, is
deliberate: it reliably reloads the open browser tab and covers every change type (web source, protocol
dist, dependencies) with one mechanism. The cost is a ~few-second reconnect blink per merge, which is
fine for a viewer.

Supporting decisions:

- **Codified, not hand-authored.** Both scripts and both plists are **generated** from versioned
  builders in `launchd.ts` (`buildLiveServeScript` / `buildLiveSyncScript` / `buildLiveServePlist` /
  `buildLiveSyncPlist`), so the setup is reproducible on any machine and unit-tested, exactly like the
  daemon's `buildPlist`. `renderPlist` is refactored to be the single XML template all three agents
  share.
- **A dedicated detached-on-`origin/main` worktree** (`…/agents-live`, a sibling of the daemon's
  checkout, added from it since they share the object store). Detached means it **never claims the
  `main` branch**, so it can't contend with a worktree that wants to commit on main, and it's never an
  edit surface — the bundle keeps it exactly at `origin/main`.
- **No shared-daemon guard.** The ADR 047 live-session guard exists because bouncing the daemon drops
  teammates' sessions. The viewer drops nothing but a dev-side web tab, so `--live` ops skip the guard
  (and never call `/health`).
- **`refresh --live`** forces the sync now (`kickstart`), for when you don't want to wait for the next
  poll. `status --live` reports both agents and probes whether `:5173` is actually serving (not just
  "agent loaded"). `uninstall --live` removes the generated artifacts but **leaves the worktree** (a
  checkout with `node_modules` is expensive to recreate) unless `--purge`.

## Consequences

- `/live` is always the latest `main` with zero manual work, survives reboot, and is set up with one
  command (`musterd service install --live`) instead of hand-copied scripts.
- macOS-only, via the same `serviceSupported` seam as the daemon (Linux `systemd --user` / Windows are
  the named future work). A non-checkout (packaged) install can't build/serve the web app, so
  `install --live` surfaces the `git worktree add` failure — acceptable, it's a dev-side feature.
- The viewer reads its data from the daemon (`:4849`), independent of which checkout serves the bundle —
  so the two services are cleanly separable.
- This keeps musterd's "connects agents, does not run them" line intact: the viewer is human-side
  observability infra, like the daemon service and `notify`, not a member agent.

## Observability & Evaluation

- **Traces:** n/a — this is human-side, machine-local dev infra (a LaunchAgent that runs a Vite dev
  server), not an agent-facing coordination path. It emits no protocol acts and touches no team state;
  the daemon it points at (`:4849`) is separately instrumented (ADR 089–091). Its own signal is the two
  generated log files (`~/.musterd/live/{viewer,sync}.log`), surfaced by `service logs --live`, and the
  `status --live` server probe.
- **Eval / Experiment:** n/a — a purely mechanical process-lifecycle feature (generate scripts/plists,
  bootstrap launchd agents), like ADR 045/118. Correctness is covered by unit tests over the pure
  builders and the injected-runner lifecycle ops (`service/live.test.ts`), not a dataset/baseline.
