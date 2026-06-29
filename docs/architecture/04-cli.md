# 04 — CLI (`@musterd/cli`, bin `musterd`)

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

The human surface. `npx`-installable, bin name `musterd`. Talks to the server over HTTP (one-shots) and WS (`inbox --watch`). Depends on `@musterd/protocol`; never imports `@musterd/server`.

**The exact output of every command is specified by the Figma terminal frames** (`docs/design/figma-brief-terminal.md`, page `Commands`/`States`). Where this doc and those frames disagree, that's a bug → ADR. Colors follow `brand.md` §2 ANSI mapping.

## Stack

- Arg parsing: a small dependency-light parser (`cac` or `mri`); pick one, record in ADR if it adds a dep. Help text mirrors this doc.
- Color: `picocolors` (tiny). Respect `NO_COLOR` and non-TTY (strip ANSI when piped).
- HTTP: global `fetch`. WS: `ws`.
- The CLI is also the launcher for the daemon: `musterd serve` starts `@musterd/server` (the one place the CLI process may spawn/require the server, via the published package or a sibling workspace dep — record which in ADR).

## File tree `packages/cli/src/`

```
src/
  bin.ts              // shebang entry; parse argv; dispatch; map errors -> exit codes
  args.ts             // argv parser → { command, positionals, flags }
  config.ts           // load/save ~/.musterd/config.json; per-folder binding lookup
  client.ts           // HttpClient + WsClient wrappers over the 02-protocol API
  roster.ts           // durable seat-file writer: buildSeat + writeSeatFile (ADR 058 §5, file = single writer)
  version.ts          // cliVersion(): read @musterd/cli package.json version for `musterd --version` (ADR 067)
  errors.ts           // CliError(code) -> message + exit code
  render/
    theme.ts          // ANSI roles from brand.md (online dot, member colors, act badges)
    rows.ts           // renderMessageRow, renderStatusTable, renderBanner, renderPresence
  notify/             // the `musterd notify` human-reachability nudge (ADR 024/035)
    os.ts             // OS push notification (macOS/Linux/Windows)
    select.ts         // pick which away human to nudge
  service/            // `musterd service` daemon lifecycle as a macOS LaunchAgent (ADR 045)
    launchd.ts        // pure: plist generation + launchctl argv builders + status parsing (platform seam)
    manage.ts         // install/uninstall/start/stop/restart/status + log tail (injectable launchctl runner)
  onboard/            // the `musterd init` interactive onboarding (@clack/prompts; ADR 005)
    init.ts           // the flow: daemon -> folder-check -> team -> intent -> where-it-runs -> configure -> primer -> wait-to-join
    doctor.ts         // inspectProvisioning(cwd) + `init --check`: primer↔server drift detector, read-only (ADR 060)
    workspace.ts      // provisionWorkspace(name): git worktree / sibling folder for an isolated agent seat (ADR 065)
    guard.ts          // inspectInitTarget(cwd): pure folder-suitability heuristics → warnings (ADR 020)
    harness.ts        // adapter interface (detect + configure); ConfigureResult carries activation/target/scope/secretPath
    mcpEntry.ts       // resolve how to launch @musterd/mcp + build the binding env
    manifest.ts       // provision manifest read/write (ADR 030) — records what init wrote, for uninstall
    pending.ts        // client-side pending-presence markers (ADR 033)
    primer.ts         // renderPrimer + idempotent upsertPrimer → AGENTS.md agent primer (ADR 012)
    role.ts           // Role = harness-agnostic provisioning template; resolve/apply (ADR 026/029/038)
    roles/builtins.ts // the shipped built-in role template seed library
    harnesses/
      index.ts        // registry of supported run targets (pluggable)
      claudeCode.ts   // detect/configure via the `claude mcp` CLI (`-s local`, this folder only)
      cursor.ts       // detect/configure via .cursor/mcp.json (ADR 006 adds the `cursor` surface)
      codex.ts        // detect/configure via project-local .codex/config.toml (ADR 031)
      codexToml.ts    // TOML read/merge helper for the codex adapter
  commands/
    init.ts           // musterd init (delegates to onboard/init.ts); --check → onboard/doctor.ts drift report
    agent.ts          // musterd agent <name>: add an agent + isolated worktree + binding + MCP register (ADR 065)
    serve.ts          // musterd serve [--port]
    service.ts        // musterd service install/uninstall/start/stop/restart/status/logs (ADR 045)
    team.ts           // team create / team add / team remove / team export (ADR 058 db→file migration)
    fmt.ts            // musterd fmt [--check] — canonicalize .musterd roster files (ADR 058 guard 2)
    join.ts           // join
    send.ts           // send
    inbox.ts          // inbox [--watch] [--wait] (ADR 054)
    nudge.ts          // print directed acts waiting for this seat — the approval-prompt hook target (ADR 053)
    whoami.ts         // print the seat this folder resolves to: member/team/surface/source (ADR 067)
    status.ts         // status
    availability.ts   // set your own availability axis: available/away/dnd (ADR 044)
    claim.ts          // claim a seat by name or open role (ADR 032/034/036)
    unbind.ts         // release this folder's own seat — clears bound_at + presence, keeps it declared (ADR 058)
    reload.ts         // SIGHUP the service daemon to re-resolve roster roots + reconcile (ADR 058)
    reclaim.ts        // operator force-drop of a member's stuck live session (ADR 017 follow-up)
    notify.ts         // human-reachability nudge loop (ADR 024/035)
    role.ts           // role list / show / create (ADR 029/038)
    reset.ts          // local clean-slate db + config wipe (ADR 022)
    uninstall.ts      // per-folder uninstall — unwinds what init wrote (ADR 027)
    helpers.ts        // shared command helpers (active-identity resolution, ADR 036)
```

