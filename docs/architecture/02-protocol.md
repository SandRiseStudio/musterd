# 02 — Protocol (distilled from SPEC.md)

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

This is the implementation-facing distillation of `SPEC.md`. `SPEC.md` is the normative, versioned, public protocol; this file restates it as concrete JSON shapes + the WS/HTTP contract the server and clients implement. **If this file and `SPEC.md` disagree, `SPEC.md` wins** and you fix this file (with an ADR if substantive). The canonical zod schemas live in `@musterd/protocol` and are the executable form of both.

Protocol version: **`musterd/0.1`** (string constant `PROTOCOL_VERSION` in `@musterd/protocol`).

## The Envelope

Every message on the wire is an Envelope:

```jsonc
{
  "id": "01J...",            // ULID, client-generated; server authoritative if it collides
  "v": "musterd/0.1",        // protocol version
  "team": "dawn",            // team slug
  "from": "Ada",             // member name (sender), within team
  "to": {                    // recipient — exactly one of these shapes:
    "kind": "member",        //   member | team | broadcast
    "name": "Lin"            //   present iff kind=member
  },
  "act": "handoff",          // one of the 7 acts
  "body": "auth module ready for wiring",
  "thread": "01J...",        // optional: ULID of thread root; omit/null to start a thread
  "meta": { },               // optional: act-specific fields (see below)
  "ts": 1733760000000        // epoch ms, client clock; server records its own created_at too
}
```

`to` variants:
- `{ "kind": "member", "name": "Lin" }` — direct.
- `{ "kind": "team" }` — every current Member of the team (excluding sender) gets it in inbox/stream.
- `{ "kind": "broadcast" }` — same delivery as team in v1; reserved to later mean cross-team/announce. Treat as team for delivery; keep the distinct kind.

## The 7 Acts (Co-Gym-grounded)

| Act             | Meaning | Required `meta` | Optional `meta` |
|-----------------|---------|-----------------|-----------------|
| `message`       | plain communication, no protocol semantics | — | — |
| `status_update` | "here's what I'm doing / did" | — | `progress` (0..1), `state` (free text) |
| `request_help`  | asking a specific member or the team to assist/unblock | — | `blocking` (bool), `topic` (string) |
| `handoff`       | transferring a piece of work to someone | — | `artifact` (string ref), `summary` (string) |
| `accept`        | accepting a prior `request_help`/`handoff` | `in_reply_to` (ULID) | — |
| `decline`       | declining a prior `request_help`/`handoff` | `in_reply_to` (ULID) | `reason` (string) |
| `wait`          | "hold / I'm blocked / pause for me" | — | `until` (epoch ms), `reason` (string) |

Rules:
- `accept`/`decline` **must** carry `meta.in_reply_to` pointing at the message they answer, and **should** set `thread` to that message's thread (or its id if it was a root).
- Unknown `meta` keys are allowed and preserved (forward-compat); unknown **acts** are rejected (validation error). This asymmetry is intentional: acts are the contract, meta is extensible.
- Streaming/step-level granularity (StreamMA finding) is a **v2 transport option**, noted in `SPEC.md`; v1 sends whole envelopes.

## WebSocket connection lifecycle

Endpoint: `ws://<host>:<port>/ws` (default `ws://localhost:4849`). Sub-protocol messages are JSON frames `{ "type": ..., ... }`.

Handshake state machine: `connecting → hello → authenticated → subscribed → (live)`.

1. **Client → `hello`**: `{ "type":"hello", "v":"musterd/0.1", "team":"dawn", "as":"Ada", "token":"<member token>", "surface":"claude-code" }`
2. **Server → `welcome`** (on success): `{ "type":"welcome", "member": <Member>, "presence_id":"01J...", "server_time": 1733760000000 }`. Server creates/refreshes a `presence` row (status `online`). On failure → `error` frame (see codes) then close.
3. **Client → `subscribe`** (optional scoping; default = team): `{ "type":"subscribe", "scope":"team" }` → Server `subscribed`.
4. **Live frames:**
   - Client → `send`: `{ "type":"send", "envelope": <Envelope> }` → server validates, persists, routes; replies `{ "type":"ack", "id": <envelope.id> }`.
   - Server → `deliver`: `{ "type":"deliver", "envelope": <Envelope> }` for each message routed to this member's presence.
   - Client → `heartbeat`: `{ "type":"heartbeat" }` every **15s**; server updates `last_seen_at`. (Server may also treat any inbound frame as a heartbeat.)
   - Server → `presence`: `{ "type":"presence", "member":"Lin", "status":"online", "surface":"codex" }` on roster presence changes.
   - Either → `error`: `{ "type":"error", "code":"...", "message":"..." }`.
