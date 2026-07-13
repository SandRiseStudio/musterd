# 03 — Server (`@musterd/server`)

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

The daemon. SQLite store + WebSocket + HTTP API + presence tracker + inbox delivery. Depends only on `@musterd/protocol`.

## Stack

- Runtime: Node ≥ 22 (repo-wide `engines`; native TypeScript execution is relied on by repo tooling).
- HTTP + WS: a single Node `http.Server`; HTTP routes handled directly (no framework needed — small surface), WS via the `ws` package upgraded on `/ws`. (If a router helps, `hono` is acceptable — record the choice in an ADR if you add a dep.)
- DB: `better-sqlite3` (synchronous).
- Validation: `@musterd/protocol` zod schemas at every boundary.
- IDs: `ulid`. Hashing: Node `crypto` (`sha256`).

## File tree `packages/server/src/`

```
src/
  index.ts            // entry: createServer(opts) -> { listen, reload, close, db, port, dbPath, scheme }; CLI bin starts it
  config.ts           // env + defaults (port 4849, host, db path, tunable timeouts) + secured-bind guard, scheme, Origin/Host check (ADR 040)
  context.ts          // Ctx: the per-server bundle (db, hub, config, rosterRoots) threaded through routing/transport
  db/
    open.ts           // openDb(path): Database; sets PRAGMAs; runs migrations
    migrations.ts     // ordered [{version, up(db)}]; runMigrations(db)
    schema.ts         // SCHEMA_V1_SQL: the DDL from 01-data-model.md as a TS constant (ADR 003)
    seed.ts           // seedDawn(db) test helper
  store/
    teams.ts          // createTeam, getTeamBySlug, listMembers, archiveTeam
    members.ts        // addMember (issues token), getMember, authMember(token), leaveMember
    messages.ts       // insertMessage, listInbox(memberId, since), listTeamMessages
    presence.ts       // attach, heartbeat, detach/release, listPresence, reapStale (kind-scoped single-active, ADR 042)
    activity.ts       // resolveActivity: the two-clocks rule → offline/online/working (v0.2 M2)
    cursors.ts        // getCursor, setCursor, unreadCount
    metrics.ts        // backing queries for the observable telemetry gauges (ADR 015)
    lanes.ts          // coordination lanes P1: CRUD + the two warn-only checks; goal_id join + deriveGoalStatus (ADR 083/084)
    orientation.ts    // deriveNext: the `musterd next` orientation brief over lanes + the latest handoff (ADR 049/084)
    goals.ts          // declared-Goal seam: listGoals (meta.goal messages, status + epoch derived) + nextGoal + goalEpochBumps (ADR 048/084/111)
    staleness.ts      // stale-plan detection: stale_plan/stale_dependency lane warnings from goal-epoch vs claim-time (ADR 111)
    insights.ts       // the insight engine: flowMetrics + waitingOn + deriveSteeringMetrics + deriveReport (ADR 050/084/125)
    delivery.ts       // the per-recipient delivery ledger, derived from log + cursors + audit: actDelivery + openDirectedLedger (ADR 090)
    mast.ts           // the MAST failure detectors: timeToUnblock + stalledThreads + circularHandoffs → deriveMast (ADR 091)
    memory.ts         // seat memory: saveMemory/getMemory/memoryEnvelope/clearMemory — daemon-private continuity blob, LWW, caps (ADR 093)
    audit.ts          // append-only governance audit log: appendAudit/listAudit (+ authorized_by filter, ADR 071/127)
    grants.ts         // grant store: issueGrant/validateGrant/consumeGrant/revokeGrant (ADR 076, P3.1)
    requests.ts       // claim-request store: createRequest/decideRequest/expireRequests/listRequests (ADR 076-077, P3.1-P3.2)
    residency.ts      // the wake ledger: residency enrollment + wake leases — claimWakeLeases (transactional derivation) / settleWakeLease / expireWakeLeases; rate policy derived from residency.* audit rows (ADR 131)
    roles.ts          // roles table: role defaults (capabilities + charter), projected from roles/*.toml (ADR 070)
    rows.ts           // raw DB row shapes (TeamRow/MemberRow/PresenceRow/MessageRow) + toMember (resolves account_status + capabilities, ADR 070)
  protocol/
    validate.ts       // thin wrappers over @musterd/protocol schemas + error mapping
    route.ts          // routeEnvelope(): the ONE validate+persist+deliver path (WS & HTTP share it)
  transport/
    http.ts           // HTTP route table (02-protocol HTTP API); authTouch ambient presence (ADR 057) + x-musterd-model re-attest for agent seats only (ADR 119/121)
    ws.ts             // WS upgrade, handshake state machine, frame dispatch
    hub.ts            // in-memory connection registry: member -> Set<conn>; broadcast/deliver
  presence/
    reaper.ts         // setInterval: mark/remove presence rows past timeout; emit offline events
  projection/
    load.ts           // read .musterd/team.toml + seats/*.toml -> TeamSpec; fail-closed per seat (ADR 058)
    reconcile.ts      // match-by-name delta: ADD/UPDATE/REVIVE/REMOVE the projection from the files
    serialize.ts      // db projection -> file structures (guard-1 round-trip + `team export`)
    watcher.ts        // debounced fs.watch over each roster root -> full reconcile (ADR 058)
  telemetry.ts        // minimal OpenTelemetry, off unless an OTLP endpoint is set (ADR 015)
  errors.ts           // MusterdError(code,message) + toHttp()/toFrame()
  log.ts              // structured logger (07-conventions format)
```

