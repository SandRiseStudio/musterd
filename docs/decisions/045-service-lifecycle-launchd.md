# 045 — `musterd service`: daemon lifecycle as a macOS LaunchAgent

- Status: accepted
- Date: 2026-06-24

## Context

`musterd serve` runs the daemon in the **foreground** — it dies with its terminal. To keep a team's
daemon up across a closed terminal, a logout, or a crash, you have to hand-author a launchd plist and
drive it with raw `launchctl bootstrap`/`bootout`/`kickstart` incantations (which is exactly what we did
during dogfood — error-prone, undocumented, and easy to get subtly wrong: minimal launchd `PATH`,
versioned node paths, wrong domain target). That's too sharp an edge for the one piece of musterd a
user most needs to stay running.

The question raised: build CLI commands for this, or stand up an "admin/platform agent"? An agent is the
wrong tool for wrapping `launchctl` — it adds a nondeterministic loop in front of a deterministic,
one-shot OS operation. The lifecycle primitive belongs in the CLI; a future ops agent (if any) would
*call* these commands, not replace them.

## Problem

Give a first-class, scriptable way to run **the musterd daemon** as a background service that survives a
session and restarts on crash — **without** (a) raw `launchctl`, (b) a new runtime dependency, (c)
crossing the line into running *member* agents, or (d) coupling the daemon to the host.

## Decision

A new CLI command group, **`musterd service <install|uninstall|start|stop|restart|status|logs>`**, that
manages the daemon as a per-user **macOS LaunchAgent**.

### 1. The CLI manages musterd's *own* daemon — not member agents

This is the load-bearing boundary. musterd's principle is **"connects agents; it does not run them"**
(`deployment-topology.md`; the roadmap "Sandboxed runtime" item). `service` does not violate it: it
manages the lifecycle of **the coordination daemon itself** — infrastructure, not a Member — and it is
the **CLI** (a human-side, opt-in tool) doing it, not the daemon. This mirrors ADR 035's reasoning for
`notify`: a resident, client-side, opt-in process is fine; daemon→host coupling is not. The daemon stays
a clean core with no knowledge of launchd.

### 2. LaunchAgent (user domain), `RunAtLoad` + `KeepAlive`

`install` writes `~/Library/LaunchAgents/studio.sandrise.musterd.plist` and loads it into the
`gui/<uid>` domain — **no root**. `RunAtLoad` starts it at login; `KeepAlive` relaunches it on crash or
any exit (`serve` runs forever, so any exit is restart-worthy); `ThrottleInterval` blunts a crash-loop.
The verbs map to launchd primitives: `install` = write + `bootout`(ignored) + `bootstrap`; `start` =
`bootstrap`; `stop` = `bootout` (KeepAlive cannot relaunch a booted-out agent); `restart` =
`kickstart -k` (falling back to `bootstrap` from cold); `uninstall` = `bootout` + remove the plist;
`status` = parse `launchctl print` + probe `/health`; `logs` = tail `~/.musterd/daemon.{log,err.log}`.

### 3. Self-locating: embed the running node + bin, not hardcoded paths

The plist's `ProgramArguments` are `[process.execPath, <resolved argv[1]>, serve, …]` — the **exact node
binary and CLI entry that invoked `service install`**. This is self-correcting (a node upgrade or a moved
checkout is picked up by re-running `install`) and avoids the brittle versioned `node@22` path the
hand-authored plist used. launchd's `PATH` is set explicitly (node's dir + Homebrew + system) so child
shellouts (osascript/notify-send/tail) resolve. `--port`/`--host` flow into the embedded `serve` args.

### 4. No new dependency; macOS-only with a named cross-platform seam

`launchctl` is an OS tool we invoke via `child_process` (hard rule #6) — no npm package, mirroring ADR
035's `osascript`/`notify-send`. Pure helpers (`buildPlist`, the `launchctl` argv builders, status
parsing) live in `service/launchd.ts` and are unit-tested without touching `~/Library` or shelling out;
the runner is injected (`service/manage.ts`), exactly like `notify/os.ts`. `serviceSupported(platform)`
is the seam: **macOS now**; Linux (`systemd --user`) and Windows are the obvious next branches, and an
unsupported platform refuses with that guidance rather than half-working.

## Consequences

- **No raw `launchctl` for the user.** `musterd service install` supersedes the hand-authored plist
  (same label/path → overwrite + re-bootstrap, idempotent).
- **Survives sessions, restarts on crash, starts at login** — the daemon you most need up stays up.
- **Boundary intact.** The CLI manages musterd's own daemon; it does **not** become a process supervisor
  for member agents. A future ops/platform agent is a layer *on top* that would call these commands.
- **No SPEC/protocol change, no new dependency.** It rides existing primitives; the wire is untouched.
- **Dev-build caveat.** When `install` is run from a workspace checkout it embeds that checkout's
  `dist/bin.js`; a rebuild needs `musterd service restart` to take effect (KeepAlive does not hot-reload),
  and deleting `dist/` makes the agent crash-loop (throttled). A published global install avoids this.
- **macOS-only for now**; the comeback is `serve` under the user's own supervisor on other platforms
  until the systemd/Windows branches land.
