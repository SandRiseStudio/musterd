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
  config.ts           // load/save ~/.musterd/config.json
  client.ts           // HttpClient + WsClient wrappers over the 02-protocol API
  render/
    theme.ts          // ANSI roles from brand.md (online dot, member colors, act badges)
    rows.ts           // renderMessageRow, renderStatusTable, renderBanner, renderPresence
  onboard/            // the `musterd init` interactive onboarding (@clack/prompts; ADR 005)
    init.ts           // the flow: daemon -> folder-check -> team -> intent -> where-it-runs -> configure -> primer -> wait-to-join
    guard.ts          // inspectInitTarget(cwd): pure folder-suitability heuristics → warnings (ADR 020)
    harness.ts        // adapter interface (detect + configure); ConfigureResult carries activation/target/scope/secretPath
    mcpEntry.ts       // resolve how to launch @musterd/mcp + build the binding env
    primer.ts         // renderPrimer + idempotent upsertPrimer → AGENTS.md agent primer (ADR 012)
    harnesses/
      index.ts        // registry of supported run targets (pluggable)
      claudeCode.ts   // detect/configure via the `claude mcp` CLI (`-s local`, this folder only)
      cursor.ts       // detect/configure via .cursor/mcp.json (ADR 006 adds the `cursor` surface)
  commands/
    init.ts           // musterd init (delegates to onboard/init.ts)
    serve.ts          // musterd serve [--port]
    team.ts           // team create / team add / team remove
    join.ts           // join
    send.ts           // send
    inbox.ts          // inbox [--watch]
    status.ts         // status
  errors.ts           // CliError(code) -> message + exit code