## Config file `~/.musterd/config.json`

```jsonc
{
  "server": "http://localhost:4849", // base URL; ws derived by swapping scheme
  "current": "dawn", // current team slug (default for commands)
  "identities": {
    // per (team) -> the member you act as + token
    "dawn": { "name": "nick", "token": "mskd_...", "surface": "cli" },
  },
  "bindings": {
    // ADR 020: tokenless registry, keyed by abs folder path
    "/Users/nick/proj/web": { "team": "dawn", "member": "Ada", "surface": "claude-code" },
  },
}
```

- `MUSTERD_SERVER` env overrides `server`. `--team <slug>` overrides `current`. `--as <name>` selects identity within a team.
- Tokens live here (chmod 600 on write). Never logged.
- `bindings` (ADR 020) records _where_ each member is bound, so init can warn on cross-folder name reuse (`nameBoundElsewhere`). It is **tokenless** — secrets stay only in each folder's 0600 `.musterd/binding.json`, never duplicated here — and **optional/back-compatible** (older configs without it load with an empty map). `saveBinding` writes the entry; nothing reads it but the init guard.

**Identity resolution (ADR 018) — aligned with the MCP adapter.** This global config is the
_last_ source, not the only one. `resolve()` picks the active team+identity in this order:
**explicit `--flags` → `MUSTERD_*` env → workspace `.musterd/binding.json` (explicit `MUSTERD_BINDING`
path, else cwd walk-up) → this global config**. The env + binding paths key identity to the
_workspace_, the same way the MCP adapter resolves it, so an agent that shells out to `musterd`
in its folder acts as _that_ member — not whoever last wrote the global single-slot-per-team
(the 2026-06-16/17 dogfood collision). `musterd init` writes the binding file (0600, gitignored).
A binding may also be **policy-only** (claim-on-first-use, ADR 032): `member`/`token` absent, just a
`claim` policy — `resolve()` skips such a binding as an identity source (`isClaimed`), and `musterd
claim` fills the seat in. Relatedly, `join --as <name>` without `--token` now **refuses** when the cached identity belongs to
a different member, rather than silently relabeling its token (which "succeeded" then failed every
send with `from/team must match`).

**Act vs. read — the global config is a credential store, not an act-authority (ADR 036).** The
global config's identity is the _last_ source and is **ambient**: it may **read** but never **act**.
To _act as_ a member (any write — `send`/`team add`/`team remove`/`reclaim`, `inbox`'s cursor
advance, `notify`'s poll) the identity must be **explicit**: `MUSTERD_*` env, a workspace binding, or
a named `--as <member>`. `resolve()` enforces this (the **act** path) — it refuses an ambient-only
identity with guidance (`musterd claim <name>` or `--as`), so a bare `cd` into an unrelated folder
can't silently act as a real teammate (the 2026-06-23 dogfood: `notify` ran as the global default
`David`). Read/operator commands use `resolveRead()` (the **read** path) — a team is required, an
identity is optional; `status` always prints the auth-free roster and shows its per-member "⚑ waiting
for you" comeback summary only when an identity is explicit. To keep onboarding frictionless,
`team create` / `join` **auto-bind the current folder** to the new identity (init already binds it to
the provisioned agent), so the folder you set up in is immediately active while every other unbound
folder stays read-only. Server-side this needs nothing new: `/health` and the roster are already
unauthenticated; `inbox` + writes already require a member token.

## Commands (args, flags, output, exit)

All commands accept global `--team <slug>`, `--server <url>`, `--json` (machine output, no color), `--no-color`, `--quiet` (suppress the reachability nudge below).