## Key exported signatures

```ts
// index.ts
export interface ServerOptions {
  port?: number; host?: string; dbPath?: string; db?: Database;  // db is injected for tests
  tlsCert?: string; tlsKey?: string; trustProxy?: boolean;       // native TLS / proxy ack (ADR 040)
  rosterRoots?: string[];                                        // durable roster roots (ADR 058); [] disables reconcile
}
export function createServer(opts?: ServerOptions): {
  listen(): Promise<{ port: number; host: string }>;
  reload(): void;          // re-resolve roster roots + reconcile + re-point the watcher (SIGHUP, ADR 058)
  close(): Promise<void>;
  db: Database;            // exposed for tests
  readonly port: number;   // bound port (after listen())
  readonly dbPath: string; // the db this daemon serves (diagnostics)
  readonly scheme: 'ws' | 'wss';
};

// protocol/route.ts — the heart. Used by both transports.
export interface RouteResult { message: StoredMessage; recipients: string[] /* member ids */; }
export function routeEnvelope(ctx: Ctx, team: TeamRow, sender: Member, env: Envelope): RouteResult;
//  steps: validate(env) -> assert sender.name===env.from & sender.team===env.team
//         -> persist via messages.insertMessage
//         -> resolve recipients (member|team|broadcast)
//         -> for each recipient: hub.deliver(recipientId, env) if present; always durable (inbox = query, no copy)
//         -> return RouteResult

// store/presence.ts
export function attach(db, memberId, surface, connId, ctx?): Presence;    // creates row, status online; ctx = { provenance, workspace } (ADR 014) + { driver } (ADR 021) + { model } (ADR 101)
export function heartbeat(db, presenceId): void;                          // bumps last_seen_at
export function reattestModel(db, presenceId, model): {previous}|void;    // ADR 101: mid-occupancy model switch; writes + returns previous only on a real change
export function currentAttestedModel(db, memberId, presenceId?): string|null; // ADR 101: the per-act model stamp source — the sending occupancy's attestation (presenceId), else newest-attested
export function detach(db, presenceId): void;                             // removes row
export function listPresence(db, teamId): PresenceSummary[];              // for status/roster (incl. provenance/workspace/driver/model)
export function reapStale(db, timeoutMs): { offlined: string[] };         // presence ids removed

// store/messages.ts
export function insertMessage(db, env: Envelope, fromMemberId, toMemberId|null): StoredMessage;
export function listInbox(db, memberId, opts:{ since?:number; unreadOnly?:boolean; limit?:number }): StoredMessage[];
//   inbox(member) = messages WHERE team=member.team AND (to_member=member OR to_kind IN ('team','broadcast'))
//                   AND from_member != member  [AND ts > cursor.last_read_ts if unreadOnly]
```

## Startup sequence (`createServer().listen()`)