```

## Config file `~/.musterd/config.json`

```jsonc
{
  "server": "http://localhost:4849",     // base URL; ws derived by swapping scheme
  "current": "dawn",                      // current team slug (default for commands)
  "identities": {                          // per (team) -> the member you act as + token
    "dawn": { "name": "nick", "token": "mskd_...", "surface": "cli" }
  },
  "bindings": {                            // ADR 020: tokenless registry, keyed by abs folder path
    "/Users/nick/proj/web": { "team": "dawn", "member": "Ada", "surface": "claude-code" }
  }
}
```

- `MUSTERD_SERVER` env overrides `server`. `--team <slug>` overrides `current`. `--as <name>` selects identity within a team.
- Tokens live here (chmod 600 on write). Never logged.
- `bindings` (ADR 020) records *where* each member is bound, so init can warn on cross-folder name reuse (`nameBoundElsewhere`). It is **tokenless** — secrets stay only in each folder's 0600 `.musterd/binding.json`, never duplicated here — and **optional/back-compatible** (older configs without it load with an empty map). `saveBinding` writes the entry; nothing reads it but the init guard.

**Identity resolution (ADR 018) — aligned with the MCP adapter.** This global config is the
*last* source, not the only one. `resolve()` picks the active team+identity in this order:
**explicit `--flags` → `MUSTERD_*` env → workspace `.musterd/binding.json` (explicit `MUSTERD_BINDING`
path, else cwd walk-up) → this global config**. The env + binding paths key identity to the
*workspace*, the same way the MCP adapter resolves it, so an agent that shells out to `musterd`
in its folder acts as *that* member — not whoever last wrote the global single-slot-per-team
(the 2026-06-16/17 dogfood collision). `musterd init` writes the binding file (0600, gitignored).
A binding may also be **policy-only** (claim-on-first-use, ADR 032): `member`/`token` absent, just a
`claim` policy — `resolve()` skips such a binding as an identity source (`isClaimed`), and `musterd
claim` fills the seat in. Relatedly, `join --as <name>` without `--token` now **refuses** when the cached identity belongs to
a different member, rather than silently relabeling its token (which "succeeded" then failed every
send with `from/team must match`).

## Commands (args, flags, output, exit)

All commands accept global `--team <slug>`, `--server <url>`, `--json` (machine output, no color), `--no-color`.

### `musterd init`
Interactive first-run onboarding (requires a TTY; non-TTY prints guidance and exits 2). Built on `@clack/prompts` (ADR 005). Read-only `detect()`; only `configure()` writes, and only after a confirm. The flow leads with **intent**, not jargon (2026-06-12 dogfood — the old "what harness is your agent in?" opener buried the point):

1. **Daemon** — check `/health`, offering to spawn `musterd serve` detached if it's down.
2. **Folder check** (ADR 020) — before anything is written, `inspectInitTarget(cwd)` (`onboard/guard.ts`, pure + non-throwing) flags a wrong-looking target and, if any heuristic trips, shows the warnings and a single confirm defaulting to *yes* (declining makes no changes, exits 0). Because the binding is per-folder, a wrong-folder run is a multi-artifact slip; this catches the common ones. Heuristics: (a) cwd **is the musterd source tree** (`package.json` named `musterd-monorepo`, or the `packages/{cli,server}` layout) — the 2026-06-15 dogfound slip; (b) cwd already has a **`.musterd/binding.json`** (read via the shared `BindingSchema`/`BINDING_*` constants) — init will mint a new member and *repoint* the binding here; (c) cwd has an **`AGENTS.md` without the musterd primer markers** (`hasPrimerMarkers` from `primer.ts`) — the primer would append to it. **Warn, never block:** init stays runnable in any folder the user genuinely means (including this repo, for dogfooding), and a guard error never crashes init. A fourth check — *name already bound in another folder* — needs the chosen name and so runs at step 6.
3. **Team** — reuse the current team or create one. The cached team is offered for reuse **only if it's still live on this daemon** (`cachedTeamLive` probes with an authenticated inbox call; ADR 016): after a db reset or a switch to a different server, the saved team/token is stale, so init skips the dead "reuse" option, warns, and routes to creating a team — it stays the single entry point with no pre-`team create` step. A dim hint states the conceptual commitment: *"A team is a standing roster, not a project — reuse the same team across folders to keep agents talking."* (See `00-overview.md` / `brand.md` §5.)
4. **Intent** — *what are you here to do on `<team>`?* Three real first-run postures (`human-agent-dynamics.md` §1–2):
   - **Add a new agent** — connect a coding agent as a teammate (the main path).
   - **Activate an existing member** — reconnect a member that isn't currently live. **v0.2 stub:** reattaching a member needs the seat-claim model (creator-authorized token reissue), which is the v0.3 security surface — so this branch surfaces an honest *"coming in v0.3"* note and offers to add a new agent instead. The framing is the v0.2 down-payment.
   - **Just me — watch the team live** — the supervising posture: the human is already a member (joined at team create), so nothing is minted; it routes to `inbox --watch` / `status`.
5. **Where the agent runs** — detect run targets (`onboard/harnesses/`) and whether musterd is already configured in each. UI copy avoids "harness"/"tool" jargon: *"Where does this agent run?"*, *"detecting agent tools"*. Each option's hint distinguishes set-up state (*"not set up yet — will be configured"* vs *"musterd already set up here — will be repointed"*). Selecting an **already-configured** target shows a **Heads up** note: re-running mints a *new* member and repoints the target at it (a repeat name is refused by the conflict guard, so the warning is accurate); the previous member stays on the roster.
6. **Name + mint** — name the agent (no spaces), optional role. Before minting, the **cross-folder name-reuse guard** (ADR 020) runs `nameBoundElsewhere(name, cwd, config.bindings)`: if the name is already bound in *another* folder it warns (naming that folder + team) with a default-yes confirm — on the same team the mint would be refused anyway (names are unique per team), so this pre-empts the failure. Then `team add` mints it. (The registry it consults is the global config's tokenless `bindings` map, which `saveBinding` writes on every init — see Config file below.)
7. **Activation** — offer `MUSTERD_AUTOJOIN=1` per-binding (*"Auto-join the team when `<name>` starts?"*). If off, the agent joins when it calls `team_join` in-session. The agent is **dormant until it joins** (see `05-mcp.md`).
8. **Configure** — with confirmation, write the target's MCP config (`claude mcp add -s local` / `.cursor/mcp.json`). `ConfigureResult.scope` prints a per-folder caveat: *"wired into this folder only (`<path>`) — another project needs its own `musterd init`, and a second agent needs its own folder."* If the config lands **inside the working tree** with the token in plaintext (`ConfigureResult.secretPath` — e.g. Cursor's `.cursor/mcp.json`; Claude Code's `-s local` config lives in `~/.claude.json` *outside* the repo, so no warning), init warns that the file holds the member's token and offers to add it to `.gitignore` so it isn't committed.
9. **Agent primer** — with confirmation (default yes), write a musterd primer into the folder's `AGENTS.md` (`onboard/primer.ts`; ADR 012 / `docs/design/agent-primer.md`). This is the fix for the onboarding gap: a fresh agent that only *has* the `team_*` tools doesn't know it's on a team or the working-loop, so init seeds the cross-tool agent-context file both Claude Code and Cursor read every session with the member's identity and the loop (join at session start → `team_inbox_check` at task boundaries → `status_update`/`request_help`/`handoff`/`accept`). The block is **marker-delimited** (`<!-- musterd:start -->`…`<!-- musterd:end -->`), so `upsertPrimer` is idempotent and never clobbers the user's own `AGENTS.md` content (create / append-below-prose / update-in-place). The **confirm prompt is honest at the decision point** (`classifyPrimerTarget`, ADR 023): against an existing unmarked `AGENTS.md` it reads *"Append a musterd primer … (your content is kept)"*, against an already-managed one *"Update the musterd primer …"*, and only says *"Write an AGENTS.md primer …"* when none exists — so a user next to their own `AGENTS.md` is never asked to "write" one in a way that reads like an overwrite (2026-06-18 dogfood). The manual-setup printout (`printManual`) includes the block too.
10. **Wait-to-join** — poll the roster, live spinner that resolves when the agent's Presence appears (or a no-rush note if it doesn't within the window).

### `musterd serve [--port 4849] [--host 127.0.0.1]`
Starts the daemon in the foreground. Prints the banner (`render/banner`) + `listening on ws://host:port` **and the served `db:` path** (ADR 016 — the db is chosen by `$MUSTERD_DB`, default `~/.musterd/musterd.db`; showing it makes a wrong-db daemon obvious). Exit 0 on clean shutdown (SIGINT).

