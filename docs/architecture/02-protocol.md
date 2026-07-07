# 02 — Protocol (distilled from SPEC.md)

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

This is the implementation-facing distillation of `SPEC.md`. `SPEC.md` is the normative, versioned, public protocol; this file restates it as concrete JSON shapes + the WS/HTTP contract the server and clients implement. **If this file and `SPEC.md` disagree, `SPEC.md` wins** and you fix this file (with an ADR if substantive). The canonical zod schemas live in `@musterd/protocol` and are the executable form of both.

Protocol version: **`musterd/0.3`** (string constant `PROTOCOL_VERSION` in `@musterd/protocol`).

## The Envelope

Every message on the wire is an Envelope:

```jsonc
{
  "id": "01J...", // ULID, client-generated; server authoritative if it collides
  "v": "musterd/0.3", // protocol version
  "team": "dawn", // team slug
  "from": "Ada", // member name (sender), within team
  "to": {
    // recipient — exactly one of these shapes:
    "kind": "member", //   member | team | broadcast
    "name": "Lin", //   present iff kind=member
  },
  "act": "handoff", // one of the 8 acts
  "body": "auth module ready for wiring",
  "thread": "01J...", // optional: ULID of thread root; omit/null to start a thread
  "meta": {}, // optional: act-specific fields (see below)
  "ts": 1733760000000, // epoch ms, client clock; server records its own created_at too
}
```

`to` variants:

- `{ "kind": "member", "name": "Lin" }` — direct.
- `{ "kind": "team" }` — every current Member of the team (excluding sender) gets it in inbox/stream.
- `{ "kind": "broadcast" }` — same delivery as team in v1; reserved to later mean cross-team/announce. Treat as team for delivery; keep the distinct kind.

## The 8 Acts (Co-Gym-grounded)

| Act             | Meaning                                                           | Required `meta`/fields    | Optional `meta`                             |
| --------------- | ----------------------------------------------------------------- | ------------------------- | ------------------------------------------- |
| `message`       | plain communication, no protocol semantics                        | —                         | —                                           |
| `status_update` | "here's what I'm doing / did"                                     | —                         | `progress` (0..1), `state` (free text)      |
| `request_help`  | asking a specific member or the team to assist/unblock            | —                         | `blocking` (bool), `topic` (string)         |
| `handoff`       | transferring a piece of work to someone                           | —                         | `artifact` (string ref), `summary` (string) |
| `accept`        | accepting a prior `request_help`/`handoff`                        | `meta.in_reply_to` (ULID) | —                                           |
| `decline`       | declining a prior `request_help`/`handoff`                        | `meta.in_reply_to` (ULID) | `reason` (string)                           |
| `wait`          | "hold / I'm blocked / pause for me"                               | —                         | `until` (epoch ms), `reason` (string)       |
| `resolve`       | closing a thread — the work it tracks is **done** (v0.3, ADR 025) | `thread` (ULID)           | `reason` (string)                           |

Rules:

