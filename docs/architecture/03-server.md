# 03 — Server (`@musterd/server`)

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

The daemon. SQLite store + WebSocket + HTTP API + presence tracker + inbox delivery. Depends only on `@musterd/protocol`.

## Stack

- Runtime: Node ≥ 20 (repo targets Node 22).
- HTTP + WS: a single Node `http.Server`; HTTP routes handled directly (no framework needed — small surface), WS via the `ws` package upgraded on `/ws`. (If a router helps, `hono` is acceptable — record the choice in an ADR if you add a dep.)
- DB: `better-sqlite3` (synchronous).
- Validation: `@musterd/protocol` zod schemas at every boundary.
- IDs: `ulid`. Hashing: Node `crypto` (`sha256`).

## File tree `packages/server/src/`

```
src/
  index.ts            // entry: createServer(opts) -> { listen, close }; CLI bin starts it
  config.ts           // env + defaults (port 4849, host, db path, timeouts)
  db/
    open.ts           // openDb(path): Database; sets PRAGMAs; runs migrations
    migrations.ts     // ordered [{version, up(db)}]; runMigrations(db)
    schema.ts         // SCHEMA_V1_SQL: the DDL from 01-data-model.md as a TS constant (ADR 003)
    seed.ts           // seedDawn(db) test helper
  store/
    teams.ts          // createTeam, getTeamBySlug, listMembers, archiveTeam
    members.ts        // addMember (issues token), getMember, authMember(token), leaveMember
    messages.ts       // insertMessage, listInbox(memberId, since), listTeamMessages
    presence.ts       // attach, heartbeat, detach, listPresence, reapStale
    cursors.ts        // getCursor, setCursor, unreadCount
  protocol/
    validate.ts       // thin wrappers over @musterd/protocol schemas + error mapping
    route.ts          // routeEnvelope(): the ONE validate+persist+deliver path (WS & HTTP share it)
  transport/
    http.ts           // HTTP route table (02-protocol HTTP API)
    ws.ts             // WS upgrade, handshake state machine, frame dispatch
    hub.ts            // in-memory connection registry: member -> Set<conn>; broadcast/deliver
  presence/
    reaper.ts         // setInterval: mark/remove presence rows past timeout; emit offline events
  errors.ts           // MusterdError(code,message) + toHttp()/toFrame()
  log.ts              // structured logger (07-conventions format)
```

## Key exported signatures

```ts
// index.ts
export interface ServerOptions { port?: number; host?: string; dbPath?: string; db?: Database; }
export function createServer(opts?: ServerOptions): {
  listen(): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
  db: Database;            // exposed for tests
};

// protocol/route.ts — the heart. Used by both transports.
export interface RouteResult { message: StoredMessage; recipients: string[] /* member ids */; }
export function routeEnvelope(ctx: Ctx, sender: Member, env: Envelope): RouteResult;
//  steps: validate(env) -> assert sender.name===env.from & sender.team===env.team
//         -> persist via messages.insertMessage
//         -> resolve recipients (member|team|broadcast)
//         -> for each recipient: hub.deliver(recipientId, env) if present; always durable (inbox = query, no copy)
//         -> return RouteResult

// store/presence.ts
export function attach(db, memberId, surface, connId, ctx?): Presence;    // creates row, status online; ctx = { provenance, workspace } (ADR 014)
export function heartbeat(db, presenceId): void;                          // bumps last_seen_at
export function detach(db, presenceId): void;                             // removes row
export function listPresence(db, teamId): PresenceSummary[];              // for status/roster (incl. provenance/workspace)
export function reapStale(db, timeoutMs): { offlined: string[] };         // presence ids removed

// store/messages.ts
export function insertMessage(db, env: Envelope, fromMemberId, toMemberId|null): StoredMessage;
export function listInbox(db, memberId, opts:{ since?:number; unreadOnly?:boolean; limit?:number }): StoredMessage[];
//   inbox(member) = messages WHERE team=member.team AND (to_member=member OR to_kind IN ('team','broadcast'))
//                   AND from_member != member  [AND ts > cursor.last_read_ts if unreadOnly]
```

## Startup sequence (`createServer().listen()`)

1. Load config (`config.ts`): port `MUSTERD_PORT||4849`, host `MUSTERD_HOST||127.0.0.1`, db `MUSTERD_DB||~/.musterd/musterd.db` (or injected `db` for tests).
2. `openDb()` → set `WAL` + `foreign_keys` → `runMigrations()`.
3. Build the `hub` (empty connection registry).
4. Mount HTTP routes (`transport/http.ts`) and WS upgrade handler (`transport/ws.ts`) on one `http.Server`.
5. Start the presence `reaper` interval.
6. `listen(port, host)` → resolve with bound address.
7. `close()`: stop reaper, close all WS conns, close http server, `db.close()`.

## Presence heartbeat rules (load-bearing constants)