### `musterd team create <slug> [--display <name>] [--as <yourname>] [--role <role>]`
`POST /teams`. Creates the team and you as its first **human** member. Saves identity+token to config, sets `current`. Output: `cmd/team-create` frame — green `✓ team "dawn" created`, your member line, dim add hint. Errors: slug taken → `conflict` (exit 9).

### `musterd team add <name> --kind <agent|human> [--role <role>] [--lifecycle forever|session|until --until <iso>]`
`POST /teams/:slug/members`. Prints `✓ added <name> (<kind>, <role>)` and the **join token + ready-to-paste connect hint** (the token is shown once). For agents the hint is the MCP/`join` invocation; copy it into the agent's surface. Output: `cmd/team-add`.

### `musterd team remove <name>`
`POST /teams/:slug/members/:name/remove`. **Soft-removes** a member from the roster (ADR 019) — the sanctioned way to clear a mistaken or stale member instead of editing the daemon's DB. Sets `left_at` via the existing `leaveMember`, so the member drops off every list/auth/route path (all filter `left_at IS NULL`) while its message history + provenance survive; any live session is dropped (same mechanism as reclaim) so the seat frees immediately. Idempotent — removing an already-removed member is a clean `not_found`, never an error stack. Any team member may remove any member (localhost/v0.2; the v0.3 seat model will gate it). No un-remove/reactivate flow — that's the v0.3 seat-claim model. Output: `✓ removed <member> from <team> — off the roster; message history is kept`. Errors: unknown/already-removed member → `not_found` (exit 6).