1. Load config (`config.ts`): port `MUSTERD_PORT||4849`, host `MUSTERD_HOST||127.0.0.1`, db `MUSTERD_DB||~/.musterd/musterd.db` (or injected `db` for tests), plus TLS (`MUSTERD_TLS_CERT`/`MUSTERD_TLS_KEY`), `--insecure-trust-proxy`, the WS upgrade allowlists (`MUSTERD_ALLOWED_HOSTS`/`MUSTERD_ALLOWED_ORIGINS`), and the env-tunable timeouts (ADR 040).
   - **Secured-bind guard (ADR 040).** `createServer` calls `assertBindSecurity` immediately, before opening the db: it **refuses** a non-loopback host (anything outside `localhost`/`::1`/`127.0.0.0/8`) unless native TLS is configured _or_ `--insecure-trust-proxy` is set — a helpful refusal naming the host and the three ways forward. With TLS the daemon is an `https`/`wss` server (`createHttpsServer`); else plaintext `http`/`ws`. Loopback default is unchanged.
   - **Roster roots (ADR 058).** Config also resolves the durable seat-roster roots via `resolveRosterRoots` — the union of `MUSTERD_TEAMS_DIR` (comma/colon-separated) and the `rosterHome` registry in `~/.musterd/config.json` (written by `musterd team export`). Watch debounce is `RECONCILE_DEBOUNCE_MS = 250`. An explicit `opts.rosterRoots` (tests) overrides; `[]` disables reconcile.
2. `openDb()` → set `WAL` + `foreign_keys` → `runMigrations()` (to the latest schema version).
3. Build the `ctx` bundle (`db`, `hub`, `config`, `rosterRoots`); the `hub` starts as an empty connection registry.
4. Mount HTTP routes (`transport/http.ts`) and WS upgrade handler (`transport/ws.ts`) on one `http.Server`.
5. **Boot reconcile (ADR 058).** When roster roots exist, `reconcileAll(db, ctx.rosterRoots)` projects the durable `.musterd/` files into the db before serving (logged `reconcile_boot`) — idempotent, so the roster the first request sees matches git.
6. `listen(port, host)` → resolve with bound address. Then start the presence `reaper` interval and, when roster roots exist, the debounced roster `watcher` (a change → full `reconcileAll`). The WS upgrade handler runs the pure `checkUpgrade` Origin/Host gate (ADR 040) on every upgrade — a present `Origin` (a browser; CLI/MCP clients send none) must be allowlisted, and the `Host` must be loopback, the bound host, or allowlisted — rejecting with `403` otherwise to blunt cross-site / DNS-rebinding abuse.
7. `reload()` (wired to **SIGHUP** by the daemon bin): re-resolve roster roots, `reconcileAll`, and re-point the watcher — so a team exported after boot is picked up without a restart.
8. `close()`: stop reaper + watcher, close all WS conns, close http server, `db.close()`.

## Presence heartbeat rules (load-bearing constants)

> These four constants are the **defaults**; each is **env-overridable** for WAN-tuned teams (ADR 040) via `MUSTERD_HEARTBEAT_INTERVAL_MS`, `MUSTERD_PRESENCE_TIMEOUT_MS`, `MUSTERD_REAPER_INTERVAL_MS`, `MUSTERD_RECLAIM_GRACE_MS` (positive-integer ms, zod-validated). The same-workspace reap grace (ADR 092) is likewise `MUSTERD_SUPERSEDE_GRACE_MS` (default 5s). Out of the box the values below are unchanged. The reaper and the WS close path read them from `ctx.config`, so an override takes effect everywhere; the newest-wins self-heal (ADR 017) is tested at WAN-like timing.

- `HEARTBEAT_INTERVAL_MS = 15_000` — clients send `heartbeat` (or any frame) at this cadence.
- `PRESENCE_TIMEOUT_MS = 45_000` — 3 missed intervals. A presence row with `now - last_seen_at > timeout` is stale.
- Reaper runs every `15_000ms`: deletes stale rows, and for each removed row emits a `presence` offline event to the team **iff** that member now has zero live presences.
- On clean WS close: `detach()` immediately + emit offline (if last presence). Don't wait for the reaper.
- `status` transitions: a member is `online` if any presence row is fresh; `away` is only set explicitly by a client (`heartbeat` with `{status:'away'}` or HTTP presence ping) — the server never invents `away`. No fresh presence ⇒ `offline`.

## Single-active + reclaim grace (kind-scoped — v0.2 ADR 010, newest-wins ADR 017, kind-scope ADR 042)

