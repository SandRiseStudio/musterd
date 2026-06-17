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
    init.ts           // the flow: daemon -> team -> intent -> where-it-runs -> configure -> primer -> wait-to-join
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
  }
}
```

- `MUSTERD_SERVER` env overrides `server`. `--team <slug>` overrides `current`. `--as <name>` selects identity within a team.
- Tokens live here (chmod 600 on write). Never logged.

**Identity resolution (ADR 018) — aligned with the MCP adapter.** This global config is the
*last* source, not the only one. `resolve()` picks the active team+identity in this order:
**explicit `--flags` → `MUSTERD_*` env → workspace `.musterd/binding.json` (explicit `MUSTERD_BINDING`
path, else cwd walk-up) → this global config**. The env + binding paths key identity to the
*workspace*, the same way the MCP adapter resolves it, so an agent that shells out to `musterd`
in its folder acts as *that* member — not whoever last wrote the global single-slot-per-team
(the 2026-06-16/17 dogfood collision). `musterd init` writes the binding file (0600, gitignored).
Relatedly, `join --as <name>` without `--token` now **refuses** when the cached identity belongs to
a different member, rather than silently relabeling its token (which "succeeded" then failed every
send with `from/team must match`).

## Commands (args, flags, output, exit)

All commands accept global `--team <slug>`, `--server <url>`, `--json` (machine output, no color), `--no-color`.

### `musterd init`
Interactive first-run onboarding (requires a TTY; non-TTY prints guidance and exits 2). Built on `@clack/prompts` (ADR 005). Read-only `detect()`; only `configure()` writes, and only after a confirm. The flow leads with **intent**, not jargon (2026-06-12 dogfood — the old "what harness is your agent in?" opener buried the point):

1. **Daemon** — check `/health`, offering to spawn `musterd serve` detached if it's down.
2. **Team** — reuse the current team or create one. The cached team is offered for reuse **only if it's still live on this daemon** (`cachedTeamLive` probes with an authenticated inbox call; ADR 016): after a db reset or a switch to a different server, the saved team/token is stale, so init skips the dead "reuse" option, warns, and routes to creating a team — it stays the single entry point with no pre-`team create` step. A dim hint states the conceptual commitment: *"A team is a standing roster, not a project — reuse the same team across folders to keep agents talking."* (See `00-overview.md` / `brand.md` §5.)
3. **Intent** — *what are you here to do on `<team>`?* Three real first-run postures (`human-agent-dynamics.md` §1–2):
   - **Add a new agent** — connect a coding agent as a teammate (the main path).
   - **Activate an existing member** — reconnect a member that isn't currently live. **v0.2 stub:** reattaching a member needs the seat-claim model (creator-authorized token reissue), which is the v0.3 security surface — so this branch surfaces an honest *"coming in v0.3"* note and offers to add a new agent instead. The framing is the v0.2 down-payment.
   - **Just me — watch the team live** — the supervising posture: the human is already a member (joined at team create), so nothing is minted; it routes to `inbox --watch` / `status`.
4. **Where the agent runs** — detect run targets (`onboard/harnesses/`) and whether musterd is already configured in each. UI copy avoids "harness"/"tool" jargon: *"Where does this agent run?"*, *"detecting agent tools"*. Each option's hint distinguishes set-up state (*"not set up yet — will be configured"* vs *"musterd already set up here — will be repointed"*). Selecting an **already-configured** target shows a **Heads up** note: re-running mints a *new* member and repoints the target at it (a repeat name is refused by the conflict guard, so the warning is accurate); the previous member stays on the roster.
5. **Name + mint** — name the agent (no spaces), optional role, `team add` mints it.
6. **Activation** — offer `MUSTERD_AUTOJOIN=1` per-binding (*"Auto-join the team when `<name>` starts?"*). If off, the agent joins when it calls `team_join` in-session. The agent is **dormant until it joins** (see `05-mcp.md`).
7. **Configure** — with confirmation, write the target's MCP config (`claude mcp add -s local` / `.cursor/mcp.json`). `ConfigureResult.scope` prints a per-folder caveat: *"wired into this folder only (`<path>`) — another project needs its own `musterd init`, and a second agent needs its own folder."* If the config lands **inside the working tree** with the token in plaintext (`ConfigureResult.secretPath` — e.g. Cursor's `.cursor/mcp.json`; Claude Code's `-s local` config lives in `~/.claude.json` *outside* the repo, so no warning), init warns that the file holds the member's token and offers to add it to `.gitignore` so it isn't committed.
8. **Agent primer** — with confirmation (default yes), write a musterd primer into the folder's `AGENTS.md` (`onboard/primer.ts`; ADR 012 / `docs/design/agent-primer.md`). This is the fix for the onboarding gap: a fresh agent that only *has* the `team_*` tools doesn't know it's on a team or the working-loop, so init seeds the cross-tool agent-context file both Claude Code and Cursor read every session with the member's identity and the loop (join at session start → `team_inbox_check` at task boundaries → `status_update`/`request_help`/`handoff`/`accept`). The block is **marker-delimited** (`<!-- musterd:start -->`…`<!-- musterd:end -->`), so `upsertPrimer` is idempotent and never clobbers the user's own `AGENTS.md` content (create / append-below-prose / update-in-place). The manual-setup printout (`printManual`) includes the block too.
9. **Wait-to-join** — poll the roster, live spinner that resolves when the agent's Presence appears (or a no-rush note if it doesn't within the window).

### `musterd serve [--port 4849] [--host 127.0.0.1]`
Starts the daemon in the foreground. Prints the banner (`render/banner`) + `listening on ws://host:port` **and the served `db:` path** (ADR 016 — the db is chosen by `$MUSTERD_DB`, default `~/.musterd/musterd.db`; showing it makes a wrong-db daemon obvious). Exit 0 on clean shutdown (SIGINT).

