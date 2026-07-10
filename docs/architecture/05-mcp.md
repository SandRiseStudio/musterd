# 05 — MCP Adapter (`@musterd/mcp`)

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

The **universal harness adapter**. One MCP (stdio) server exposing **eighteen tools** (`toolNames.ts`) — the six core team tools documented verbatim below, plus the lane, goal, seat-memory, and report tools added by later ADRs (083/084/091/093). Any MCP-capable harness (Claude Code, Codex, …) that launches it gets the musterd tools — but the session is **dormant by default** (ADR 007 / v0.2 M3): registering the adapter makes the tools _available_, it does **not** occupy the Member's seat. The agent goes online only when it calls `team_join`. This is where harness-agnosticism comes for free: we don't integrate per-harness; we speak MCP. Depends on `@musterd/protocol`; talks to the Team Server over HTTP/WS; never imports `@musterd/server`.

## Stack

- `@modelcontextprotocol/sdk` (stdio transport).
- `@musterd/protocol` for envelope/act validation (identical rules to server + CLI).
- Same `client.ts` HTTP/WS approach as the CLI (consider extracting a shared `@musterd/protocol`-level client; if you do, ADR it).

## How a session binds to a Member (identity bootstrapping)

The MCP server process is configured (via env, set by whoever registers the MCP server in the harness) with:

```
MUSTERD_SERVER   = http://localhost:4849
MUSTERD_TEAM     = dawn
MUSTERD_AGENT_KEY = mskey_...      # the team agent key (ADR 075/076): authenticates the harness; the seat is claimed at run time (no per-seat token — mskd_ removed in the P3 cutover, ADR 077)
MUSTERD_GRANT    = msgr_...        # optional; a pre-issued grant that skips the pending/admin-approval lane on claim (ADR 077)
MUSTERD_SURFACE  = claude-code     # or codex; defaults to 'other'
MUSTERD_CLAIM    = seat:Ada        # optional MANUAL OVERRIDE — NOT written by default provisioning (the seat resolves from binding.json, PR #58); folder claim policy (ADR 032): chat | seat:<name> | role:<role>. drives team_join {} + autojoin
MUSTERD_AUTOJOIN = 1               # optional; opt-in auto-join/claim on launch (off by default)
MUSTERD_PROVENANCE = session       # optional; why this session attaches (ADR 014): session|asked|hook|scheduled|daemon. defaults to 'session'
MUSTERD_WORKSPACE  = auth-rewrite  # optional; declared 'where' label; overrides the auto folder@branch detection
MUSTERD_DRIVER     = nick          # optional; the human driving this session (driver co-presence, ADR 021). `init` bakes the operator's name in; roster shows 'driven by nick'
MUSTERD_BINDING    = /abs/.musterd/binding.json  # optional; explicit binding-file path (ADR 018)
```