**Agent-side reachability nudge (ADR 046).** After any **acting** command returns, `bin.ts` re-resolves the identity (`resolveRead`) and — only when it is **explicit** (env/binding/`--as`, never an ambient global-config read, ADR 036) — appends a one-line banner to **stderr** naming the directed acts waiting for that member: `⚑ N acts waiting for <me> — musterd inbox (since <t>)`. It is the agent-side mirror of `status`'s comeback summary, surfaced everywhere an agent already is so a heads-down agent can't sit on a `request_help` it never looked for. Built from the same `pendingActionSummary`/`openActionNeeded` predicate, so it self-clears once the inbox cursor advances or the thread is resolved. **Skipped** for commands that show the acts themselves or carry no identity (`inbox`, `status`, `serve`, `service`, `init`, `reset`, `role`, `uninstall`) and suppressed by `--json`/`--quiet`/`MUSTERD_NO_NUDGE=1`. Best-effort: any read failure is swallowed — the nudge never fails or delays a command beyond one inbox read, and never touches stdout (keeps `--json`/pipes clean). No wire change (rides the existing inbox cursor, like `notify`).

### `musterd init`

Interactive first-run onboarding (requires a TTY; non-TTY prints guidance and exits 2). Built on `@clack/prompts` (ADR 005). Read-only `detect()`; only `configure()` writes, and only after a confirm. The flow leads with **intent**, not jargon (2026-06-12 dogfood — the old "what harness is your agent in?" opener buried the point):

1. **Daemon** — check `/health`, offering to spawn `musterd serve` detached if it's down.
2. **Folder check** (ADR 020) — before anything is written, `inspectInitTarget(cwd)` (`onboard/guard.ts`, pure + non-throwing) flags a wrong-looking target and, if any heuristic trips, shows the warnings and a single confirm defaulting to _yes_ (declining makes no changes, exits 0). Because the binding is per-folder, a wrong-folder run is a multi-artifact slip; this catches the common ones. Heuristics: (a) cwd **is the musterd source tree** (`package.json` named `musterd-monorepo`, or the `packages/{cli,server}` layout) — the 2026-06-15 dogfound slip; (b) cwd already has a **`.musterd/binding.json`** (read via the shared `BindingSchema`/`BINDING_*` constants) — init will mint a new member and _repoint_ the binding here; (c) cwd has an **`AGENTS.md` without the musterd primer markers** (`hasPrimerMarkers` from `primer.ts`) — the primer would append to it. **Warn, never block:** init stays runnable in any folder the user genuinely means (including this repo, for dogfooding), and a guard error never crashes init. A fourth check — _name already bound in another folder_ — needs the chosen name and so runs at step 6.
3. **Team** — reuse the current team or create one. The cached team is offered for reuse **only if it's still live on this daemon** (`cachedTeamLive` probes with an authenticated inbox call; ADR 016): after a db reset or a switch to a different server, the saved team/token is stale, so init skips the dead "reuse" option, warns, and routes to creating a team — it stays the single entry point with no pre-`team create` step. A dim hint states the conceptual commitment: _"A team is a standing roster, not a project — reuse the same team across folders to keep agents talking."_ (See `00-overview.md` / `brand.md` §5.)
4. **Intent** — _what are you here to do on `<team>`?_ Three real first-run postures (`human-agent-dynamics.md` §1–2):
   - **Add a new agent** — connect a coding agent as a teammate (the main path).
   - **Activate an existing member** — reconnect a member that isn't currently live. **v0.2 stub:** reattaching a member needs the seat-claim model (creator-authorized token reissue), which is the v0.3 security surface — so this branch surfaces an honest _"coming in v0.3"_ note and offers to add a new agent instead. The framing is the v0.2 down-payment.
   - **Just me — watch the team live** — the supervising posture: the human is already a member (joined at team create), so nothing is minted; it routes to `inbox --watch` / `status`.
