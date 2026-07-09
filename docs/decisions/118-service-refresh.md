# 118 — `musterd service refresh`: one-command "run latest main" for the daemon

- Status: accepted — 2026-07-08
- Date: 2026-07-08

## Context

The daemon runs **built dist** (`dist/bin.js serve`, via a LaunchAgent, ADR 045), and a long-lived
Node process can't hot-swap its code. So making merged work go live is a three-step dance —
`git pull` → `pnpm build` → `service restart` — that also has to be run **in the daemon's own
checkout**, not a worktree. This session hit every sharp edge of doing it by hand:

- The shared checkout was parked on a **stale feature branch**, so a `git pull` refused (diverged) and
  a build silently produced old dist — the refresh looked done but wasn't.
- It's easy to rebuild dist but **forget the restart** (the running process keeps serving old code), or
  restart onto a **broken build**.
- You have to *know* a change was server-side at all: a CLI-only change needs no restart, an MCP-adapter
  change needs a client reconnect, only a **server** change needs the daemon bounced.

The restart itself is cheap (newest-wins reconnect, ADR 017/092, makes it a ~2s blip) — the cost is the
manual, order-sensitive, easy-to-half-do dance.

## Decision

Fold the dance into one guarded verb, `musterd service refresh`, that always leaves the daemon running
**latest `origin/main`, freshly built** — or refuses cleanly without side effects.

Sequence:

1. **It's a checkout.** Refuse if the daemon isn't running from a git repo (a packaged install can't
   rebuild itself from source) — with a message pointing at where it *does* run from.
2. **Don't clobber.** Refuse if the checkout has uncommitted changes (someone mid-edit) rather than
   discard them.
3. **Guard the bounce** exactly like `restart`/`stop` (ADR 047): refuse while teammates hold live
   sessions unless `--force`, checked **up front** so a no-`--force` refresh fails before any sync/build
   side effect.
4. **Sync to `origin/main`, detached.** `git fetch origin main` then `git switch --detach origin/main`
   — detached so the daemon's checkout can't drift onto a stale branch (the exact snag above); prints
   `before → after` SHAs.
5. **Build.** `pnpm build`; a failed build **aborts before the restart**, so the daemon never bounces
   onto broken code (it keeps serving the previous, working build).
6. **Restart** onto the fresh build.

All shelling-out goes through the injected `ctx.run` runner, so the verb is unit-testable without a
real repo, daemon, or `launchctl` (the existing `service` test seam).

Not in scope (deliberately): **auto-refresh on merge** (a cron/post-merge hook that keeps the daemon on
latest main hands-free) is the natural fast-follow, but it needs a quiet-period policy so it can't bounce
the daemon mid-work; `refresh` is the manual primitive it would call. A dev **watch-daemon**
(`tsx watch … serve`) for the inner hacking loop is a separate, opt-in concern (too flappy for the
standing daemon).

## Consequences

- Making merged work live is **one command** (`musterd service refresh`) instead of three + judgment,
  and it self-heals the "checkout stranded on a stale branch" failure by always syncing to `origin/main`.
- **Fail-safe ordering:** dirty-tree and live-session refusals happen before any change; a build failure
  never bounces the daemon. The worst case leaves the daemon exactly as it was.
- It only helps a **source-run** daemon (the dogfood + self-hosted case). A future packaged/npm-global
  daemon would refresh via its package manager — `refresh` says so instead of doing something wrong.
- Doesn't remove the *restart* (inherent to a compiled long-running server) — it removes the friction
  and the footguns around it.

## Observability & Evaluation

**Traces** — no runtime span; this is a lifecycle command. Its effect is visible in the daemon's own
`/health` (schema/version) before vs. after and in the `before → after` SHA it prints. `n/a` for
`@musterd/telemetry`.

**Eval** — the metric is **stale-daemon incidents** (the running daemon serving code older than
`origin/main`, e.g. a rebuild that skipped the restart or built a stale branch) and **manual refresh
steps** per "go live". *Dataset:* the daemon's served version vs. `origin/main` HEAD; the command count.
*Baseline:* this session — a rebuild stranded on a feature branch (silent stale dist) and the repeated
3-step manual dance. *Target:* one command per go-live; zero stale-daemon incidents from a half-done or
mis-branched refresh (the dirty/branch/build-fail guards make each a clean refusal, not a silent
half-state).

**Experiment** — before/after is the same task ("make merged main live"): *before* = `pull && build &&
restart` run by hand in the right checkout, with the branch-drift and skip-restart failure modes;
*after* = `musterd service refresh`, verified by the unit tests (syncs+builds+restarts on the happy
path; refuses on a dirty tree, on live sessions without `--force`, and aborts before restart on a build
failure).
