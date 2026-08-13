# The shared daemon on :4849

The dogfood daemon auto-refreshes itself on merge — never hand nick a `service refresh` chore; read `~/.musterd/autorefresh/refresh.log` instead, and know the three refresh traps before touching it.

## Autorefresh exists (verified 2026-08-03: 2775 runs, last exit 0; falsify: tail refresh.log after a merge)

A LaunchAgent syncs `/Users/nick/agents` to origin/main, rebuilds, and bounces the daemon + wake actuator on its own. State: `~/.musterd/autorefresh/refresh.log` and `.attempted-sha` (debounce stamp). To know whether the daemon has a merge, compare `curl -s 127.0.0.1:4849/health` → `build` against origin/main. ~~A dependency-adding merge failed the build and left the daemon silently pinned (2026-07-31, #565)~~ FIXED 2026-08-01 by #578 — `pnpm install --frozen-lockfile` runs whenever node_modules is out of sync with the lockfile, retrying every tick. ~~A live-session refusal could also pin the tip while notifying "did not build"~~ FIXED 2026-08-12 by #775.

**Reading status:** `musterd service status --auto` printing `✓ daemon auto-refresher: not running` is HEALTHY — launchd's literal state for an idle interval agent between ticks; the ✓ is the verdict. A genuine failure prints an explicit `✗` line. In the log, `✓ N live sessions — notified the operator, forcing the bounce` is normal operation.

## Refresh traps (dated as marked; falsify: read service.ts and the plist)

1. **`/Users/nick/agents` is a detached HEAD** (deliberate — the `agents-*` worktrees hold the branches). `git pull --ff-only` there is a silent no-op (found 2026-07-11); ADR 130 makes `service status` warn "N commits behind origin/main" and `/health` names the build commit.
2. **`musterd service install` embeds `process.execPath` into the plist.** The machine's default node is v20 but better-sqlite3 is compiled for Node 22, so installing from a plain shell crashloops the daemon (took it down 2026-07-12). `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` first. `service refresh` is safe — it never rewrites the plist.
3. ~~`service refresh` rebuilt the invoked CLI's checkout, not the daemon's~~ FIXED 2026-07-16 by #293 — refresh now reads the daemon's real checkout from its installed plist and rebuilds that.

## /live is served by the daemon (ADR 132)

`http://localhost:4849/live?team=revive` — one origin with its data; the old :5173 dev server is retired. A separate build agent publishes web updates with no daemon restart; force with `musterd service refresh --live`, logs at `~/.musterd/live/build.log`.