5. **Where the agent runs** — detect run targets (`onboard/harnesses/`) and whether musterd is already configured in each. UI copy avoids "harness"/"tool" jargon: _"Where does this agent run?"_, _"detecting agent tools"_. Each option's hint distinguishes set-up state (_"not set up yet — will be configured"_ vs _"musterd already set up here — will be repointed"_). Selecting an **already-configured** target shows a **Heads up** note: re-running mints a _new_ member and repoints the target at it (a repeat name is refused by the conflict guard, so the warning is accurate); the previous member stays on the roster.
6. **Name + mint** — name the agent (no spaces), optional role. Before minting, the **cross-folder name-reuse guard** (ADR 020) runs `nameBoundElsewhere(name, cwd, config.bindings)`: if the name is already bound in _another_ folder it warns (naming that folder + team) with a default-yes confirm — on the same team the mint would be refused anyway (names are unique per team), so this pre-empts the failure. Then `team add` mints it. (The registry it consults is the global config's tokenless `bindings` map, which `saveBinding` writes on every init — see Config file below.)
7. **Activation** — offer `MUSTERD_AUTOJOIN=1` per-binding (_"Auto-join the team when `<name>` starts?"_). If off, the agent joins when it calls `team_join` in-session. The agent is **dormant until it joins** (see `05-mcp.md`).
8. **Configure** — with confirmation, write the target's MCP config (`claude mcp add -s local` / `.cursor/mcp.json`). `ConfigureResult.scope` prints a per-folder caveat: _"wired into this folder only (`<path>`) — another project needs its own `musterd init`, and a second agent needs its own folder."_ If the config lands **inside the working tree** with the token in plaintext (`ConfigureResult.secretPath` — e.g. Cursor's `.cursor/mcp.json`; Claude Code's `-s local` config lives in `~/.claude.json` _outside_ the repo, so no warning), init warns that the file holds the member's token and offers to add it to `.gitignore` so it isn't committed.
9. **Agent primer** — with confirmation (default yes), write a musterd primer into the folder's `AGENTS.md` (`onboard/primer.ts`; ADR 012 / `docs/design/agent-primer.md`). This is the fix for the onboarding gap: a fresh agent that only _has_ the `team_*` tools doesn't know it's on a team or the working-loop, so init seeds the cross-tool agent-context file both Claude Code and Cursor read every session with the member's identity and the loop (join at session start → `team_inbox_check` at task boundaries → `status_update`/`request_help`/`handoff`/`accept`). The block is **marker-delimited** (`<!-- musterd:start -->`…`<!-- musterd:end -->`), so `upsertPrimer` is idempotent and never clobbers the user's own `AGENTS.md` content (create / append-below-prose / update-in-place). The **confirm prompt is honest at the decision point** (`classifyPrimerTarget`, ADR 023): against an existing unmarked `AGENTS.md` it reads _"Append a musterd primer … (your content is kept)"_, against an already-managed one _"Update the musterd primer …"_, and only says _"Write an AGENTS.md primer …"_ when none exists — so a user next to their own `AGENTS.md` is never asked to "write" one in a way that reads like an overwrite (2026-06-18 dogfood). The manual-setup printout (`printManual`) includes the block too.
10. **Wait-to-join** — poll the roster, live spinner that resolves when the agent's Presence appears (or a no-rush note if it doesn't within the window).

### `musterd serve [--port 4849] [--host 127.0.0.1] [--tls-cert <pem> --tls-key <pem> | --insecure-trust-proxy]`

Starts the daemon in the foreground. TLS material (`--tls-cert`/`--tls-key`) serves native `wss://`; `--insecure-trust-proxy` acknowledges a TLS-terminating proxy/overlay in front for a non-loopback plaintext bind (ADR 040). **SIGHUP** reloads the durable roster (re-resolve roots + reconcile, ADR 058). Prints the banner (`render/banner`) + `listening on ws://host:port` **and the served `db:` path** (ADR 016 — the db is chosen by `$MUSTERD_DB`, default `~/.musterd/musterd.db`; showing it makes a wrong-db daemon obvious). Exit 0 on clean shutdown (SIGINT).

### `musterd service <install|uninstall|start|stop|restart|status|logs> [--port <n>] [--host <h>] [--follow] [--force]`