- `accept`/`decline` **must** carry `meta.in_reply_to` pointing at the message they answer, and **should** set `thread` to that message's thread (or its id if it was a root).
- `resolve` **must** carry a non-empty `thread` (the id of the thread it closes; a no-thread root is closed by its own id). It is the thread-terminal "done" — any member may send it (v0.3 doesn't enforce a closer); UIs treat a resolved thread's open asks as no longer pending (ADR 024/025).
- Unknown `meta` keys are allowed and preserved (forward-compat); unknown **acts** are rejected (validation error). This asymmetry is intentional: acts are the contract, meta is extensible.
- Streaming/step-level granularity (StreamMA finding) is a **v2 transport option**, noted in `SPEC.md`; v1 sends whole envelopes.

## WebSocket connection lifecycle

Endpoint: `ws://<host>:<port>/ws` (default `ws://localhost:4849`). Sub-protocol messages are JSON frames `{ "type": ..., ... }`.

Handshake state machine: `connecting → hello → authenticated → subscribed → (live)`.

1. **Client → `hello`**: `{ "type":"hello", "v":"musterd/0.3", "team":"dawn", "as":"Ada", "token":"<member token>", "surface":"claude-code" }`
2. **Server → `welcome`** (on success): `{ "type":"welcome", "member": <Member>, "presence_id":"01J...", "server_time": 1733760000000 }`. Server creates/refreshes a `presence` row (status `online`). On failure → `error` frame (see codes) then close.
3. **Client → `subscribe`** (optional scoping; default = team): `{ "type":"subscribe", "scope":"team" }` → Server `subscribed`. Scope `"team-all"` opens the **firehose** — every envelope routed on the team, not just recipient-matched ones — for read-only observers like the web dashboard (ADR 061). Pair it with `GET …/messages` for history backfill.
4. **Live frames:**
   - Client → `send`: `{ "type":"send", "envelope": <Envelope> }` → server validates, persists, routes; replies `{ "type":"ack", "id": <envelope.id> }`.
   - Server → `deliver`: `{ "type":"deliver", "envelope": <Envelope> }` for each message routed to this member's presence — or, for a `team-all` subscriber, every envelope on the team (deduped against recipients + sender, so a normal recipient never gets it twice).
   - Client → `heartbeat`: `{ "type":"heartbeat" }` every **15s**; server updates `last_seen_at`. (Server may also treat any inbound frame as a heartbeat.)
   - Server → `presence`: `{ "type":"presence", "member":"Lin", "status":"online", "surface":"codex" }` on roster presence changes.
   - Either → `error`: `{ "type":"error", "code":"...", "message":"..." }`. A `superseded` error MAY carry `"same_workspace": true` (ADR 092) — the displacing claim came from the client's own workspace (a reload successor), signalling the replaced adapter to **exit** rather than linger dormant; absent ⇒ a cross-workspace takeover (stay dormant).
5. **Close:** server removes the presence row (or marks offline) and emits a `presence` offline event to the team.

Heartbeat/timeout values are defined in `03-server.md` (heartbeat 15s, offline after 45s missed = 3 intervals).

## HTTP API (for stateless clients: CLI one-shots, MCP tools)

Base `http://localhost:4849`. JSON in/out. Auth via `Authorization: Bearer <member token>` except team-creation bootstrap. All responses wrap errors as `{ "error": { "code":..., "message":... } }` with the HTTP status from the code table.

| Method | Path                                         | Body                                                                | Response                                                          | Notes                                                                                                                                                                                                                                                                           |
| ------ | -------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                                    | —                                                                   | `{ "ok":true, "v":"musterd/0.3", "db", "schema", "connections" }` | liveness + diagnostics (ADR 016/047)                                                                                                                                                                                                                                            |
| `POST` | `/teams`                                     | `{ "slug","display?","creator":{ "name","kind":"human","role?" } }` | `{ "team", "member", "token" }`                                   | bootstrap; returns creator's member token                                                                                                                                                                                                                                       |
| `GET`  | `/teams/:slug`                               | —                                                                   | `{ "team", "members":[…] }`                                       | roster                                                                                                                                                                                                                                                                          |
| `POST` | `/teams/:slug/members`                       | `{ "name","kind","role?","lifecycle?","lifecycle_until?" }`         | `{ "member", "token" }`                                           | `team add`; token shown once. For a **file-backed** team (ADR 058) this is _project-and-return_: the daemon reconciles the seat's committed `.musterd/seats/<name>.toml` and hands back its token, never originating the seat (a db-only team keeps the legacy originate path). |
| `GET`  | `/teams/:slug/members`                       | —                                                                   | `{ "members":[ <Member + presence summary> ] }`                   | for `status`                                                                                                                                                                                                                                                                    |
| `POST` | `/teams/:slug/members/:name/reclaim`         | —                                                                   | `{ "ok", "member" }`                                              | operator force-drop of a member's stuck live session; frees the seat (clears presence + `bound_at`, ADR 017/058)                                                                                                                                                                |
| `POST` | `/teams/:slug/members/:name/remove`          | —                                                                   | `{ "ok", "member", "kind" }`                                      | soft-remove (`left_at`); history kept (ADR 019)                                                                                                                                                                                                                                 |
| `POST` | `/teams/:slug/unbind`                        | —                                                                   | `{ "ok", "member" }`                                              | `unbind`: the caller releases **its own** seat (authed by own token) — clears presence + `bound_at` back to _declared_; the seat stays on the team (ADR 058)                                                                                                                    |
| `POST` | `/teams/:slug/messages`                      | `{ "envelope" }`                                                    | `{ "ack": <message> }`                                            | send via HTTP (no live socket)                                                                                                                                                                                                                                                  |
| `GET`  | `/teams/:slug/inbox?since=<cursor>&unread=1` | —                                                                   | `{ "messages":[…], "cursor":{…} }`                                | inbox fetch                                                                                                                                                                                                                                                                     |
| `GET`  | `/teams/:slug/messages?since=<ts>&limit=<n>` | —                                                                   | `{ "messages":[…] }`                                              | whole-team timeline (firehose history backfill, ADR 061)                                                                                                                                                                                                                        |
| `POST` | `/teams/:slug/inbox/cursor`                  | `{ "last_read_message_id" }`                                        | `{ "cursor" }`                                                    | mark read                                                                                                                                                                                                                                                                       |
| `POST` | `/teams/:slug/presence`                      | `{ "surface","status?" }`                                           | `{ "presence" }`                                                  | stateless presence ping                                                                                                                                                                                                                                                         |
| `POST` | `/teams/:slug/availability`                  | `{ "status","until?" }`                                             | `{ <member summary> }`                                            | set your own availability axis (ADR 044)                                                                                                                                                                                                                                        |

The WS `send` and HTTP `POST …/messages` share one validation+route path on the server (`03-server.md`).

**Serving the web UI (ADR 062).** With `--web-root <dir>` / `MUSTERD_WEB_ROOT` the daemon also serves a built web UI from that directory: any unmatched `GET` outside the API namespaces (`/health`, `/teams/*`) returns a file, with extensionless client routes (e.g. `/live`) falling back to `index.html`. This puts the dashboard, the HTTP API, and the WS on one origin — no CORS, no proxy — and the WS upgrade gate (above) admits a **same-origin** `Origin` (its host:port equals the `Host` header) so the daemon-served page can connect. Off by default (API-only).

## Error codes (shared by WS `error` frames and HTTP)

| code               | HTTP | meaning                                                                                                                                                                                                                            |
| ------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bad_request`      | 400  | malformed frame/body/envelope                                                                                                                                                                                                      |
| `validation`       | 422  | envelope failed schema (bad act, missing required meta, etc.)                                                                                                                                                                      |
| `unauthorized`     | 401  | missing/invalid token                                                                                                                                                                                                              |
| `forbidden`        | 403  | token valid but not a member of this team / not this member                                                                                                                                                                        |
| `not_found`        | 404  | team/member not found                                                                                                                                                                                                              |
| `conflict`         | 409  | duplicate (e.g. team slug taken, member name taken)                                                                                                                                                                                |
| `member_busy`      | 409  | (v0.2, ADR 010) a Member was already live — _no longer thrown on hello since ADR 017's newest-wins; retained for compatibility_                                                                                                    |
| `superseded`       | 409  | (v0.2, ADR 017) your session was taken over by a newer same-identity attach — terminal; don't reconnect. Carries `same_workspace:true` when the successor is in your own workspace (ADR 092 — reload successor; the adapter exits) |
| `version_mismatch` | 426  | client `v` not compatible with server                                                                                                                                                                                              |
| `server_error`     | 500  | unexpected                                                                                                                                                                                                                         |
| `claim_conflict`   | 409  | (P3, ADR 078/SPEC A.8) the target seat is already occupied                                                                                                                                                                         |
| `expired_grant`    | 403  | (P3, ADR 078/SPEC A.8) the presented grant is past its lifetime (403, aligned with June's P3.1 ADR 076; SPEC A.8 allows 410/403)                                                                                                   |

The CLI maps these to exit codes (`04-cli.md`).

## `claim` handshake frames (P3, ADR 078 / SPEC A.3)

The governed successor to `hello` — **additive schemas, not yet wired into `WSClientFrame`/`WSServerFrame`** (that wiring is Cleo's P3.2 cutover step, part of the one atomic merge; ADR 069 decision 2). Landing the frame shapes first lets June's P3.1 substrate + Cleo's P3.2 handshake import a stable contract.

- `ClaimFrame` (client→server) — `{ type:'claim', v, team, key, target:{seat}|{role}|{observe:true}, grant?, surface }`. `key` = agent key (harness) or human credential; `grant` present → occupy, omitted → open a claim request (A.5).
- `OccupiedFrame` (server→client) — `{ type:'occupied', seat:Member, presence_id, server_time, charter?, memory:MemoryEnvelope|null }`. `memory` is the seat-scoped continuity envelope (ADR 093) — `MemoryEnvelope = { headline (≤120), saved_at, size_bytes }` (`.strict()`, so the body never rides the frame) — or `null` when nothing is saved; the body is fetched on demand via `GET /teams/:slug/memory`.
- `RefusedFrame` (server→client) — `{ type:'refused', code:RefusedCode, message, claimable:[…], hint }`. `RefusedCode` = `claim_conflict|forbidden|not_found|disabled|banned|expired_grant` (A.8; `disabled`/`banned` surface the seat's account state — HTTP maps those to `forbidden` 403).
- `PendingFrame` (server→client) — `{ type:'pending', request_id, message }`. The WS stays open; the server pushes the terminal `occupied`/`refused` when an admin decides (spec-gap 3, no client polling).
- `P3_AUDIT_ACTIONS` — a reference tuple naming the P3 audit verbs (`grant.issue/use/revoke`, `claim.occupy/refused`, `request.decide`, `key.rotate`, `policy.change`, `account_status.change`) for naming consistency; `AuditEntry.action` stays an **open string** (ADR 074).

## `@musterd/protocol` exports (the executable contract)

```ts
export const PROTOCOL_VERSION = 'musterd/0.3';
export const ACTS = ['message','status_update','request_help','handoff','accept','decline','wait','resolve','steer','challenge','defer'] as const; // steer/challenge/defer: the steering trio, ADR 103
export const SURFACES = ['cli','claude-code','codex','cursor','web','ios','slack','other'] as const;

export const Act = z.enum(ACTS);
export const Surface = z.enum(SURFACES);
export const Recipient = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), name: z.string() }),
  z.object({ kind: z.literal('team') }),
  z.object({ kind: z.literal('broadcast') }),
]);
export const Envelope = z.object({
  id: z.string(), v: z.literal(PROTOCOL_VERSION), team: z.string(),
  from: z.string(), to: Recipient, act: Act,
  body: z.string().default(''), thread: z.string().nullish(),
  meta: z.record(z.unknown()).nullish(), ts: z.number().int(),
}).superRefine(actMetaRules);   // enforces accept/decline -> meta.in_reply_to; resolve -> thread; defer -> meta.goal_id (ADR 103)