### `musterd reset [--force] [--no-backup]`
Local clean-slate (ADR 022) — wipes the daemon's SQLite db (every team, member, presence, message) by deleting the db file + its `-wal`/`-shm` siblings, and clears the local CLI `identities`/`bindings`/`current` in `config.json` (the `server` URL is kept). A fresh `musterd serve` re-creates an empty db at the current schema. Pure filesystem + config: it never imports `@musterd/server` (ADR 002) or opens the db, and talks to a running daemon only through the read-only `/health` probe. **Safety, three layers:** (1) **refuses while a daemon is live on the target db** — `/health` reports the served db path (ADR 016); deleting an open SQLite file orphans the daemon onto a ghost inode, so it tells you to stop the daemon first (exit 11). A daemon on a *different* db doesn't block. (2) **Backs up first** by default — db files + `config.json` → `~/.musterd/backups/*.<ts>.bak`; `--no-backup` opts out. (3) **Confirms** — interactive `y/N` on a TTY, and on a non-TTY refuses unless `--force`/`--yes`. Per-folder `.musterd/binding.json` files are not touched (run `musterd init` to repoint them). Output: `✓ reset — wiped <db>; cleared N local identities`.

### `musterd join <slug> --as <name> [--token <tok>] [--surface cli]`
Attaches a Presence for an existing member and stores identity locally. If `--token` omitted, uses config. Opens a short WS `hello` to confirm + register presence, then exits 0 (presence is held by `inbox --watch` or one-shot pings; plain `join` just registers and confirms). Output: `cmd/join` (`✓ <name> joined <slug>` + presence line).

### `musterd send --to <name|@team|@broadcast> --act <act> [--thread <id>] [--reply-to <id>] [--meta k=v ...] <body...>`
Builds an Envelope, `POST /teams/:slug/messages` (or over the live WS if `--watch` session is active). Validates act+meta client-side via `@musterd/protocol` before sending (fail fast). `--to @team` → `{kind:team}`, `--to @broadcast` → broadcast, else `{kind:member,name}`. `accept`/`decline` require `--reply-to`. Echoes the sent `message-row` + `✓ sent`. Output: `cmd/send`.

### `musterd inbox [--watch] [--unread] [--limit 50]`
- Without `--watch`: `GET /inbox`, prints header `inbox — <team> (<n> unread)` + message rows (oldest→newest), unread marked `▌`. Advances the read cursor unless `--unread`-peek (decide: default advances cursor; `--peek` to not). Empty → `state/empty-inbox` verbatim string. Output: `cmd/inbox`.
- With `--watch`: opens WS, holds presence (heartbeats every 15s), streams `deliver` frames as rows live; `◉ watching` indicator. This is the human's "be present on the team" mode and the left/right pane of the flagship demo. Ctrl-C exits 0. Output: `cmd/inbox-watch`.