Runs the daemon as a background **service** so it survives a closed terminal/session, restarts on crash, and starts at login — without raw `launchctl` (ADR 045). **macOS only for now** (a per-user **LaunchAgent** at `~/Library/LaunchAgents/studio.sandrise.musterd.plist`); Linux (`systemd --user`) and Windows are the named seam (`serviceSupported`), and an unsupported platform refuses with that guidance. This manages **musterd's own daemon's** lifecycle — a human-side concern like `notify` — **not** member agents; the "musterd connects agents, it does not run them" principle is intact, and the daemon stays a clean core with no knowledge of launchd. The plist embeds the **running** node + CLI entry (`process.execPath` + resolved `argv[1]`) so it's self-correcting, with `RunAtLoad` + `KeepAlive` (+ `ThrottleInterval`); `--port`/`--host` flow into the embedded `serve`. Verbs → launchd: `install` (write + `bootout`-ignored + `bootstrap`, idempotent — supersedes a hand-authored plist), `start` (`bootstrap`), `stop` (`bootout`), `restart` (`kickstart -k`, falling back to `bootstrap` from cold), `uninstall` (`bootout` + remove plist), `status` (parse `launchctl print` + probe `/health`), `logs [--follow]` (tail `~/.musterd/daemon.{log,err.log}`; `--follow`/`-f` hands off to `tail -f`). No new dependency (`launchctl`/`tail` are OS tools, like ADR 035's `osascript`). **Shared-daemon guard (ADR 047):** the destructive verbs `stop`/`restart` first probe `/health` and **refuse (exit 1) when other members hold live sessions** — `connections > 0` — so a shared daemon can't be silently bounced out from under a teammate; the error names the count and nudges you to give the team a heads-up (`musterd send --to @team --act status_update …`) before re-running with **`--force`** (the universal override). It **fails open**: if `/health` is unreachable the daemon's already down and can't be disrupting anyone, so the verb proceeds. The CLI owns the guard (reads the daemon's honest count and decides); the daemon stays a clean core that only reports. `install`/`start` are setup/up intent and aren't guarded. **Dev-build caveat:** run from a workspace checkout it embeds that `dist/bin.js` — a rebuild needs `service restart` (KeepAlive doesn't hot-reload). Errors: a failed `bootstrap`/`restart` → exit 1 with the `launchctl` status; unsupported platform → exit 2.

### `musterd team create <slug> [--display <name>] [--as <yourname>] [--role <role>]`

`POST /teams`. Creates the team and you as its first **human** member. Saves identity+token to config, sets `current`, and **auto-binds the current folder** to you (ADR 036) so you can act there with no `--as`. Output: `cmd/team-create` frame — green `✓ team "dawn" created`, your member line, the dim _bound this folder_ note, dim add hint. Errors: slug taken → `conflict` (exit 9).

### `musterd team add <name> --kind <agent|human> [--role <role>] [--lifecycle forever|session|until --until <iso>]`

`POST /teams/:slug/members`. Prints `✓ added <name> (<kind>, <role>)` and the **join token + ready-to-paste connect hint** (the token is shown once). For agents the hint is the MCP/`join` invocation; copy it into the agent's surface. Output: `cmd/team-add`.

### `musterd team remove <name>`

`POST /teams/:slug/members/:name/remove`. **Soft-removes** a member from the roster (ADR 019) — the sanctioned way to clear a mistaken or stale member instead of editing the daemon's DB. Sets `left_at` via the existing `leaveMember`, so the member drops off every list/auth/route path (all filter `left_at IS NULL`) while its message history + provenance survive; any live session is dropped (same mechanism as reclaim) so the seat frees immediately. Idempotent — removing an already-removed member is a clean `not_found`, never an error stack. Any team member may remove any member (localhost/v0.2; the v0.3 seat model will gate it). No un-remove/reactivate flow — that's the v0.3 seat-claim model. Output: `✓ removed <member> from <team> — off the roster; message history is kept`. Errors: unknown/already-removed member → `not_found` (exit 6).

### `musterd team export <slug>`

The one-time **db→file migration** for a team's durable roster (ADR 058 / migration-bootstrap.md). Run in the folder that should own the roster: reads the live roster, writes canonical `.musterd/team.toml` + one `seats/<name>.toml` per member (identity only — **no token touches a file**), runs the format-layer parity self-check, and records `rosterHome[slug]` in the global config (the per-team cutover signal — the daemon then treats this team as file-backed). Token-preserving by construction: the next reconcile is a match-by-name no-op, so live sessions keep their tokens. Refuses if `team.toml` already exists. Output: `✓ exported "<slug>" roster → .musterd/ (N seats)`.

### `musterd fmt [--check]`

Canonicalize this folder's `.musterd/team.toml` + `seats/*.toml` — the ADR 058 **guard-2 (tidiness)** tool, so roster diffs stay minimal and blame clean. `--check` asserts the committed files are already canonical (exit 1 + the offending files on drift), the CI-style sibling of `format:check`. Purely cosmetic — correctness rides on the semantic round-trip (guard 1), never byte-equality of hand edits.

### `musterd unbind`

Release **this folder's own seat** without removing it from the team (ADR 058). Authenticated by the folder's own token: clears the daemon-side held state (`bound_at`) + presence so the seat reads _declared_ and is freely re-claimable, then deletes this folder's `binding.json`. The committed `seats/<name>.toml` is untouched. The clean separation the file model allows: `unbind` = "I leave this seat", `team remove` = "this seat should no longer exist". Output: `✓ unbound <member> from this folder — the seat stays on <team>, free to re-claim`.

### `musterd reload`

