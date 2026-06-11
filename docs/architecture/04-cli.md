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
    init.ts           // the flow: daemon -> team -> detect harness -> configure -> wait-to-join
    harness.ts        // Harness adapter interface (detect + configure)
    mcpEntry.ts       // resolve how to launch @musterd/mcp + build the binding env
    harnesses/
      index.ts        // registry of supported harnesses (pluggable)
      claudeCode.ts   // detect/configure via the `claude mcp` CLI
      cursor.ts       // detect/configure via .cursor/mcp.json (ADR 006 adds the `cursor` surface)
  commands/
    init.ts           // musterd init (delegates to onboard/init.ts)
    serve.ts          // musterd serve [--port]
    team.ts           // team create / team add
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

## Commands (args, flags, output, exit)

All commands accept global `--team <slug>`, `--server <url>`, `--json` (machine output, no color), `--no-color`.

### `musterd init`
Interactive first-run onboarding (requires a TTY; non-TTY prints guidance and exits 2). Flow: (1) check the daemon's `/health`, offering to spawn `musterd serve` detached if it's down; (2) reuse the current team or create one; (3) detect installed harnesses (`onboard/harnesses/`) and whether musterd is already configured in each; (4) pick a harness, name the agent, mint it via `team add`; (5) with confirmation, write the harness's MCP config (`claude mcp add` / `.cursor/mcp.json`); (6) poll the roster and show a live spinner that resolves when the agent's Presence appears. Built on `@clack/prompts` (ADR 005). Read-only `detect()`; only `configure()` writes, and only after a confirm.

### `musterd serve [--port 4849] [--host 127.0.0.1]`
Starts the daemon in the foreground. Prints the banner (`render/banner`) + `listening on ws://host:port`. Exit 0 on clean shutdown (SIGINT).

### `musterd team create <slug> [--display <name>] [--as <yourname>] [--role <role>]`
`POST /teams`. Creates the team and you as its first **human** member. Saves identity+token to config, sets `current`. Output: `cmd/team-create` frame — green `✓ team "dawn" created`, your member line, dim add hint. Errors: slug taken → `conflict` (exit 9).

### `musterd team add <name> --kind <agent|human> [--role <role>] [--lifecycle forever|session|until --until <iso>]`
`POST /teams/:slug/members`. Prints `✓ added <name> (<kind>, <role>)` and the **join token + ready-to-paste connect hint** (the token is shown once). For agents the hint is the MCP/`join` invocation; copy it into the agent's surface. Output: `cmd/team-add`.

### `musterd join <slug> --as <name> [--token <tok>] [--surface cli]`
Attaches a Presence for an existing member and stores identity locally. If `--token` omitted, uses config. Opens a short WS `hello` to confirm + register presence, then exits 0 (presence is held by `inbox --watch` or one-shot pings; plain `join` just registers and confirms). Output: `cmd/join` (`✓ <name> joined <slug>` + presence line).

### `musterd send --to <name|@team|@broadcast> --act <act> [--thread <id>] [--reply-to <id>] [--meta k=v ...] <body...>`
Builds an Envelope, `POST /teams/:slug/messages` (or over the live WS if `--watch` session is active). Validates act+meta client-side via `@musterd/protocol` before sending (fail fast). `--to @team` → `{kind:team}`, `--to @broadcast` → broadcast, else `{kind:member,name}`. `accept`/`decline` require `--reply-to`. Echoes the sent `message-row` + `✓ sent`. Output: `cmd/send`.

### `musterd inbox [--watch] [--unread] [--limit 50]`
- Without `--watch`: `GET /inbox`, prints header `inbox — <team> (<n> unread)` + message rows (oldest→newest), unread marked `▌`. Advances the read cursor unless `--unread`-peek (decide: default advances cursor; `--peek` to not). Empty → `state/empty-inbox` verbatim string. Output: `cmd/inbox`.
- With `--watch`: opens WS, holds presence (heartbeats every 15s), streams `deliver` frames as rows live; `◉ watching` indicator. This is the human's "be present on the team" mode and the left/right pane of the flagship demo. Ctrl-C exits 0. Output: `cmd/inbox-watch`.

### `musterd status`
`GET /teams/:slug/members`. Renders the roster table: `MEMBER | KIND | ROLE | PRESENCE | LIFECYCLE`, 80-col aligned, presence dot + surface per `brand.md`. Output: `cmd/status`.

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

`state/server-down`, `state/no-team`, `state/unknown-member` frames map to exits 7, 2, 6 respectively. Every error prints `✗ <message>` in red to stderr and exits with the code above.

## Acceptance tests (`06-testing.md`)

- `team create` → config gets identity+token, `current` set; rerun same slug → exit 9.
- `team add Ada --kind agent` → prints a token; that token authenticates as Ada (verified against a live test server).
- Two CLI identities (`nick`, `lin` as a human for the test) on `dawn`: `nick send --to lin` then `lin inbox` shows the message with unread=1; second `lin inbox` shows unread=0.
- `inbox --watch` receives a message sent after it started watching, live.
- Output of `status`, `inbox`, `send` matches the Figma terminal frames (snapshot tests against the frozen sample data).
- `--json` emits valid parseable JSON with no ANSI; `NO_COLOR`/pipe strips color.