export type Envelope = z.infer<typeof Envelope>;
export const Member = z.object({ /* mirrors members table, no token_hash */ });
export const WSClientFrame = z.discriminatedUnion('type', [ Hello, Subscribe, Send, Heartbeat ]);
export const WSServerFrame = z.discriminatedUnion('type', [ Welcome, Subscribed, Ack, Deliver, PresenceEvt, ErrorFrame ]);
export const ErrorCode = z.enum(['bad_request','validation','unauthorized','forbidden','not_found','conflict','member_busy','superseded','version_mismatch','server_error','claim_conflict','expired_grant']);  // ADR 078 adds the two P3 codes
export const AuditEntry = z.object({ id, ts, actor:string|null, action:string, target:string|null, result:z.enum(['allow','deny']), detail:record|null });  // ADR 071/074 — `action` is an OPEN string (P3 adds verbs); the audit-log wire contract
export const AuditResponse = z.object({ audit: AuditEntry[] });
export const P3_AUDIT_ACTIONS = ['grant.issue','grant.use','grant.revoke','claim.occupy','claim.refused','request.decide','key.rotate','policy.change','account_status.change'] as const;  // ADR 078 — reference vocabulary; action stays OPEN
// ADR 078 (P3, SPEC A.3) — the claim handshake frames. Additive; NOT yet in WSClientFrame/WSServerFrame (Cleo's P3.2 cutover wires them).
export const ClaimTarget = z.union([ z.object({seat:string}), z.object({role:string}), z.object({observe:z.literal(true)}) ]);
export const RefusedCode = z.enum(['claim_conflict','forbidden','not_found','disabled','banned','expired_grant']);
export const ClaimFrame = z.object({ type:'claim', v, team, key:string, target:ClaimTarget, grant?:string, surface:Surface });
export const MemoryEnvelopeSchema = z.object({ headline:string(1..120), saved_at:int, size_bytes:int>=0 }).strict();
export const OccupiedFrame = z.object({ type:'occupied', seat:Member, presence_id, server_time:int, charter?:string, memory:MemoryEnvelopeSchema.nullable() });
export const RefusedFrame = z.object({ type:'refused', code:RefusedCode, message, claimable:string[], hint:string });
export const PendingFrame = z.object({ type:'pending', request_id, message });

// ADR 018/075/080 — the workspace binding files (binding.ts). Read by both the CLI and the MCP adapter.
export const WorkspaceSpec = z.object({ server:string, team:string, surface:Surface, claim?:ClaimPolicy });  // the committed, secret-free `.musterd/workspace.json`
export const Binding = WorkspaceSpec.extend({ agent_key?:string, grant?:string });                          // gitignored `.musterd/binding.json` = spec + the two secrets
```

`actMetaRules` is the single place encoding the per-act `meta` requirements from the table above; both server and clients import it so validation is identical everywhere. **Changing any of these schemas requires an ADR** (`00-overview.md` hard rule).

`AuditEntry`/`AuditResponse` (ADR 071/074) are the wire contract for the admin-only `GET /teams/:slug/audit` governance log. `action` is deliberately an **open string** rather than an enum: ADR 071 shapes the table for P3 verbs (`grant.*`, `claim.*`, `account_status.change`, `key.rotate`, `policy.change`, `request.decide`) that add rows not schema, and the CLI renders unknown verbs plainly instead of rejecting them. The server's internal `AuditAction` union (in `@musterd/server`) is the enumerated write-side type; this protocol schema is the permissive read-side contract.