Tell the running **service-managed** daemon to re-resolve its roster roots and reconcile, by sending it **SIGHUP** (ADR 058) — use after `team export` so a newly file-backed team is picked up without a full restart. Resolves the launchd service pid and signals it; macOS/service-only (for a foreground `musterd serve`, signal it directly: `kill -HUP <pid>`). Output: `✓ reloaded the musterd daemon (SIGHUP pid <n>) …`.

### `musterd reset [--force] [--no-backup]`

Local clean-slate (ADR 022) — wipes the daemon's SQLite db (every team, member, presence, message) by deleting the db file + its `-wal`/`-shm` siblings, and clears the local CLI `identities`/`bindings`/`current` in `config.json` (the `server` URL is kept). A fresh `musterd serve` re-creates an empty db at the current schema. Pure filesystem + config: it never imports `@musterd/server` (ADR 002) or opens the db, and talks to a running daemon only through the read-only `/health` probe. **Safety, three layers:** (1) **refuses while a daemon is live on the target db** — `/health` reports the served db path (ADR 016); deleting an open SQLite file orphans the daemon onto a ghost inode, so it tells you to stop the daemon first (exit 11). A daemon on a _different_ db doesn't block. (2) **Backs up first** by default — db files + `config.json` → `~/.musterd/backups/*.<ts>.bak`; `--no-backup` opts out. (3) **Confirms** — interactive `y/N` on a TTY, and on a non-TTY refuses unless `--force`/`--yes`. Per-folder `.musterd/binding.json` files are not touched (run `musterd init` to repoint them). Output: `✓ reset — wiped <db>; cleared N local identities`.

### `musterd join <slug> --as <name> [--token <tok>] [--surface cli]`

