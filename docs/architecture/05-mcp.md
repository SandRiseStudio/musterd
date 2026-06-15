# 05 — MCP Adapter (`@musterd/mcp`)

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

The **universal harness adapter**. One MCP (stdio) server exposing **six tools**. Any MCP-capable harness (Claude Code, Codex, …) that launches it gets the musterd tools — but the session is **dormant by default** (ADR 007 / v0.2 M3): registering the adapter makes the tools *available*, it does **not** occupy the Member's seat. The agent goes online only when it calls `team_join`. This is where harness-agnosticism comes for free: we don't integrate per-harness; we speak MCP. Depends on `@musterd/protocol`; talks to the Team Server over HTTP/WS; never imports `@musterd/server`.

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
MUSTERD_AUTOJOIN = 1               # optional; opt-in auto-join on launch (off by default)
MUSTERD_PROVENANCE = session       # optional; why this session attaches (ADR 014): session|asked|hook|scheduled|daemon. defaults to 'session'
MUSTERD_WORKSPACE  = auth-rewrite  # optional; declared 'where' label; overrides the auto folder@branch detection
```

On `team_join` the adapter sends two attach-time facts on the `hello` (provenance/where seed, ADR 014): **`provenance`** (from `MUSTERD_PROVENANCE`, default `session`) and a **`workspace`** label resolved once at load — the declared `MUSTERD_WORKSPACE` if set, else a gracefully-degrading auto-label (`cwd` folder, qualified by git branch when informative, else the cwd subpath within the repo, else the bare folder). Both are read context only — they carry no routing/auth meaning — and surface dim on the roster (`online via claude-code (session) · repo@branch`).

### Dormant by default (v0.2 M3 / ADR 007)

The original design auto-claimed a Presence on startup. That was the **"N minds, one name"** bug: three Claude Code sessions all bound to `Ada` meant three sessions wearing one identity, each silently acting as that Member. v0.2 deletes the auto-claim. The new contract:

1. **Startup (`bind`) is reachability-only** — `GET /health` and nothing else. No Presence, no WS, no seat occupied. The tools are registered and callable, but the session is *dormant*. (This also closed the ADR-010 HTTP-presence hole: a dormant session can't hold a phantom claim.)
2. **The agent goes online by calling `team_join`** — that opens the background WS `hello` (as Member/surface), registers the Presence, and starts the 15s heartbeat. Only now can it send and receive. The server enforces **single-active**: a second live session for the same Member is refused on the WS hello with `member_busy`, and the tool surfaces that cleanly (the session stays dormant; inspection tools still work).
3. **Acting is gated on join.** `team_send` and `team_inbox_check` refuse while dormant (`"call team_join first"`). This closes the *acting-as-member* tail of the bug: a session that never joined cannot send messages or drain the shared inbox cursor on the shared token. (The full close — a session that joined elsewhere still acting over HTTP — is the v0.3 seat-claim model.) If a prior (auto)join **failed**, the guard appends the reason (`MusterdClient.lastJoinError`) — e.g. a wrong-db token rejection — so a silent autojoin failure is diagnosable, not just "call team_join first" (ADR 016).
4. **`MUSTERD_AUTOJOIN=1`** opts a session into calling `team_join` automatically right after connect — the convenience path for the common solo case (one human, one agent, one folder). Off by default so a session never silently occupies a seat. `musterd init` offers to set it per-binding.
5. **Buffered deliveries:** while joined, inbound `deliver` envelopes are buffered in memory for `team_inbox_check` to drain (the agent pulls; MCP has no server-push to the model, so we expose a check tool the agent calls).

This means: registering the MCP server in a harness == that harness's agent *can become* Member `Ada` on team `dawn` via surface `claude-code` — but only when it explicitly joins. No per-harness code.

### Shutdown contract (`installShutdownHandlers`, `index.ts`)

A joined adapter holds an open WS socket, which keeps Node's event loop alive — so closing the editor session does **not**, on its own, stop the stdio child. Left unhandled, the adapter outlives its session and the Member lingers "online/working" for hours (the reaper can't help: the socket is still attached). This was a live dogfood bug (a roster showed `working … · 4h` for a session that had ended).

The fix: `installShutdownHandlers` drops Presence (`client.close()`) and exits `0` on **every** host-teardown path, idempotent against signal races:

- **stdin `end` / `close`** — the canonical stdio-server shutdown signal (the host closes our pipe).
- **`SIGINT` / `SIGTERM` / `SIGHUP`** — for hosts that signal instead.
- **`transport.onclose`** — chained (not clobbered) onto any prior handler.

Phantom Presence now drops within the 45s reclaim grace instead of lingering. The `docs/harness-hooks.md` Stop-hook (SessionStart/Stop) remains a **complementary belt** for hosts that don't close cleanly — no longer the primary mechanism.

## The 6 tools (JSON schemas — verbatim contract)

Two lifecycle tools (`team_join` / `team_leave`) gate the four working tools. Inspection (`team_status` / `team_members`) works while dormant; sending and inbox draining require a live join.

Tool names are stable; descriptions are written for the *agent* reading them.

### `team_join`
```json
{
  "name": "team_join",
  "description": "Join your team and go online as your member — call this once when you start working so teammates can see you and reach you. Until you join you are dormant (you can look at the roster but cannot send or receive). After joining, check your inbox at task boundaries.",
  "inputSchema": { "type": "object", "properties": {} }
}
```
Opens the background WS `hello` (Member/surface from env), registers the Presence, starts the heartbeat. Idempotent (`"Already joined …"`). On the server refusing single-active, returns a plain-language `member_busy` explanation and leaves the session dormant. The success result reminds the agent to `team_inbox_check` now and at every task boundary (dead-air mitigation — messages that arrived while heads-down only surface on a check).

### `team_leave`
```json
{
  "name": "team_leave",
  "description": "Leave the team and go offline (release your seat). Call this when you finish working or step away for a while. The seat is held briefly (~45s) so you can rejoin without losing it; the musterd tools stay available, and team_join brings you back online.",
  "inputSchema": { "type": "object", "properties": {} }
}
```
Drops Presence (`client.leave()`). The seat is held ~45s (the reclaim grace) so a quick rejoin keeps it. No-op if not joined.

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
Maps `to` → Recipient (`@team`/`@broadcast`/name), builds an Envelope (`from`=MUSTERD_MEMBER), validates with `@musterd/protocol`, `POST …/messages` (or live WS). Returns the stored message id + a one-line confirmation. **Refuses while dormant** (`"call team_join first"`) — a session that hasn't joined cannot send.

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
Drains the in-memory buffer + `GET /inbox?unread=1`, advances the cursor, returns rows as structured `{from, act, body, ts, thread, meta}` plus a compact text rendering. Dedupes by envelope id (at-least-once). **Refuses while dormant** (`"call team_join first to receive messages"`) — a session that hasn't joined cannot drain the shared inbox cursor.

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
  index.ts        // stdio MCP server; registers the 6 tools; reads env config;
                  //   installShutdownHandlers (drop presence + exit on host teardown);
                  //   MUSTERD_AUTOJOIN=1 opt-in auto-join after connect
  config.ts       // env -> { server, team, member, token, surface }; validates
  client.ts       // HTTP + background WS client; join()/leave()/close(); `joined` flag;
                  //   presence + inbox buffer live only while joined
  tools/
    join.ts       // team_join  — go online (WS hello + presence + heartbeat)
    leave.ts      // team_leave — go offline (release seat, ~45s grace)
    send.ts       // refuses while dormant
    inboxCheck.ts // refuses while dormant
    status.ts     // works while dormant
    members.ts    // works while dormant
  bind.ts         // reachability check only (GET /health) — claims no presence
```