- `HEARTBEAT_INTERVAL_MS = 15_000` — clients send `heartbeat` (or any frame) at this cadence.
- `PRESENCE_TIMEOUT_MS = 45_000` — 3 missed intervals. A presence row with `now - last_seen_at > timeout` is stale.
- Reaper runs every `15_000ms`: deletes stale rows, and for each removed row emits a `presence` offline event to the team **iff** that member now has zero live presences.
- On clean WS close: `detach()` immediately + emit offline (if last presence). Don't wait for the reaper.
- `status` transitions: a member is `online` if any presence row is fresh; `away` is only set explicitly by a client (`heartbeat` with `{status:'away'}` or HTTP presence ping) — the server never invents `away`. No fresh presence ⇒ `offline`.

## Single-active + reclaim grace (v0.2 — ADR 010)

- **One live Presence per Member.** `attach` refuses a second concurrent Presence for a Member that already holds a live one, with `member_busy` (HTTP 409 / WS `error`). This is the wire enforcement behind "a Member is an identity, not a session."
- **Reclaim grace.** On detach (clean close or reap), the seat is held for `PRESENCE_TIMEOUT_MS` (45s) via a `held_until` marker (presence schema v2) so the *same* Member can rejoin without being refused. The reaper sweeps expired holds. This makes a flaky reconnect or a quick restart seamless while still freeing the seat promptly.

## Roster activity (v0.2)

- `listPresence`/roster `summarize` resolve a coarse `activity` per Member by the **two-clocks rule** (`store/activity.ts` `resolveActivity`): the liveness clock (fresh presence?) decides `offline` vs present; the status clock (latest `status_update`, via `latestStatusUpdate` — prefers `meta.state`, falls back to body) decides `online` (idle) vs `working`. The backing summary is returned as `state`, with `last_status_at` driving the CLI's `· <age>` staleness suffix. These are **additive** roster fields; a v0.1 reader ignoring them still conforms.

## Telemetry (v0.2 — ADR 015, off by default)

- `telemetry.ts` adds minimal OpenTelemetry (observability.md §4). `routeEnvelope` is wrapped in a `musterd.envelope.process` span with `musterd.*` attributes (team/act/from/to.kind/envelope.id/thread + `otel.traceparent` from `meta.otel`, ADR 011) — **never the body**. Metrics: `musterd.envelopes` (counter), `musterd.delivery.latency` (histogram), `musterd.errors` (counter; recorded at the transport boundary in `http.ts`/`ws.ts`), `musterd.presence.churn` (counter), and two observable gauges sampled on collection — `musterd.presence.active` (live presences by surface) and `musterd.inbox.lag` (age of the slowest unread inbox), backed by `store/metrics.ts` and registered via `registerRuntimeGauges` in `listen()` (only when telemetry is enabled).
- **Off unless** a standard OTLP endpoint env is set (`OTEL_EXPORTER_OTLP_ENDPOINT` etc.); never when `OTEL_SDK_DISABLED=true`. No phone-home. `createServer().listen()` calls `startTelemetry()` (dynamic-imports the SDK only when enabled); `close()` flushes it. When off, the `@opentelemetry/api` calls are no-ops.

## Inbox delivery semantics

- **At-least-once, cursor-based, no per-recipient copies.** The `messages` table is the single log. A member's inbox is a *query* (see `listInbox`) filtered by their `inbox_cursors.last_read_ts`. "Mark read" advances the cursor.
- **Live + durable are the same data.** When a member is present, `hub.deliver` pushes the envelope to their socket immediately *and* it's already persisted — so a reconnect re-reads anything missed via the cursor. A client may receive a message both live and on the next inbox fetch; clients dedupe by `envelope.id` (at-least-once contract; documented for CLI/MCP).
- Delivery to a recipient who is offline = nothing to push; the row sits in the log and surfaces on their next `inbox`/`reconnect`.
- `team`/`broadcast` deliver to all current members except the sender; each has an independent cursor.

## Auth

- `authMember(token)`: `sha256(token)` → lookup `members.token_hash`. Returns the Member or throws `unauthorized`. WS `hello.token` and HTTP `Authorization: Bearer` both go through this.
- Team creation (`POST /teams`) needs no token; it mints the creator Member + token.
- A token authorizes acting **as that one Member in that one Team**. `forbidden` if the envelope `from`/`team` don't match the authenticated Member.

## Acceptance tests (gate before CLI work — see `06-testing.md`)

- DB opens, migrates to version 1, PRAGMAs set.
- `POST /teams` → creates team + creator member + token; duplicate slug → `409 conflict`.
- `addMember` issues a token whose `sha256` matches stored `token_hash`; plaintext never stored.
- `routeEnvelope` persists + returns correct recipients for member/team/broadcast; bad act → `422 validation`.
- Two WS clients on team `dawn`: a `send` from Ada to Lin yields a `deliver` to Lin and an `ack` to Ada; Lin offline → message appears in Lin's `inbox` fetch with correct unread count.
- Presence: attach → online in roster; stop heartbeats → reaper offlines within ~`timeout+interval`; clean close → immediate offline.
- Single-active: a second concurrent `attach` for the same Member → `member_busy`; after detach, a re-attach within the 45s grace succeeds (the `held_until` seat is reclaimed, not refused).
- Activity: a present Member with a recent `status_update` resolves to `working` (with `state`/`last_status_at`); present without one → `online`; no fresh presence → `offline`.
- `seedDawn` produces the exact fixture in `01-data-model.md`.