**Identity resolution (ADR 018/075/080) — aligned with the CLI.** `MUSTERD_*` env wins; if it carries
no field the adapter falls back to the **workspace binding file** `<workspace>/.musterd/binding.json`
(`{server, team, surface, claim?, agent_key?, grant?}`, `BindingSchema` in `@musterd/protocol`) — the
explicit `MUSTERD_BINDING` path if set, else walking up from cwd — and then, for the **non-secret**
fields only, to the committed **`<workspace>/.musterd/workspace.json`** (`WorkspaceSpecSchema` =
`{server, team, surface, claim}`, ADR 080). So the per-field resolution ladder is **env → binding.json →
workspace.json**, with the two secrets (`agent_key`, `grant`) coming _only_ from env or the gitignored
`binding.json`, never the committable spec. `musterd init`/`agent` write both files; the committed spec
lets a fresh clone self-wire (see `musterd wire`, `04-cli.md`), while binding.json (0600, gitignored)
carries the machine-local secrets — so the CLI and the adapter resolve to the **same** member in a given
folder (no more colliding on the CLI's global `~/.musterd/config.json` single-slot-per-team, the
2026-06-16/17 dogfood failure). To keep that guarantee under a **re-claim**, default provisioning
deliberately does **not** bake the seat into the env: `buildMcpEnv` omits `MUSTERD_CLAIM` (PR #58), so
`musterd claim <name>` — which rewrites `binding.json` — is followed by the adapter on its next launch
rather than being shadowed by a frozen env copy that outranks the file. (`MUSTERD_CLAIM` still works as a
manual override for binding-less/CI folders — it just isn't written by `init`/`agent`/`wire`.) Env is kept first-class for host-injection and hosted/no-filesystem
setups. **Identity is optional** (claim-on-first-use, ADR 032): only the **team** is required to load —
the `agent_key` may be absent, leaving the session a pending presence that claims a seat on first use
(`team_join` / `musterd claim`, which writes the resolved seat back into binding.json).

That write is **anchored to the workspace the config was resolved from** (`config.bindingDir`,
`resolveBindingDir`), never ambient `process.cwd()` (ADR 115): a long-lived adapter's cwd is set by the
harness, not the user, and when it wandered into a *sibling* worktree the persist used to clobber that
worktree's `binding.json` with this session's seat. And because the boot config pins the grant read at
launch, an explicit `team_join {as:X}` **re-reads `binding.json`** from `bindingDir` first — so an
in-session identity repair (a re-provisioned grant for that seat) takes effect without a full MCP
reconnect. A binding for a *different* seat is left untouched.

On `team_join` the adapter sends two attach-time facts on the `hello` (provenance/where seed, ADR 014): **`provenance`** (from `MUSTERD_PROVENANCE`, default `session`) and a **`workspace`** label resolved once at load — the declared `MUSTERD_WORKSPACE` if set, else a gracefully-degrading auto-label (`cwd` folder, qualified by git branch when informative, else the cwd subpath within the repo, else the bare folder). Both are read context only — they carry no routing/auth meaning — and surface dim on the roster (`online via claude-code (session) · repo@branch`).

### Dormant by default (v0.2 M3 / ADR 007)

The original design auto-claimed a Presence on startup. That was the **"N minds, one name"** bug: three Claude Code sessions all bound to `Ada` meant three sessions wearing one identity, each silently acting as that Member. v0.2 deletes the auto-claim. The new contract:

1. **Startup (`bind`) is reachability-only** — `GET /health` and nothing else. No Presence, no WS, no seat occupied. The tools are registered and callable, but the session is _dormant_. (This also closed the ADR-010 HTTP-presence hole: a dormant session can't hold a phantom claim.)
2. **The agent goes online by calling `team_join`** — that opens the background WS `claim` (as Member/surface), registers the Presence, and starts the 15s heartbeat. Only now can it send and receive. The server enforces **single-active, newest-wins** (ADR 017): if the Member already has a live session, this one **takes over** and the older one is told it was `superseded` (it stops, doesn't reconnect). So `team_join` always reclaims your own seat — a reload/orphaned adapter can't lock you out (the dogfood deadlock that ADR 017 fixed). When the takeover is by a successor **in the same workspace** — a reload orphaned this process — the `superseded` frame carries `same_workspace:true` and the replaced adapter **exits cleanly** (drops presence, flushes telemetry, exit 0) via `MusterdClient.onReplaced` rather than lingering dormant (ADR 092); a cross-workspace takeover stays dormant.
3. **Acting is gated on readiness.** `team_send` and `team_inbox_check` refuse until the session is a live occupant — distinguishing two states (claim-on-first-use, ADR 032/033): **pending** (no seat claimed — _"you're a pending presence … claim one first"_, with the session's claim-code) vs **dormant** (claimed but not joined — _"call team_join first"_). This closes the _acting-as-member_ tail of the bug: a session that never joined cannot send messages or drain the shared inbox cursor on the shared token. (The full close — a session that joined elsewhere still acting over HTTP — is the v0.3 seat-claim model.) If a prior (auto)join **failed**, the guard appends the reason (`MusterdClient.lastJoinError`) — so a silent autojoin failure is diagnosable, not just "call team_join first" (ADR 016).
4. **Claim-on-first-use (ADR 032), over the v0.3 claim handshake (ADR 075/077).** A session may start **unclaimed** — bound only to a folder _claim policy_ (`MUSTERD_CLAIM`: `chat` / `seat:Ada` / `role:backend`, resolved via the ADR 018 ladder), authenticated by the **team agent key** (`MUSTERD_AGENT_KEY`), with no fixed seat. It is then a **pending presence** (reachable, holds no seat; it drops a `.musterd/pending/<code>.json` marker so `musterd claim` can find it — ADR 033). `team_join` is **overloaded** to claim a seat via the `claim` frame (which replaced `hello` in the P3 cutover): `{as:"Ada"}` (named seat), `{role:"backend"}` (next open `<role>-<n>` pool handle, resolved server-side), or `{}` (the folder policy). The server responds `occupied` (seat free, or a pre-issued `grant` authorized it — the resolved seat is persisted into `.musterd/binding.json` and occupied), `refused` (a no-dead-end hint), or **`pending`** — a held/declared seat with no grant opens an **admin-approval request** (ADR 077); the session holds until an admin decides (`musterd requests decide`), then the pushed terminal frame brings it online. Your own reloaded seat → newest-wins (ADR 017).
5. **`MUSTERD_AUTOJOIN=1` / a non-`chat` policy** opts a session into claiming + joining automatically right after connect — the convenience path for the common solo case. A claimed binding with `AUTOJOIN=1` just joins; a pending binding with a `seat`/`role` policy auto-claims that seat. A `chat` policy never auto-claims. `musterd init` offers to set autojoin per-binding and stamps `seat:<name>` as the folder policy.
6. **Buffered deliveries:** while joined, inbound `deliver` envelopes are buffered in memory for `team_inbox_check` to drain (the agent pulls; MCP has no server-push to the model, so we expose a check tool the agent calls).

This means: registering the MCP server in a harness == that harness's agent _can become_ Member `Ada` on team `dawn` via surface `claude-code` — but only when it explicitly joins. No per-harness code.

### Shutdown contract (`installShutdownHandlers`, `index.ts`)

A joined adapter holds an open WS socket, which keeps Node's event loop alive — so closing the editor session does **not**, on its own, stop the stdio child. Left unhandled, the adapter outlives its session and the Member lingers "online/working" for hours (the reaper can't help: the socket is still attached). This was a live dogfood bug (a roster showed `working … · 4h` for a session that had ended).

The fix: `installShutdownHandlers` drops Presence (`client.close()`) and exits `0` on **every** host-teardown path, idempotent against signal races:

- **stdin `end` / `close`** — the canonical stdio-server shutdown signal (the host closes our pipe).
- **`SIGINT` / `SIGTERM` / `SIGHUP`** — for hosts that signal instead.
- **`transport.onclose`** — chained (not clobbered) onto any prior handler.

Phantom Presence now drops within the 45s reclaim grace instead of lingering. The `docs/harness-hooks.md` hooks (`SessionStart` + `UserPromptSubmit`) remain a **complementary belt** for keeping an agent checked-in/reporting — no longer the primary mechanism. `musterd init`/`agent` now **auto-install** the `SessionStart` verify hook globally + self-gating (ADR 060): it runs `claude mcp get musterd` before orienting and, if the server isn't registered, points the agent at `musterd wire` (when a committed `.musterd/workspace.json` is present) or `musterd init` — so a fresh clone is told exactly how to self-wire (ADR 080).

## Standing context — the primer as MCP `instructions` (ADR 012 follow-up)

`buildMcpServer` sets the server's **`instructions`** (returned on `initialize`) to the agent primer — `renderPrimer` from `@musterd/protocol`, the **same source** the CLI writes into `AGENTS.md`. This is the _file-free_ onboarding surface: any MCP-speaking harness injects `instructions` as standing context, so the agent learns it's on a team and how to coordinate **without touching `CLAUDE.md` or any per-harness file** (the boundary ADR 012 set; `AGENTS.md` remains the surface for the CLI / no-MCP path). `primerInstructions(config)` is the pure wiring: a **provisioned** session (`config.member` set) gets a named-seat primer; an **unclaimed** session gets the "claim a seat first" variant. The primer is channel-aware — it documents both the `team_*` tools and the `musterd` CLI.

## The core tools (JSON schemas — verbatim contract)

This section contracts the **six core team tools** verbatim; the lane, goal, seat-memory, and report
tools (18 total in `toolNames.ts`) are contracted in their own ADRs (083/084/091/093). Two lifecycle
tools (`team_join` / `team_leave`) gate the working tools. Inspection (`team_status` / `team_members`) works while dormant/pending; sending and inbox draining require a live join.

Tool names are stable; descriptions are written for the _agent_ reading them.

### `team_join` (overloaded — claim-on-first-use, ADR 032)

```json
{
  "name": "team_join",
  "description": "Claim a seat on your team and go online — call this once when you start working. Overloaded (claim-on-first-use): {as:\"Ada\"} claims a named seat (auto-minted if new); {role:\"backend\"} claims the next open seat in a role pool (e.g. backend-2); {} uses this folder's claim policy. The result tells you who you are. Until you claim you are a pending presence — reachable, but you cannot send or check your inbox. After joining, check your inbox.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "as": {
        "type": "string",
        "description": "claim this named seat (auto-minted locally if new)"
      },
      "role": { "type": "string", "description": "claim the next open seat in this role pool" }
    }
  }
}
```

Resolves the target (`as` → named seat; `role` → next `<role>-<n>` handle; neither → the folder `MUSTERD_CLAIM` policy; `chat` with no target → asks the session to name itself, with its claim-code). Then sends the v0.3 **`claim` frame** (ADR 075/077) authenticated by the team agent key: the server responds `occupied` (seat free or a pre-issued grant applied — the session's identity is set, **persisted into `.musterd/binding.json`**, the pending marker cleared, and the live stream opened), `refused` (a no-dead-end hint), or **`pending`** — a held/declared seat with no grant opens an admin-approval request (ADR 077) the session holds on until an admin decides. Idempotent once joined (`"Already joined …"`); your own reloaded seat → newest-wins (ADR 017). The success result returns the **assigned identity** (a fresh session learns who it is; its charter is in `AGENTS.md`) and reminds the agent to `team_inbox_check` now and at every task boundary.

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
  "description": "Send a message to a teammate, the whole team, or broadcast. Use the right act: status_update to report progress, request_help when blocked, handoff to pass work, accept/decline to answer a request_help/handoff/challenge (auto-targets the latest open one — set reply_to to override), wait to signal you're paused, resolve to close a thread when the work is done (set thread to the thread/root id). Steering (ADR 103): steer to change direction (always interrupts; the newest steer supersedes prior direction), challenge to make a teammate justify a task/assumption or reconsider (answer it with an accept carrying evidence), defer to reorder/defer a Goal on the plan (set meta.goal_id, optional meta.wave — a number reorders, \"later\" defers).",
  "inputSchema": {
    "type": "object",
    "required": ["act", "body"],
    "properties": {
      "to": {
        "type": "string",
        "description": "member name, or '@team', or '@broadcast'. Default '@team'."
      },
      "act": {
        "type": "string",
        "enum": [
          "message",
          "status_update",
          "request_help",
          "handoff",
          "accept",
          "decline",
          "wait",
          "resolve",
          "steer",
          "challenge",
          "defer"
        ]
      },
      "body": { "type": "string" },
      "thread": {
        "type": "string",
        "description": "thread id to reply within (optional; required for resolve — the thread it closes)"
      },
      "reply_to": {
        "type": "string",
        "description": "message id this accepts/declines (optional — accept/decline auto-target the latest open request_help/handoff, ADR 067)"
      },
      "meta": {
        "type": "object",
        "description": "act-specific fields, e.g. {progress:0.5} for status_update"
      }
    }
  }
}
```

Maps `to` → Recipient (`@team`/`@broadcast`/name), builds an Envelope (`from`=the claimed member), validates with `@musterd/protocol`, `POST …/messages` (or live WS). Returns the stored message id + a one-line confirmation. **Refuses until ready** — _pending_ (no seat → claim one) or _dormant_ (claimed, not joined → `team_join`), via `notReadyMessage` (ADR 032/033).

### `team_inbox_check`

```json
{
  "name": "team_inbox_check",
  "description": "Check for new messages addressed to you or the team since you last checked. Returns unread messages and marks them read. Call this when you want to see if teammates have responded or need you.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "unread_only": { "type": "boolean", "default": true },
      "limit": { "type": "number", "default": 50 }
    }
  }
}
```

Drains the in-memory buffer + `GET /inbox?unread=1`, advances the cursor, returns rows as structured `{from, act, body, ts, thread, meta}` plus a compact text rendering. Dedupes by envelope id (at-least-once). **Refuses until ready** (pending → claim a seat; dormant → `team_join`) — a session that hasn't joined cannot drain the shared inbox cursor.

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
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "member name; omit for all" }
    }
  }
}
```

Same data source as `team_status`, filtered/detailed. (`team_status` = quick roster; `team_members` = detail. Kept separate per the original core-tool list.)

### `team_memory_save` / `team_memory_read` (ADR 093)

The seat's private **cross-session continuity blob** — the working state a returning occupant needs, written explicitly by the occupant at natural boundaries (before a handoff, at a wrap-up, when told to wind down). One note per seat, last-write-wins; headline ≤120 chars, body ≤8KB (the server rejects over-cap with the limit named). Seat-scoped: readable by this seat only — no cross-seat path, team admins included.

Delivery is **envelope-on-occupy / body-on-demand**: the `occupied` frame carries `{ headline, saved_at, size_bytes }` (never the body), which `team_join` renders as one line —

> Saved memory from 2h ago: "mid-refactor of ws.ts eviction, tests red" — `team_memory_read` to load it (512 bytes).

— so a fresh session pays ~30 tokens and makes an informed fetch decision. Both tools require a live join (the seat is resolved from the session's occupancy). HTTP surface: `PUT`/`GET` `/teams/:slug/memory`.

## File tree `packages/mcp/src/`

```
src/
  index.ts        // stdio MCP server; registers all tools (see `toolNames.ts`); reads env config;
                  //   installShutdownHandlers (drop presence + exit on host teardown);
                  //   autojoin(): claim+join on launch when a default claim exists (ADR 032);
                  //   when unclaimed: writes a pending marker (ADR 033) + startResolutionWatcher (ADR 034)
  toolNames.ts    // TOOL_NAMES: the registered-tool name list (dependency-free so guidance:check can import it; ADR 085)
  config.ts       // env > binding.json > workspace.json -> { server, team, agent_key?, grant?, surface, claim, connId, claimCode }; validates
  client.ts       // HTTP + background WS client; join()/leave()/close(); `joined`/`claimed`;
                  //   setIdentity() (late claim); addMember() (tokenless mint); buffers live while joined
  claim.ts        // claimSeat() mint-or-reuse + claimAndJoin() + adoptIdentity() (live claim, ADR 034)
  pending.ts      // pending markers (.musterd/pending/<code>.json) + resolution sidecars (ADR 034)
  binding.ts      // locate + parse .musterd/binding.json + the committed .musterd/workspace.json (ADR 018/080; shared format with the CLI)
  workspace.ts    // the gracefully-degrading "where" label captured at join (ADR 014)
  otel.ts         // cross-runtime trace-context propagation through the envelope (ADR 011)
  telemetry.ts    // boots the shared SDK as musterd-mcp + wraps every tool in a musterd.tool.call span (ADR 089)
  tools/
    join.ts       // team_join  — claim a seat (as/role/policy) + go online (ADR 032)
    leave.ts      // team_leave — go offline (release seat, ~45s grace)
    send.ts       // refuses until ready (pending → claim; dormant → join)
    inboxCheck.ts // refuses until ready (pending → claim; dormant → join)
    status.ts     // works while dormant/pending
    members.ts    // works while dormant/pending
    memory.ts     // team_memory_save/read — the seat's continuity blob + the join one-liner (ADR 093)
    lanes.ts      // lane_open/claim/board/handoff/update/resolve + team_next orientation brief (ADR 083/084)
    goals.ts      // team_goals / team_goal_declare — the declared-outcome layer above lanes (ADR 048/084)
    insights.ts   // team_report — the insight report at ic/team/exec altitudes (ADR 050/084/125)
    format.ts     // compact text rendering of a message for an agent to read
  bind.ts         // reachability check only (GET /health) — claims no presence
```

## Reconnect behavior

- While **joined**, a background WS drop → exponential backoff reconnect (1s,2s,4s… cap 30s), re-`hello`, presence re-registered. Missed messages are recovered on the next `team_inbox_check` via the cursor (the buffer may be empty after a drop; the cursor is the source of truth). No message loss because the server log + cursor are authoritative.
- A **dormant** session holds no socket and no presence — there is nothing to reconnect until it calls `team_join`.
- If the server is unreachable at tool-call time, tools return a clear error string (not throw) so the agent can decide to retry — but never silently drop a `team_send`.

## Trace-context propagation (ADR 011 — `otel.ts`)

- **Emit:** `team_send` attaches the adapter's active OTel trace context to the envelope as `meta.otel` (`{ traceparent, tracestate? }`) when one exists and the caller didn't set it. **Honor:** `team_inbox_check` records a `musterd.inbox.received` span **linked** to each incoming message's `meta.otel` — causality without claiming ownership (the sender's trace lives in a different backend).
- The adapter formats/parses the W3C `traceparent` directly (only `@opentelemetry/api`; no `@opentelemetry/core`). Since ADR 089 this fires **in production**: `telemetry.ts` boots the shared `@musterd/telemetry` SDK (off by default — standard OTLP env vars only, no phone-home) and wraps every registered tool in a `musterd.tool.call` span, so `team_send` always has an active context to emit. The server records the same `traceparent` on its envelope span (ADR 015), so the handoff is one causal chain across runtimes.

## Acceptance tests (`06-testing.md`)

- With env pointing at a live test server + a `team add Ada` token: MCP boot is **dormant** — the server roster shows Ada `offline`. After `team_join`, the roster shows Ada online with the surface from env.
- A second session for the same Member calling `team_join` **takes over** (newest-wins, ADR 017); the first is `superseded` and goes dormant without reconnecting. A same-workspace successor that proves durable reaps the first with `same_workspace:true`, and its adapter **exits** rather than lingering dormant (ADR 092); a cross-workspace takeover does not exit.
- `team_send` / `team_inbox_check` **before** `team_join` return the not-ready guard (no message sent, cursor untouched): the _pending_ "claim a seat" hint when unclaimed, or the dormant "call team_join first" when claimed-but-not-joined.
- `primerInstructions` returns the primer the server advertises as `instructions`: a named-seat block when `config.member` is set, the "claim your seat first" variant when it isn't — both channel-aware (no file written).
- An **unclaimed** binding (claim policy only): boot is a **pending presence** — a `.musterd/pending/<code>.json` marker exists; `team_join {as:'Ada'}` claims Ada with the agent key (occupied if free/granted, else a pending admin-approval request), writes the binding, and goes online; `{role:'backend'}` claims the next open `backend-<n>`.
- **Live external claim (ADR 034):** while a pending session is running, `musterd claim Ada --for <code>` drops a `<code>.resolved.json` sidecar; the session's resolution watcher adopts the seat and goes online **without a relaunch** (the sidecar is read-once + deleted; the binding is the durable fallback for a missed watcher).
- After join: `team_send {act:'status_update', body:'...'}` persists a message visible to a CLI `inbox` on the same team.
- A CLI `send --to Ada` then `team_inbox_check` returns that message once and advances the cursor (second check returns nothing).
- `accept`/`decline` without `reply_to` → **auto-target the latest open `request_help`/`handoff`** for this member and inherit its thread (ADR 067, parity with the CLI `send`); only when _nothing_ is open is a guidance string surfaced as a tool error. An explicit `reply_to` always wins.
- **Shutdown:** stdin `close` (and each signal / `transport.onclose`) drops presence and exits exactly once, idempotent against races.
- Two MCP servers (Ada via surface claude-code, Lin via surface codex) + one CLI human all on `dawn` join explicitly and exchange messages — this is the flagship scenario, run as an automated test (`06-testing.md`).