### `musterd team create <slug> [--display <name>] [--as <yourname>] [--role <role>]`
`POST /teams`. Creates the team and you as its first **human** member. Saves identity+token to config, sets `current`. Output: `cmd/team-create` frame — green `✓ team "dawn" created`, your member line, dim add hint. Errors: slug taken → `conflict` (exit 9).

### `musterd team add <name> --kind <agent|human> [--role <role>] [--lifecycle forever|session|until --until <iso>]`
`POST /teams/:slug/members`. Prints `✓ added <name> (<kind>, <role>)` and the **join token + ready-to-paste connect hint** (the token is shown once). For agents the hint is the MCP/`join` invocation; copy it into the agent's surface. Output: `cmd/team-add`.

### `musterd team remove <name>`
`POST /teams/:slug/members/:name/remove`. **Soft-removes** a member from the roster (ADR 019) — the sanctioned way to clear a mistaken or stale member instead of editing the daemon's DB. Sets `left_at` via the existing `leaveMember`, so the member drops off every list/auth/route path (all filter `left_at IS NULL`) while its message history + provenance survive; any live session is dropped (same mechanism as reclaim) so the seat frees immediately. Idempotent — removing an already-removed member is a clean `not_found`, never an error stack. Any team member may remove any member (localhost/v0.2; the v0.3 seat model will gate it). No un-remove/reactivate flow — that's the v0.3 seat-claim model. Output: `✓ removed <member> from <team> — off the roster; message history is kept`. Errors: unknown/already-removed member → `not_found` (exit 6).

### `musterd join <slug> --as <name> [--token <tok>] [--surface cli]`
Attaches a Presence for an existing member and stores identity locally. If `--token` omitted, uses config. Opens a short WS `hello` to confirm + register presence, then exits 0 (presence is held by `inbox --watch` or one-shot pings; plain `join` just registers and confirms). Output: `cmd/join` (`✓ <name> joined <slug>` + presence line).

### `musterd send --to <name|@team|@broadcast> --act <act> [--thread <id>] [--reply-to <id>] [--meta k=v ...] <body...>`
Builds an Envelope, `POST /teams/:slug/messages` (or over the live WS if `--watch` session is active). Validates act+meta client-side via `@musterd/protocol` before sending (fail fast). `--to @team` → `{kind:team}`, `--to @broadcast` → broadcast, else `{kind:member,name}`. `accept`/`decline` require `--reply-to`. Echoes the sent `message-row` + `✓ sent`. Output: `cmd/send`.

### `musterd inbox [--watch] [--unread] [--limit 50]`
- Without `--watch`: `GET /inbox`, prints header `inbox — <team> (<n> unread)` + message rows (oldest→newest), unread marked `▌`. Advances the read cursor unless `--unread`-peek (decide: default advances cursor; `--peek` to not). Empty → `state/empty-inbox` verbatim string. Output: `cmd/inbox`.
- With `--watch`: opens WS, holds presence (heartbeats every 15s), streams `deliver` frames as rows live; `◉ watching` indicator. This is the human's "be present on the team" mode and the left/right pane of the flagship demo. Ctrl-C exits 0. Output: `cmd/inbox-watch`.

### `musterd status`
`GET /teams/:slug/members`. Prints a **header line** first — `team · server · db: <path> (schema N)` from `/health` (ADR 016; the db segment is omitted against a pre-0.2 daemon that doesn't report it) — so you can see *which daemon and database* you're reading before the roster. Then renders the roster table: `MEMBER | KIND | ROLE | LIFECYCLE | ACTIVITY` (v0.2 M2 — the old `PRESENCE` column was renamed **ACTIVITY** and moved **last** because its `working: <status> · <age>` label is unbounded and free-flowing, so a long label can't collide with later columns; `ce89bf1`). ACTIVITY resolves via the two-clocks rule (`store/activity.ts`): liveness → `offline`/present, latest `status_update` → `online`/`working`, with the `· <age>` staleness suffix shown only once stale ≥5m. 80-col aligned, presence dot + surface per `brand.md`. Output: `cmd/status` *(the Figma `cmd/status` frame still shows the old `PRESENCE` column + order — frame drift tracked under ADR 008 lockstep; `disabled`/`archived` badges skipped, they need schema + verbs).*

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