- **Single-active is kind-scoped (ADR 042).** It binds **agent** seats; **human** seats fan out.
  - **Agents — one live Presence, newest wins.** On a WS `claim` for an _agent_ Member that already holds a live Presence, the handler **displaces** the existing session: it sends each old connection a `superseded` error frame, force-closes it (`Connection.close`), evicts it from the hub, clears the member's presence rows, then attaches the new Presence. The newest session is the one live occupant. (ADR 017 replaced ADR 010's _refuse with `member_busy`_ — refusing locked a Member out of its own seat after a reload/orphaned adapter; the dogfood deadlock.) The displaced adapter treats `superseded` as terminal and does not reconnect, so there's no ping-pong and orphans self-heal.
    - **Displacement is workspace-scoped (ADR 068), with a durability gate (ADR 092).** A claim from a _different_ workspace displaces immediately (a genuinely different session). A _same_-workspace claim does **not** supersede at claim time — a transient ~90s health-check probe spawns from the same workspace and must not flap the seat. Instead, once the successor proves durable (still attached after `supersedeGraceMs`, default 5s), it **reaps** the same-workspace predecessor(s) it found: sends them `superseded` with `same_workspace:true`, closes and clears them. A probe disconnects before the grace, so the reap timer finds the successor gone (`hub.getConn`) and keeps the incumbent. The reap arms a warn-level `claim.duplicate_workspace` audit row at schedule time (drift signal); the successor's own close cancels its pending reap. This is the fix for the orphaned-adapter war (#118) without regressing ADR 068's anti-flap.
  - **Humans — fan out.** A `hello` for a _human_ Member skips the displace loop and the `clearMemberPresence` clear: it attaches an _additional_ Presence and `hub.add`s the new connection alongside any existing ones, so a person can watch on a phone while acting on a laptop. `hub.deliver` already pushes to **all** of a member's connections and `broadcastTeam` iterates every connection, so a directed `deliver` and a `@team` broadcast both reach every human surface; the durable inbox cursor dedupes (at-least-once). The roster collapses the N Presences to one member row via `listPresence` (the `presences[]` array carries the surfaces). The single-active rule exists to stop _parallel autonomous minds_ wearing one agent identity — an agent hazard, not a human one (`docs/design/deployment-topology.md` §7).
- **Reclaim grace (both kinds).** On detach (clean close or reap), the _that_ Presence is held for `PRESENCE_TIMEOUT_MS` (45s) via a `held_until` marker (presence schema v2) so the _same_ Member can rejoin without being refused. The reaper sweeps expired holds **per Presence**, and a Member only goes offline when its **last** live Presence drops. This makes a flaky reconnect or a quick restart seamless while still freeing the seat promptly.

## Roster activity (v0.2)

- `listPresence`/roster `summarize` resolve a coarse `activity` per Member by the **two-clocks rule** (`store/activity.ts` `resolveActivity`): the liveness clock (fresh presence?) decides `offline` vs present; the status clock (latest `status_update`, via `latestStatusUpdate` — prefers `meta.state`, falls back to body) decides `online` (idle) vs `working`. The backing summary is returned as `state`, with `last_status_at` driving the CLI's `· <age>` staleness suffix. These are **additive** roster fields; a v0.1 reader ignoring them still conforms.
- `summarize` also sets **`reclaimable`** per Member (ADR 105) from `listReclaimableMemberIds` (`store/presence.ts`) — a seat whose reclaim hold is still in the future (`held_until > now`). This is the one *positive* read of held rows (every other query filters them out); the seat still reads `presence: 'offline'` (grace stays hidden from display), but the flag lets the client-side clobber guard (ADR 066) treat a held-within-grace reservation as occupied rather than a vacancy. Additive; older readers ignore it.

## Availability (v0.2 — ADR 044)

- **`POST /teams/:slug/availability`** (authed via `authMember`): the caller sets **their own** seat's availability axis (SPEC A.6 Axis 2). Body `{ status: available|away|dnd, until? }`; `until` (ms epoch) rides only `away` (the `away_until` encoding) — the handler drops a stray `until` from `available`/`dnd` so the stored shape can't lie. Persisted by `store/members.ts` `setAvailability(db, memberId, availability|null)` into the **existing `members.availability` TEXT column** (JSON-encoded) — **no migration**. `rows.ts` `toMember` parses it back through `AvailabilitySchema` defensively (a malformed/legacy blob degrades to `null` = implicit-available). Returns the updated member summary.
- **Never inferred, self-only.** Only the member's own authed call sets it; no other seat or heuristic does (contrast presence/activity, which are derived). The roster `summarize` already carries `availability` via `toMember`, so it surfaces with no extra plumbing. The notify loop reads it back **client-side** to tier deliveries (away holds all but `urgent`; dnd passes directed + `urgent`); the server only stores + exposes. The v0.3 governed superset — `off_hours`, schedule enforcement, the `can_*` capability gating who may set/flag — is the named seam, not built here.

## Telemetry (v0.2 — ADR 015, off by default)

