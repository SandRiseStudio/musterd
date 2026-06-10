# 05 — MCP Adapter (`@musterd/mcp`)

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

The **universal harness adapter**. One MCP (stdio) server exposing four tools. Any MCP-capable harness (Claude Code, Codex, …) that launches it gets its agent joined to a Team. This is where harness-agnosticism comes for free: we don't integrate per-harness; we speak MCP. Depends on `@musterd/protocol`; talks to the Team Server over HTTP/WS; never imports `@musterd/server`.

## Stack

- `@modelcontextprotocol/sdk` (stdio transport).
- `@musterd/protocol` for envelope/act validation (identical rules to server + CLI).
- Same `client.ts` HTTP/WS approach as the CLI (consider extracting a shared `@musterd/protocol`-level client; if you do, ADR it).

## How a session binds to a Member (identity bootstrapping)

The MCP server process is configured (via env, set by whoever registers the MCP server in the harness) with:

```
MUSTERD_SERVER   = http://localhost:4849
MUSTERD_TEAM     = dawn
MUSTERD_MEMBER   = Ada
MUSTERD_TOKEN    = mskd_...        # the join token from `musterd team add Ada`
MUSTERD_SURFACE  = claude-code     # or codex; defaults to 'other'
```

On startup the MCP server:
1. Validates config; `GET /health`; `authMember` implicitly via a `POST /teams/:slug/presence` (surface from env) → registers a Presence (status online).
2. Opens a background WS `hello` (as that member/surface) so the agent is *present* and can receive live deliveries while the session runs; heartbeats every 15s.
3. Buffers inbound `deliver` envelopes in memory for `team_inbox_check` to drain (the agent pulls; MCP has no server-push to the model, so we expose a check tool the agent calls).
4. On process exit: clean WS close → presence detaches.

This means: registering the MCP server in a harness == that harness's agent becomes Member `Ada` on team `dawn`, present via surface `claude-code`. No per-harness code.

## The 4 tools (JSON schemas — verbatim contract)

Tool names are stable; descriptions are written for the *agent* reading them.

### `team_send`
```json
{
  "name": "team_send",
  "description": "Send a message to a teammate, the whole team, or broadcast. Use the right act: status_update to report progress, request_help when blocked, handoff to pass work, accept/decline to answer a request_help/handoff (set reply_to), wait to signal you're paused.",
  "inputSchema": {
    "type": "object",
    "required": ["act", "body"],
    "properties": {
      "to":   { "type": "string", "description": "member name, or '@team', or '@broadcast'. Default '@team'." },
      "act":  { "type": "string", "enum": ["message","status_update","request_help","handoff","accept","decline","wait"] },
      "body": { "type": "string" },
      "thread":   { "type": "string", "description": "thread id to reply within (optional)" },
      "reply_to": { "type": "string", "description": "message id this accepts/declines (required for accept/decline)" },
      "meta": { "type": "object", "description": "act-specific fields, e.g. {progress:0.5} for status_update" }
    }
  }
}
```
Maps `to` → Recipient (`@team`/`@broadcast`/name), builds an Envelope (`from`=MUSTERD_MEMBER), validates with `@musterd/protocol`, `POST …/messages` (or live WS). Returns the stored message id + a one-line confirmation.

### `team_inbox_check`
```json
{
  "name": "team_inbox_check",
  "description": "Check for new messages addressed to you or the team since you last checked. Returns unread messages and marks them read. Call this when you want to see if teammates have responded or need you.",
  "inputSchema": { "type": "object", "properties": {
    "unread_only": { "type":"boolean", "default": true },
    "limit": { "type":"number", "default": 50 }
  } }
}
```
Drains the in-memory buffer + `GET /inbox?unread=1`, advances the cursor, returns rows as structured `{from, act, body, ts, thread, meta}` plus a compact text rendering. Dedupes by envelope id (at-least-once).

### `team_status`
```json
{
  "name": "team_status",
  "description": "List the team roster: who's a member, their role, kind (agent/human), and whether they're currently online and on what surface.",
  "inputSchema": { "type": "object", "properties": {} }
}
```
`GET /teams/:slug/members` → roster with presence summary.

### `team_members`
```json
{
  "name": "team_members",
  "description": "Get detail on one member (or all): kind, role, lifecycle, current presences/surfaces. Use to decide who to hand off to or ask for help.",
  "inputSchema": { "type": "object", "properties": {
    "name": { "type":"string", "description":"member name; omit for all" }
  } }
}
```
Same data source as `team_status`, filtered/detailed. (`team_status` = quick roster; `team_members` = detail. Kept separate per the plan's 4-tool list.)

## File tree `packages/mcp/src/`

```
src/
  index.ts        // stdio MCP server; registers the 4 tools; reads env config
  config.ts       // env -> { server, team, member, token, surface }; validates
  client.ts       // HTTP + background WS client (presence + inbox buffer)
  tools/
    send.ts
    inboxCheck.ts
    status.ts
    members.ts
  bind.ts         // startup bootstrap (presence register + WS hello + heartbeat loop)
```

## Reconnect behavior

- Background WS drops → exponential backoff reconnect (1s,2s,4s… cap 30s), re-`hello`, presence re-registered. Missed messages are recovered on the next `team_inbox_check` via the cursor (the buffer may be empty after a drop; the cursor is the source of truth). No message loss because the server log + cursor are authoritative.
- If the server is unreachable at tool-call time, tools return a clear error string (not throw) so the agent can decide to retry — but never silently drop a `team_send`.

## Acceptance tests (`06-testing.md`)

- With env pointing at a live test server + a `team add Ada` token: MCP boot registers Ada's presence (server roster shows Ada online, surface from env).
- `team_send {act:'status_update', body:'...'}` persists a message visible to a CLI `inbox` on the same team.
- A CLI `send --to Ada` then `team_inbox_check` returns that message once and advances the cursor (second check returns nothing).
- `accept` without `reply_to` → validation error surfaced as a tool error string.
- Two MCP servers (Ada via surface claude-code, Lin via surface codex) + one CLI human all on `dawn` exchange messages — this is the flagship scenario, run as an automated test (`06-testing.md`).