Attaches a Presence for an existing member, stores identity locally, and **auto-binds the current folder** to it (ADR 036) so you can act here without `--as`. If `--token` omitted, uses config (and refuses to relabel a different member's token — see Identity resolution above). Opens a short WS `hello` to confirm + register presence, then exits 0 (presence is held by `inbox --watch` or one-shot pings; plain `join` just registers and confirms). Output: `cmd/join` (`✓ <name> joined <slug>` + presence line).

### `musterd send --to <name|@team|@broadcast> --act <act> [--thread <id>] [--reply-to <id>] [--meta k=v ...] [--urgent --urgent-reason <why>] <body...>`

Builds an Envelope, `POST /teams/:slug/messages` (or over the live WS if `--watch` session is active). Validates act+meta client-side via `@musterd/protocol` before sending (fail fast). `--to @team` → `{kind:team}`, `--to @broadcast` → broadcast, else `{kind:member,name}`. `accept`/`decline` require `--reply-to`. `--urgent` sets `meta.urgent:true` (the breakthrough flag that pierces an away/dnd recipient's hold, SPEC A.6a) and **requires** `--urgent-reason` — the protocol rejects `urgent` without a non-empty `urgent_reason` (ADR 044). **Ungated on localhost**: the `can_flag_urgent` capability that scopes _who_ may flag is the v0.3 seam, not built here. Echoes the sent `message-row` + `✓ sent`. Output: `cmd/send`.

### `musterd inbox [--watch] [--all] [--unread] [--peek] [--limit 50]`

- Without `--watch`: `GET /inbox`, prints header `inbox — <team> (<n> unread)` + message rows (oldest→newest), unread marked `▌`. The read cursor advances by default; `--peek` reads without advancing it. Empty → `state/empty-inbox` verbatim string. Output: `cmd/inbox`.
- With `--all` (the **firehose**, ADR 061): the _whole-team_ timeline — every envelope, not just your inbox. One-shot `--all` does `GET /teams/:slug/messages` and prints `firehose — <team> (<n> messages)`; `--watch --all` subscribes `team-all`, backfills recent history (deduped by id against the live stream), then streams every act live. Any team member may watch; no observer seat needed (that's for the browser dashboard, ADR 063).
- With `--watch`: opens WS, holds presence (heartbeats every 15s), streams `deliver` frames as rows live; `◉ watching` indicator. An **action-needed** delivery (`request_help`, or an act addressed to you) is preceded by a sticky inverse-yellow `⚑ ACTION NEEDED` banner and, on a real TTY, **rings the terminal bell** (suppress with `--no-bell`) — the recipient-side salience of ADR 024, so a real ask can't be lost in a stream of `status_update`s. This is the human's "be present on the team" mode and the left/right pane of the flagship demo. Ctrl-C exits 0. Output: `cmd/inbox-watch`.

### `musterd status`

`GET /teams/:slug/members`. A **free read** (ADR 036): the roster is unauthenticated, so `status` works from any folder — even an unbound one with no active identity (it resolves via `resolveRead`, which needs a team but not an actor). When an identity _is_ explicit it **leads with the comeback summary** — `⚑ N requests waiting for you since <t>` (ADR 024), the unread, unresolved action-needed acts read off the durable inbox cursor (`pendingActionSummary`) — and stays silent when nothing waits or no one is active here. Prints a **header line** first — `team · server · db: <path> (schema N)` from `/health` (ADR 016; the db segment is omitted against a pre-0.2 daemon that doesn't report it) — so you can see _which daemon and database_ you're reading before the roster. Then renders the roster table: `MEMBER | KIND | ROLE | LIFECYCLE | ACTIVITY` (v0.2 M2 — the old `PRESENCE` column was renamed **ACTIVITY** and moved **last** because its `working: <status> · <age>` label is unbounded and free-flowing, so a long label can't collide with later columns; `ce89bf1`). ACTIVITY resolves via the two-clocks rule (`store/activity.ts`): liveness → `offline`/present, latest `status_update` → `online`/`working`, with the `· <age>` staleness suffix shown only once stale ≥5m. Attach-time context follows dim, in `(why) · driven by <who> · <where>` order: `provenance` (ADR 014), `driver` (the steering human — driver co-presence, ADR 021), and `workspace` (ADR 014) — e.g. `online via claude-code (session) · driven by nick · movetrail@feat/login`. 80-col aligned, presence dot + surface per `brand.md`. Output: `cmd/status` _(the Figma `cmd/status` frame still shows the old `PRESENCE` column + order — frame drift tracked under ADR 008 lockstep; `disabled`/`archived` badges skipped, they need schema + verbs)._

### `musterd availability <available|away|dnd> [--until <iso>]`

`POST /teams/:slug/availability` (authed). Sets **your own** availability axis (SPEC A.6 Axis 2) — explicit and self-only, **never inferred**. `away --until <iso>` is the `away_until` encoding (stored as `{status:'away', until:<ms>}`); `--until` is rejected on any other status, and the server drops a stray `until` from `available`/`dnd` so the stored shape stays honest. The roster renders `away` as `off until <ts>` (or bare `away`) and `dnd` as `dnd`, **overriding** the live activity label (A.6 display resolution); `available` is the implicit default and never overrides. The notify loop reads this back to **tier** deliveries: `away` holds all but `urgent`; `dnd` passes directed pings + `urgent` (ADR 044). The localhost down-payment — the v0.3 governed superset (off*hours, schedule enforcement, `can*\*`gating) is the named seam. Output:`✓ availability set to <status>`. Needs an **active identity** like any act (ADR 036).

### `musterd claim <name> | --role <role> [--for <code>] [--surface <s>]`

The **L2 universal floor** of claim-on-first-use (ADR 032) — needs only the daemon, works in any harness. Resolves team+server from the binding/env/global config (no identity needed — it's _claiming_ one), then **mint-or-reuse** a seat and write it into this folder's `.musterd/binding.json` (member+token+`claim: seat:<name>`), so the CLI **and** a (re)launched adapter resolve to it. `<name>` claims a named seat (auto-minted via the unauthenticated `POST /members`); `--role <role>` claims the next open `<role>-<n>` pool handle; no target falls back to the folder policy. **Reuse vs mint:** if this folder already holds `<name>`'s token, it re-occupies without re-minting (`reclaimed your seat`); a name already on the team this folder has _no_ token for → exit 9 with the roster + a fresh-name/`--role` hint (the local `claim_conflict`). **Pending markers (ADR 033):** if unclaimed adapter sessions left `.musterd/pending/*.json` markers, claim lists them and requires `--for <code>` when several wait (the code shows in the session's first output), clearing the chosen one. **Live delivery (ADR 034):** when a marker is matched, claim drops a 0600 `<code>.resolved.json` sidecar the running session's resolution watcher adopts — so the waiting session goes online **without a relaunch** (`--json` reports `live: true`). Output: `✓ <name> — claimed a fresh seat on <team>`.

### `musterd reclaim <member>`

`POST /teams/:slug/members/:name/reclaim`. Force-drops a member's live session so it can rejoin — the sanctioned escape hatch (ADR 017 follow-up) instead of editing the daemon's DB. Newest-wins self-heals a _reconnecting_ session, but an orphaned presence that never comes back needs this. Any team member may reclaim any member (localhost/v0.2; the v0.3 seat model will gate it). Output: `✓ reclaimed <member> — any live session was dropped; it can rejoin now`. Errors: unknown member → `not_found` (exit 6).

### `musterd notify [--interval <seconds>] [--once]`

The **localhost notification down-payment** (ADR 035) — an opt-in, headless, client-side notifier the human leaves running so a directed act that lands while they're **not** watching still reaches them (the not-watching case `inbox --watch`'s bell can't cover). Polls the durable inbox cursor (`GET /inbox?unread=1`) with the same `openActionNeeded` predicate as the comeback summary; on a not-yet-seen action-needed act (`request_help`/`handoff`/`accept`/`decline`/@mention) it fires an **OS notification** by shelling out to `osascript` (macOS) / `notify-send` (Linux) — no runtime dep, dynamic strings passed as injection-safe AppleScript `argv`. **Suppressed when the human is actively watching** (roster `presence !== 'offline'` — the watch bell already reached them), so it owns only the not-watching case. De-dupe is two-layered: the durable cursor (reading the inbox clears it) + an in-memory seen set (no re-nag within a run). **Tiering by the recipient's own availability** (ADR 044): when you are `away` the Loud set is held and only an `urgent` ping fires; `dnd` passes directed pings + `urgent`; `available` (the default) fires the Loud set as before — `urgent` pierces every tier. Availability is read off the same roster as reachability (no new wire field). `--once` polls once and exits (cron-friendly + testable); default is the resident loop (`--interval` seconds, default 10). Needs an **active identity** like any act (ADR 036). Client-side tiering only — **no wire change / no SPEC bump**; the v0.3 governed superset (`SPEC.md` A.6a — `can_flag_urgent`, audit, `wasnt_urgent`) is the named seam. Other platforms no-op (the comeback summary still serves them).

### `musterd role <list|show|create> [<name>] [--from <builtin>] [--force]`

Manage role **provisioning templates** (ADR 026/029/038; `docs/design/provisioning-recipe.md` §3) — a pure local-file + built-in-library command that **never touches the daemon or the server roster** (Universe-2 only; identity unchanged). `role list` shows the shipped built-ins plus any user templates in `.musterd/roles/*.json`; `role show <name>` prints a fully-resolved template (built-in or user, with `inspect with: musterd role show <name>`); `role create <name> [--from <builtin>]` scaffolds an editable user template under `.musterd/roles/` (refuses to overwrite without `--force`). A Role projects into two places at use-time — the identity half (role label) and the harness-provisioning half (MCP servers + permissions `init` writes) — so editing a template changes what the next `init` provisions.

### `musterd uninstall [--force|--yes]`

Per-folder **uninstall** (ADR 027 — the reversibility gap `reset` left open): removes _exactly_ what `musterd init` wrote into this folder's harness and restores the prior state — the role-provisioned MCP servers + permission entries (from the manifest, ADR 030), the musterd MCP server itself, the managed AGENTS.md primer block (the user's own prose is kept), and the local `.musterd/` state (binding + manifest) and registry entry. Purely local: it **never touches the server roster** — the member stays on the team (offline); removing it server-side is the v0.3 seat model. Never imports `@musterd/server`. Confirms on a TTY; `--force`/`--yes` skips the prompt.

## Exit codes (must match the State frames' annotations)

| exit | condition                                       | error code     |
| ---- | ----------------------------------------------- | -------------- |
| 0    | success                                         | —              |
| 1    | generic/unexpected error                        | `server_error` |
| 2    | bad usage / missing required flag               | `bad_request`  |
| 3    | validation (bad act/meta/envelope)              | `validation`   |
| 4    | unauthorized (bad/missing token)                | `unauthorized` |
| 5    | forbidden                                       | `forbidden`    |
| 6    | not found (team/member)                         | `not_found`    |
| 7    | server unreachable (daemon down)                | (connection)   |
| 9    | conflict (name/slug taken)                      | `conflict`     |
| 10   | member already active elsewhere (single-active) | `member_busy`  |

`state/server-down`, `state/no-team`, `state/unknown-member` frames map to exits 7, 2, 6 respectively. Every error prints `✗ <message>` in red to stderr and exits with the code above.

## Acceptance tests (`06-testing.md`)

- `team create` → config gets identity+token, `current` set; rerun same slug → exit 9.
- `team add Ada --kind agent` → prints a token; that token authenticates as Ada (verified against a live test server).
- `team remove Ada` → Ada drops off `status`; a second `remove Ada` (and an unknown member) → `not_found` (exit 6); the member row + its message history survive in the db.
- Two CLI identities (`nick`, `lin` as a human for the test) on `dawn`: `nick send --to lin` then `lin inbox` shows the message with unread=1; second `lin inbox` shows unread=0.
- `inbox --watch` receives a message sent after it started watching, live.
- Output of `status`, `inbox`, `send` matches the Figma terminal frames (snapshot tests against the frozen sample data).
- `--json` emits valid parseable JSON with no ANSI; `NO_COLOR`/pipe strips color.