- `telemetry.ts` adds minimal OpenTelemetry (observability.md §4). `routeEnvelope` is wrapped in a `musterd.envelope.process` span with `musterd.*` attributes (team/act/from/to.kind/envelope.id/thread + `otel.traceparent` from `meta.otel`, ADR 011; ADR 101 adds `musterd.model` + `musterd.model.family` from the sender's attested occupancy, beside the `musterd.from.id` normalized-seat dimension) — **never the body**. Metrics: `musterd.envelopes` (counter), `musterd.delivery.latency` (histogram), `musterd.errors` (counter; recorded at the transport boundary in `http.ts`/`ws.ts`), `musterd.presence.churn` (counter), and the observable gauges sampled on collection — `musterd.presence.active` (live presences by surface), `musterd.inbox.lag` (age of the slowest unread inbox), and `musterd.insight.diversity_flags` (live model-diversity flags across teams, ADR 101), backed by `store/metrics.ts`/`store/mast.ts` and registered via `registerRuntimeGauges` in `listen()` (only when telemetry is enabled). ADR 082 added the coordination metrics `musterd.coordination.loop_latency` (accept/decline/resolve vs the act they close) + `musterd.coordination.open_loops` (unanswered request_help/handoff, sampled via `countOpenLoops` in `store/messages.ts`), and the opt-in `musterd.agent.tokens` counter (self-reported `meta.usage`, by member/direction/model).
- **HTTP request log (ADR 082):** the `createServer` handler emits a structured `http_request` line per request — `method`/`path`/`status`/`ms`, info 2xx/3xx, warn 4xx, error 5xx — path only (no query/headers), `/health` polls skipped. This is the HTTP layer `daemon.log` previously lacked (finding 001).
- **Off unless** a standard OTLP endpoint env is set (`OTEL_EXPORTER_OTLP_ENDPOINT` etc.); never when `OTEL_SDK_DISABLED=true`. No phone-home. `createServer().listen()` calls `startTelemetry()` (dynamic-imports the SDK only when enabled); `close()` flushes it. When off, the `@opentelemetry/api` calls are no-ops.

## Seat memory (ADR 093)

- **A daemon-private, seat-scoped continuity blob.** `store/memory.ts` backs the `seat_memory` table (schema v13): one row per member (`member_id` PK/FK `ON DELETE CASCADE`), `headline`/`body`/`saved_at`, **last-write-wins** — no history, no versions. It is deliberately **not** in the git seat-file: this is live working state (presence's side of the ADR 058 durable/live line), and half-done context or a pasted secret must never land in repo history.
- **Store API:** `saveMemory(db, memberId, { headline, body })` upserts and stamps `saved_at = Date.now()`, enforcing `MEMORY_HEADLINE_MAX_CHARS` (120, by character count) and `MEMORY_BODY_MAX_BYTES` (8192, by **UTF-8 byte** length) — an oversize/empty input throws `bad_request` with the limit named. `getMemory` is the explicit body read; `memoryEnvelope` returns `{ headline, saved_at, size_bytes }` (`size_bytes` = `Buffer.byteLength(body)`) and **never the body** — it is what rides the occupied frame (ADR 093 §3). `clearMemory` deletes, returning whether a row existed (idempotent).
- **HTTP surface — seat-authenticated, own-seat only.** `PUT /teams/:slug/memory` (`{ headline, body? }` → `saveMemory` → `204`), `GET …/memory` (`200 { headline, body, saved_at }` or `404` when none; `?envelope=1` returns the headline-only envelope instead — the `musterd status` one-liner read, never the body), `DELETE …/memory` (`clearMemory` → `204`, idempotent). All three resolve the seat from the presented token (`authMember`), apply the banned-=-inert gate (`assertSeatCanRead` — a `disabled`/`banned`/`archived` seat can't touch memory either), and act on **the caller's own seat** — the URL carries no member name, so there is deliberately **no cross-seat read path** (team admins included, ADR 093 §4): an admin hitting `/memory` reads its _own_ note, never another's. The save schema (`MemorySaveBody`) shapes types only; the caps live in `saveMemory` so the 400 names the exact limit.
- **Envelope on occupy.** The four occupied-frame sites (WS `ws.ts`; HTTP admin-approve + grant + credential self-authorize) now emit `memory: memoryEnvelope(db, member.id)` instead of the old `memory: null` — a returning occupant's join frame carries the headline/age/size line, and the body travels only over the explicit `GET`.
- **Audit sizes-only.** `memory.save`/`memory.clear` audit actions carry `size_bytes`/`headline_len` in `detail`, never the headline or body text (hard rule 5).

## Inbox delivery semantics

- **At-least-once, cursor-based, no per-recipient copies.** The `messages` table is the single log. A member's inbox is a _query_ (see `listInbox`) filtered by their `inbox_cursors.last_read_ts`. "Mark read" advances the cursor.
- **Live + durable are the same data.** When a member is present, `hub.deliver` pushes the envelope to their socket immediately _and_ it's already persisted — so a reconnect re-reads anything missed via the cursor. A client may receive a message both live and on the next inbox fetch; clients dedupe by `envelope.id` (at-least-once contract; documented for CLI/MCP).
- Delivery to a recipient who is offline = nothing to push; the row sits in the log and surfaces on their next `inbox`/`reconnect`.
- `team`/`broadcast` deliver to all current members except the sender; each has an independent cursor.

## Auth

- `authMember(token)`: `sha256(token)` → lookup `members.token_hash`. Returns the Member or throws `unauthorized`. WS `hello.token` and HTTP `Authorization: Bearer` both go through this. The `unauthorized` message points at the likely cause — a token minted against a _different_ db than this daemon serves (ADR 016).

## Diagnostics (ADR 016)

- `GET /health` → `{ ok, v, db, schema, connections }` — `db` is the served database path, `schema` the applied migration version, and **`connections`** (ADR 047) is a derived count of distinct members holding a _live_ presence **across all teams** in this db (`countLivePresences` mirrors the roster's live filter: fresh heartbeat, not a release hold). It's the signal the CLI's `service stop|restart` guard reads to refuse bouncing a shared daemon out from under a teammate; a bare count (not names) keeps this unauthenticated endpoint from becoming a cross-team member directory, and it's additive/back-compatible (no protocol bump). `musterd serve` prints the db path **and the effective host + scheme** (`ws://…` vs `wss://…`, plus a note when a TLS-terminating proxy is trusted) on startup and logs `host`/`scheme`/`db`/`schema` on `listening`; `RunningServer.dbPath` and `RunningServer.scheme` expose them (ADR 040 extends this posture so "what is this daemon exposing?" is answerable). This makes "which db is this daemon serving?" answerable, so a daemon accidentally serving the wrong db (reads as "everyone offline") is self-diagnosing.
- Team creation (`POST /teams`) needs no token; it mints the creator Member + token.
- A token authorizes acting **as that one Member in that one Team**. `forbidden` if the envelope `from`/`team` don't match the authenticated Member.

## Acceptance tests (gate before CLI work — see `06-testing.md`)

- DB opens, migrates to the latest schema version, PRAGMAs set.
- `POST /teams` → creates team + creator member + token; duplicate slug → `409 conflict`.
- `addMember` issues a token whose `sha256` matches stored `token_hash`; plaintext never stored.
- `routeEnvelope` persists + returns correct recipients for member/team/broadcast; bad act → `422 validation`.
- Two WS clients on team `dawn`: a `send` from Ada to Lin yields a `deliver` to Lin and an `ack` to Ada; Lin offline → message appears in Lin's `inbox` fetch with correct unread count.
- Presence: attach → online in roster; stop heartbeats → reaper offlines within ~`timeout+interval`; clean close → immediate offline.
- Single-active newest-wins (agents, ADR 017): a second concurrent `claim` for the same _agent_ Member takes over and the first receives `superseded`; after detach, a re-attach within the 45s grace succeeds (the `held_until` seat is reclaimed). Kind-scoped (ADR 042): two concurrent claims for the same _human_ Member both occupy (neither superseded), a directed message and a `@team` broadcast both deliver to both human sessions, and the roster lists the human once with both surfaces. Workspace-scoped + durability-gated (ADR 068/092): a same-workspace probe that disconnects within the grace never supersedes the incumbent, while a durable same-workspace successor reaps its predecessor with `same_workspace:true` after `supersedeGraceMs`; a different-workspace claim still supersedes immediately (no `same_workspace` flag).
- Activity: a present Member with a recent `status_update` resolves to `working` (with `state`/`last_status_at`); present without one → `online`; no fresh presence → `offline`.
- Availability (ADR 044): `POST /availability` sets the caller's seat; the roster reflects `away`+`until` / `dnd` / `available`; `until` is kept only for `away`; an unknown status → `400 bad_request`; unauthenticated → `401`.
- `seedDawn` produces the exact fixture in `01-data-model.md`.
