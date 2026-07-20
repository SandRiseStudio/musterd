# 152 — Automatic daemon refresh: `service --auto` with a quiet-period policy

- Status: accepted — 2026-07-20
- Date: 2026-07-20

## Context

The `/live` web UI already tracks `origin/main` hands-free: a `StartInterval` LaunchAgent
(`studio.sandrise.musterd-live`, ADR 132/139) rebuilds and **atomically publishes** the bundle into
the daemon's web-root with no daemon restart. The daemon's own code has no such currency — shipping a
server change still requires a human to run `musterd service refresh` (ADR 118). The daemon on the
dogfood box routinely sits several commits behind `main`; the currency gap is real and manual.

ADR 118 (Not-in-scope) and ADR 130 (Non-goals) both named the same fast-follow and the same blocker:

> auto-refresh on merge … is the natural fast-follow, but it needs a **quiet-period policy** so it
> can't bounce the daemon mid-work; `refresh` is the manual primitive it would call.

The daemon differs from the `/live` publisher in one decisive way: a long-lived Node process can't
hot-swap its code (ADR 118), so a pickup **must bounce the process** — and a bounce drops every live
WebSocket for the reconnect window (the ADR 047 guard, and the ADR 131 §5 concurrent-wake incident,
both exist because a silent bounce surprised people). So the whole design question is _when_ it is
safe to bounce, not _how_ to build.

## Decision

Add a daemon auto-refresher as a third `service` target family (alongside `--live`/`--wake`), built
on the existing safe primitive rather than a new one.

### 1. `service refresh --auto` — one tick (the policy)

A new flavor of the `refresh` verb that decides _whether_ to refresh, then delegates the actual
sync+build+restart to the unchanged `refreshDaemon` (ADR 118) — which self-locates the daemon's own
checkout from its plist (PR #293), refuses on a dirty tree, and **aborts before the bounce on a build
failure**, so the daemon never lands on broken code. It **never re-installs** the plist, so it is
immune to the `process.execPath` node-ABI crashloop that only `install` can cause (the 2026-07-12
outage). The tick:

1. **Skew** — compare the daemon's running `/health.build` to `origin/main` (the numeric core of the
   ADR 130 skew note, now factored into a shared `countBehind`). Not behind → no-op. Unreachable or
   unknown ref → no-op. It never rebuilds or bounces a current daemon (watcher, never gatekeeper).
2. **Debounce** — record the tip it last _attempted_; if a tip's build already failed and the daemon
   still isn't on it, skip until a new commit lands, so a broken `main` can't rebuild every interval
   forever (mirrors the publisher's `.published-sha`).
3. **Quiet period (idle-else-notice)** — with **no** live sessions, refresh straight through (the
   ADR 047 guard passes cleanly). With live sessions: `--mode idle` **defers** (retries next tick);
   `--mode notice` (default) fires an OS notice to the operator and then **force-refreshes** — the
   announced, conscious bounce.

The `--mode` knob is the seed of an admin-configurable autonomy dial; the deeper on-call story (a
platform-guardian seat that owns a _team-facing_ announcement and richer remediation) is captured in
`docs/design/roles-and-stewardship.md`, not built here.

### 2. `service <verb> --auto` — the schedule

`install|uninstall|start|stop|restart|status|logs --auto` manage a dedicated `StartInterval`
LaunchAgent `studio.sandrise.musterd-autorefresh` that runs the tick on load and every `--interval`
seconds (default 120). It is **not** KeepAlive (the tick runs and exits), runs no server, and is safe
to bounce. No generated shell script: the logic lives in the testable `--auto` subcommand and the
plist runs `node bin.js service refresh --auto --mode <mode>` directly (the wake-host shape).

### 3. Graceful SIGTERM in the server

`launchctl kickstart -k` (how every bounce, now including the unattended one, restarts the daemon)
sends **SIGTERM**, which Node with no handler treats as an immediate kill — skipping the `db.close()`
checkpoint and leaving the reaper/telemetry unstopped. `serve` now handles SIGTERM the same as SIGINT
(`server.close()`), so an auto-refresh bounce is a clean stop. (WAL already made the DB crash-safe;
this adds the orderly checkpoint and a shutdown log line. WS connections are still force-closed, not
drained — clients reconnect on the ~2s blip, ADR 118; a true drain is a separate, larger change.)

## Observability & Evaluation

**Traces** — every tick appends a one-line verdict to `~/.musterd/autorefresh/refresh.log`
(`up to date`, `deferring (N live)`, `already attempted <sha>`, or the full `refreshDaemon` transcript
synced → rebuilt → restarted); `musterd service logs --auto` tails it. The bounce itself is traced by
the new `shutting down (SIGTERM)` line in `daemon.log` (a clean auto-refresh stop, distinct from a
crash), and the post-refresh `/health.build` change is surfaced to every connected session by the
existing skew/epoch warnings (ADR 130/135/148) with no new instrumentation.

**Eval** — the tick self-verifies mechanically. Dataset: the tick's decision surface — skew ∈
{0, >0} × connections ∈ {0, >0} × mode ∈ {idle, notice} × build ∈ {ok, fails, tip-already-attempted}.
Baseline: today's manual `service refresh` (a current daemon only when a human remembers to run it).
The 13 unit tests pin the headline invariants — never rebuild/bounce a current daemon; defer under
`idle` with live sessions; notify-then-force under `notice`; debounce a failed tip; no-op when
unreachable — and the SIGTERM path was verified live against a throwaway daemon (clean
`server.close()`, not a hard kill). Success measure in production: `/health.build` tracks
`origin/main` hands-free, with zero teammate reports of a surprise mid-work bounce and no rebuild
storm on a broken `main` (a stuck tip shows as a repeated `already attempted` line, not repeated
builds).

**Experiment** — this is the first automated actor that bounces prod, so the standing question is
whether the quiet-period policy holds under the real dogfood cadence. The probe: run `--mode notice`
on the live daemon for a stretch and watch (a) whether the ~2s announced reconnect is actually
disruptive to a working teammate (if so, `idle` or connection-draining is the lever), and (b) whether
the OS notice is the right channel or the announcement wants to be team-visible — the latter is
precisely the signal that motivates promoting this from a bare schedule to the platform-guardian seat
(`roles-and-stewardship.md`), whose `team_send` announcement and admin-set autonomy tier this ADR's
`--mode` knob is the narrow precedent for.

## Consequences

- The daemon now reaches currency the same way the web UI does — hands-free — closing the ADR 118/130
  fast-follow. The manual `service refresh` stays exactly as-is for deliberate, out-of-band refreshes.
- Opt-in: nothing changes until `service install --auto` is run. `--mode idle` is the zero-surprise
  setting (never bounces a live daemon); `notice` (default) trades a ~2s announced reconnect for
  currency while sessions are live.
- The bounce is still ungraceful for WS clients (force-closed, not drained). This is the accepted
  ADR 118 posture; if the reconnect blip proves disruptive under the automated cadence, connection
  draining is the follow-on.
- The `--auto` tick is the first, narrow instance of "an agent may act on running infrastructure under
  a policy." The general version — who may touch infra, and how much autonomy an admin grants — is the
  platform-guardian role captured for a later design dive (`roles-and-stewardship.md`).