5. **Close:** server removes the presence row (or marks offline) and emits a `presence` offline event to the team.

Heartbeat/timeout values are defined in `03-server.md` (heartbeat 15s, offline after 45s missed = 3 intervals).

## HTTP API (for stateless clients: CLI one-shots, MCP tools)

Base `http://localhost:4849`. JSON in/out. Auth via `Authorization: Bearer <member token>` except team-creation bootstrap. All responses wrap errors as `{ "error": { "code":..., "message":... } }` with the HTTP status from the code table.

| Method | Path | Body | Response | Notes |
|--------|------|------|----------|-------|
| `GET`  | `/health` | — | `{ "ok":true, "v":"musterd/0.1" }` | liveness |
| `POST` | `/teams` | `{ "slug","display?","creator":{ "name","kind":"human","role?" } }` | `{ "team", "member", "token" }` | bootstrap; returns creator's member token |
| `GET`  | `/teams/:slug` | — | `{ "team", "members":[…] }` | roster |
| `POST` | `/teams/:slug/members` | `{ "name","kind","role?","lifecycle?","lifecycle_until?" }` | `{ "member", "token" }` | `team add`; token shown once |
| `GET`  | `/teams/:slug/members` | — | `{ "members":[ <Member + presence summary> ] }` | for `status` |
| `POST` | `/teams/:slug/messages` | `{ "envelope" }` | `{ "ack": <message> }` | send via HTTP (no live socket) |
| `GET`  | `/teams/:slug/inbox?since=<cursor>&unread=1` | — | `{ "messages":[…], "cursor":{…} }` | inbox fetch |
| `POST` | `/teams/:slug/inbox/cursor` | `{ "last_read_message_id" }` | `{ "cursor" }` | mark read |
| `POST` | `/teams/:slug/presence` | `{ "surface","status?" }` | `{ "presence" }` | stateless presence ping |

The WS `send` and HTTP `POST …/messages` share one validation+route path on the server (`03-server.md`).

## Error codes (shared by WS `error` frames and HTTP)

| code | HTTP | meaning |
|------|------|---------|
| `bad_request`     | 400 | malformed frame/body/envelope |
| `validation`      | 422 | envelope failed schema (bad act, missing required meta, etc.) |
| `unauthorized`    | 401 | missing/invalid token |
| `forbidden`       | 403 | token valid but not a member of this team / not this member |
| `not_found`       | 404 | team/member not found |
| `conflict`        | 409 | duplicate (e.g. team slug taken, member name taken) |
| `member_busy`     | 409 | (v0.2, ADR 010) a Member was already live — *no longer thrown on hello since ADR 017's newest-wins; retained for compatibility* |
| `superseded`      | 409 | (v0.2, ADR 017) your session was taken over by a newer same-identity attach — terminal; don't reconnect |
| `version_mismatch`| 426 | client `v` not compatible with server |
| `server_error`    | 500 | unexpected |

The CLI maps these to exit codes (`04-cli.md`).

## `@musterd/protocol` exports (the executable contract)

```ts
export const PROTOCOL_VERSION = 'musterd/0.1';
export const ACTS = ['message','status_update','request_help','handoff','accept','decline','wait'] as const;
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
}).superRefine(actMetaRules);   // enforces accept/decline -> meta.in_reply_to, etc.

export type Envelope = z.infer<typeof Envelope>;
export const Member = z.object({ /* mirrors members table, no token_hash */ });
export const WSClientFrame = z.discriminatedUnion('type', [ Hello, Subscribe, Send, Heartbeat ]);
export const WSServerFrame = z.discriminatedUnion('type', [ Welcome, Subscribed, Ack, Deliver, PresenceEvt, ErrorFrame ]);
export const ErrorCode = z.enum(['bad_request','validation','unauthorized','forbidden','not_found','conflict','version_mismatch','server_error']);
```

`actMetaRules` is the single place encoding the per-act `meta` requirements from the table above; both server and clients import it so validation is identical everywhere. **Changing any of these schemas requires an ADR** (`00-overview.md` hard rule).