### `musterd status`
`GET /teams/:slug/members`. Prints a **header line** first — `team · server · db: <path> (schema N)` from `/health` (ADR 016; the db segment is omitted against a pre-0.2 daemon that doesn't report it) — so you can see *which daemon and database* you're reading before the roster. Then renders the roster table: `MEMBER | KIND | ROLE | LIFECYCLE | ACTIVITY` (v0.2 M2 — the old `PRESENCE` column was renamed **ACTIVITY** and moved **last** because its `working: <status> · <age>` label is unbounded and free-flowing, so a long label can't collide with later columns; `ce89bf1`). ACTIVITY resolves via the two-clocks rule (`store/activity.ts`): liveness → `offline`/present, latest `status_update` → `online`/`working`, with the `· <age>` staleness suffix shown only once stale ≥5m. Attach-time context follows dim, in `(why) · driven by <who> · <where>` order: `provenance` (ADR 014), `driver` (the steering human — driver co-presence, ADR 021), and `workspace` (ADR 014) — e.g. `online via claude-code (session) · driven by nick · movetrail@feat/login`. 80-col aligned, presence dot + surface per `brand.md`. Output: `cmd/status` *(the Figma `cmd/status` frame still shows the old `PRESENCE` column + order — frame drift tracked under ADR 008 lockstep; `disabled`/`archived` badges skipped, they need schema + verbs).*

### `musterd claim <name> | --role <role> [--for <code>] [--surface <s>]`
The **L2 universal floor** of claim-on-first-use (ADR 032) — needs only the daemon, works in any harness. Resolves team+server from the binding/env/global config (no identity needed — it's *claiming* one), then **mint-or-reuse** a seat and write it into this folder's `.musterd/binding.json` (member+token+`claim: seat:<name>`), so the CLI **and** a (re)launched adapter resolve to it. `<name>` claims a named seat (auto-minted via the unauthenticated `POST /members`); `--role <role>` claims the next open `<role>-<n>` pool handle; no target falls back to the folder policy. **Reuse vs mint:** if this folder already holds `<name>`'s token, it re-occupies without re-minting (`reclaimed your seat`); a name already on the team this folder has *no* token for → exit 9 with the roster + a fresh-name/`--role` hint (the local `claim_conflict`). **Pending markers (ADR 033):** if unclaimed adapter sessions left `.musterd/pending/*.json` markers, claim lists them and requires `--for <code>` when several wait (the code shows in the session's first output), clearing the chosen one. **Live delivery (ADR 034):** when a marker is matched, claim drops a 0600 `<code>.resolved.json` sidecar the running session's resolution watcher adopts — so the waiting session goes online **without a relaunch** (`--json` reports `live: true`). Output: `✓ <name> — claimed a fresh seat on <team>`.

### `musterd reclaim <member>`
`POST /teams/:slug/members/:name/reclaim`. Force-drops a member's live session so it can rejoin — the sanctioned escape hatch (ADR 017 follow-up) instead of editing the daemon's DB. Newest-wins self-heals a *reconnecting* session, but an orphaned presence that never comes back needs this. Any team member may reclaim any member (localhost/v0.2; the v0.3 seat model will gate it). Output: `✓ reclaimed <member> — any live session was dropped; it can rejoin now`. Errors: unknown member → `not_found` (exit 6).

## Exit codes (must match the State frames' annotations)

| exit | condition | error code |
|------|-----------|-----------|
| 0 | success | — |
| 1 | generic/unexpected error | `server_error` |
| 2 | bad usage / missing required flag | `bad_request` |
| 3 | validation (bad act/meta/envelope) | `validation` |
| 4 | unauthorized (bad/missing token) | `unauthorized` |
| 5 | forbidden | `forbidden` |
| 6 | not found (team/member) | `not_found` |
| 7 | server unreachable (daemon down) | (connection) |
| 9 | conflict (name/slug taken) | `conflict` |
| 10 | member already active elsewhere (single-active) | `member_busy` |

`state/server-down`, `state/no-team`, `state/unknown-member` frames map to exits 7, 2, 6 respectively. Every error prints `✗ <message>` in red to stderr and exits with the code above.

## Acceptance tests (`06-testing.md`)

- `team create` → config gets identity+token, `current` set; rerun same slug → exit 9.
- `team add Ada --kind agent` → prints a token; that token authenticates as Ada (verified against a live test server).
- `team remove Ada` → Ada drops off `status`; a second `remove Ada` (and an unknown member) → `not_found` (exit 6); the member row + its message history survive in the db.
- Two CLI identities (`nick`, `lin` as a human for the test) on `dawn`: `nick send --to lin` then `lin inbox` shows the message with unread=1; second `lin inbox` shows unread=0.
- `inbox --watch` receives a message sent after it started watching, live.
- Output of `status`, `inbox`, `send` matches the Figma terminal frames (snapshot tests against the frozen sample data).
- `--json` emits valid parseable JSON with no ANSI; `NO_COLOR`/pipe strips color.