## Reconnect behavior

- While **joined**, a background WS drop → exponential backoff reconnect (1s,2s,4s… cap 30s), re-`hello`, presence re-registered. Missed messages are recovered on the next `team_inbox_check` via the cursor (the buffer may be empty after a drop; the cursor is the source of truth). No message loss because the server log + cursor are authoritative.
- A **dormant** session holds no socket and no presence — there is nothing to reconnect until it calls `team_join`.
- If the server is unreachable at tool-call time, tools return a clear error string (not throw) so the agent can decide to retry — but never silently drop a `team_send`.

## Trace-context propagation (ADR 011 — `otel.ts`)

- **Emit:** `team_send` attaches the adapter's active OTel trace context to the envelope as `meta.otel` (`{ traceparent, tracestate? }`) when one exists and the caller didn't set it. **Honor:** `team_inbox_check` records a `musterd.inbox.received` span **linked** to each incoming message's `meta.otel` — causality without claiming ownership (the sender's trace lives in a different backend).
- The adapter formats/parses the W3C `traceparent` directly (only `@opentelemetry/api`; no `@opentelemetry/core`). This is **convention plumbing**: inert when there's no active context / no registered provider (adapter telemetry SDK is deferred — observability.md §4). The server records the same `traceparent` on its envelope span (ADR 015), so the handoff is one causal chain across runtimes.

## Acceptance tests (`06-testing.md`)

- With env pointing at a live test server + a `team add Ada` token: MCP boot is **dormant** — the server roster shows Ada `offline`. After `team_join`, the roster shows Ada online with the surface from env.
- A second session for the same Member calling `team_join` is refused with `member_busy` (single-active); the first stays online.
- `team_send` / `team_inbox_check` **before** `team_join` return the "call team_join first" guard (no message sent, cursor untouched).
- After join: `team_send {act:'status_update', body:'...'}` persists a message visible to a CLI `inbox` on the same team.
- A CLI `send --to Ada` then `team_inbox_check` returns that message once and advances the cursor (second check returns nothing).
- `accept` without `reply_to` → validation error surfaced as a tool error string.
- **Shutdown:** stdin `close` (and each signal / `transport.onclose`) drops presence and exits exactly once, idempotent against races.
- Two MCP servers (Ada via surface claude-code, Lin via surface codex) + one CLI human all on `dawn` join explicitly and exchange messages — this is the flagship scenario, run as an automated test (`06-testing.md`).
