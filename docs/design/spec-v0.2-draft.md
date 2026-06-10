# musterd protocol — SPEC v0.2 (DRAFT)

> **Status: DRAFT, not implemented.** Normative protocol draft for the seat/grant membership model in `membership-model.md`. The **live** spec is `SPEC.md` (v0.1). When accepted, this is promoted into `SPEC.md`, the version bumps to `musterd/0.2`, and ADRs record the breaking changes. Until then `SPEC.md`/code remain v0.1. See `security.md` for the credential/grant threat model.

Version under design: **`musterd/0.2`**. RFC 2119 keywords.

## 0. What changes from v0.1 (and why it's breaking)

| Area | v0.1 (live) | v0.2 (draft) |
|---|---|---|
| Identity | flat Member (name, kind) | **Seat** in a **Role** (Member = named Seat) |
| Auth unit | per-member token = one member | **agent key** (harness) **+ admin-issued Grant** (seat occupancy) |
| Join | `hello {team, as, token}` → presence | `claim {seat\|role}` → occupy, or → **request** to an admin |
| Authorization | token == member | **grant required**; default **live admin approval**; team opt-in pre-issued |
| Concurrency | N sessions = N presences of one member | **single-active** per seat; 2nd → `claim_conflict` |
| State | `presence.status` + `left_at` | **three axes**: account · availability · activity (with `working` staleness) |
| Observers | none | **human-only** read-only watchers |
| Governance | none | **own lane**: roles, seats, grants, requests, status — all **audited** |

MAJOR-of-MINOR change (new join/auth) → `musterd/0.2`, gated by ADR. Envelope + the 7 acts are **unchanged**; `v` becomes `musterd/0.2`.

## 1. Roles, Seats & Capabilities

- A **Role** is admin-defined (`backend`, `frontend`, `reviewer`, `lead`…). It groups seats (capacity = its seats) **and carries default capabilities + an optional charter**.
- A **Seat** is the identity record: `{ id, team, role, name?, kind: agent|human, account_status, occupied_by?, availability?, activity?, capabilities, charter? }`. `name` is optional for agent seats (handle `<role>-<n>` if absent), conventional for humans. A seat's `capabilities` start from its role's defaults and may be **narrowed per seat, never widened**.
- **Capabilities (v0.2 fixed set):** `can_message` (scope), `visibility_level`, `tool_allowlist`, `declared_resource_scopes`, `can_flag_urgent`, `can_observe`, `is_admin`. Servers MUST enforce them on every in-band operation; external scopes (repo/dir/tool) are **declared** here and enforced by the harness/sandbox (Principle 4). Custom RBAC is roadmap.
- **Charter** is identity metadata (what the seat is *for* + instructions); musterd stores and serves it, never enforces behavior. A **memory/context blob** is a **reserved seam** on the claim response (§3) — not built in v0.2.
- A seat has **at most one** live occupant (single-active). Humans claim their own named seat; agent seats may be claimed by name or by an open seat in a role.

## 2. Credentials

- **Agent join key** — team-scoped secret; authenticates a harness/session; rotatable; hashed. **Not** an identity and **not** sufficient to occupy a seat.
- **Grant** — admin-issued authorization to occupy a seat/role. Fields: `{ id, team, scope: seat|role, target, issued_by, lifetime: "once"|"ttl"|"standing", expires_at?, single_use?, revoked? }`. **At live approval the admin picks the lifetime** (once / N-hours TTL / until-revoke), so reconnects within the window don't re-prompt while keeping "no silent grant." Seat/role-scoped, expiring, revocable. Every issue/use/revoke is audited.
- **Human credential** — per-human-seat secret; acts as that human; observes if role permits.
- **Admin** — capability on a human seat (creator default).

Servers MUST store only hashes of keys/credentials/grants. A `banned` seat's credential MUST be rejected.

## 3. Claim handshake (WS) — replaces v0.1 `hello`

State machine: `connecting → authenticated(key) → claim → (occupied | refused | pending) → [subscribed] → live`.

```jsonc
// client → server
{ "type":"claim", "v":"musterd/0.2", "team":"dawn",
  "key":"<agent key | human credential>",
  "target": { "seat":"Ada" } | { "role":"backend" } | { "observe": true },
  "grant":"<grant token>"?,            // omitted → triggers a request (default path)
  "surface":"claude-code" }

// server → client
{ "type":"occupied", "seat": <Seat>, "presence_id":"01J…", "server_time": <ms>,
  "charter": "<role/seat charter + instructions>"?,   // identity metadata, served not enforced
  "memory": null }                                     // RESERVED SEAM — always null in v0.2
{ "type":"refused", "code":"claim_conflict"|"forbidden"|"not_found"|"disabled"|"banned"|"expired_grant",
  "message":"…", "claimable":["…"], "hint":"musterd team add <name> --kind agent --role backend" }
{ "type":"pending", "request_id":"01J…", "message":"asked admins to authorize this claim" }
```

Rules:
- Valid **grant** for the target + seat free → `occupied` (account `provisioned`→`active`).
- Valid grant + seat occupied → `refused {claim_conflict, claimable, hint}`.
- **No grant** → `pending`: the server opens a **claim request** (§5) routed to admins. On approval the server emits `occupied` (or `refused` on deny/timeout). If an admin is co-present in the same session, approval MAY be immediate.
- `observe: true` requires a **human credential** whose seat role permits observing; agents MUST be refused (`forbidden`).
- A seat MUST have at most one live occupant.

## 4. Release & grace

- On clean disconnect or `leave`, the occupancy is held for a **grace window = the presence timeout (45s)**. A re-`claim` of the same seat within the window re-occupies without a new grant or request. After it, the seat returns to `claimable` and a team `presence` offline event fires. During grace the seat shows `online` (held).

## 5. Governance lane (own surface, audited)

Governance is **not** carried by the collaboration `Envelope`/Acts. It is a distinct set of operations and a **request** object.

**Request** `{ id, team, kind: "claim"|"teammate", from_session, target?, status: pending|approved|denied|expired, decided_by?, ts }`. Created on a no-grant claim (kind `claim`) or an explicit "I need a teammate" (kind `teammate`). Routed to admins; surfaced via `GET /teams/:slug/requests` and a notification. An admin **approves** (issues a grant; for `teammate`, creates a seat then grants), **denies**, or it **expires**.

Governance operations (admin-only; §7 HTTP): create/rename/disable/ban/archive seats; create/rename roles; issue/revoke grants; rotate the agent key; set team policy (e.g. `allow_pre_issued_grants`); decide requests.

Every governance operation and every grant issue/use/revoke writes an **audit record** (`security.md`): `{ ts, actor, action, target, result }`.

## 6. State model (three axes)

**Account** (Axis 1): `provisioned → active → (disabled ⇄ active) → banned ; any → archived`. Non-active seats are not claimable.

**Availability** (Axis 2): `available | away | dnd | away_until(ts) | off_hours`. For **humans**, presence is implicit (connected → online; idle → away) while `away`/`dnd`/`away_until` are **explicitly set, never inferred**. For agents, availability is mostly `available` while occupied. Full schedule enforcement is roadmap.

**Activity** (Axis 3, only while occupied): `offline (unoccupied) | online (idle) | working | talking`.
- `working` carries `meta.state` from the seat's latest `status_update`; **self-reported, never inferred**.
- `working` **persists while occupied + alive**; after 5 min without a fresh `status_update` it is rendered **stale** (`working: x · Nm`), never reverting to `online`; it clears on release/timeout.
- Two clocks: heartbeat = alive; last `status_update` = fresh.

**Display resolution (first match wins):** archived/banned/disabled → `provisioned`(`created · waiting to join`) → away(`off until <ts>`) → unoccupied(`offline`) → occupied(`working: x · Nm` / `talking: y` / `online`).

## 6a. Notifications & urgency

Delivery is unchanged (at-least-once, cursor-based); **notification tiering** is a recipient-side policy the server supports:
- **Loud** (notify/page): acts *directed at the recipient* (`request_help`/`handoff`/`accept`/`decline` to them, @mention) + governance approval requests.
- **Quiet** (stream only): ambient `status_update`, broadcasts, others' threads.
- **Held**: while the recipient is `away`/`dnd`, messages queue → digest on return.

**Breakthrough:** `away` holds all **except** an `urgent`-flagged ping; `dnd` holds quiet but passes directed pings and `urgent`.

**`urgent`** is an envelope `meta.urgent: true` with a **required** `meta.urgent_reason`. It MUST be gated by the sender seat's **`can_flag_urgent`** capability, is **audited**, and the recipient MAY mark it `wasnt_urgent` (recorded against the sender). Servers MUST reject `urgent` from a seat lacking the capability. (Acts themselves are unchanged; `urgent` is a meta flag, not a new act.)

## 7. HTTP deltas

| Method | Path | Notes |
|---|---|---|
| `POST` | `/teams` | returns `{ team, seat(creator+admin human), human_credential, agent_key, policy }` |
| `POST` | `/teams/:slug/roles` | admin; create/rename a role; set its default `capabilities` + `charter` |
| `POST` | `/teams/:slug/seats` | admin; provision a seat (`role`, `name?`, `kind`) in `provisioned`; returns the seat (no token) |
| `POST` | `/teams/:slug/seats/:id/capabilities` | admin; per-seat capability **narrowing** (may not widen past the role) + seat `charter` |
| `POST` | `/teams/:slug/seats/:id/status` | admin; `{ to: active\|disabled\|banned\|archived }` |
| `POST` | `/teams/:slug/grants` | admin; issue a grant `{ scope, target, lifetime, expires_at?, single_use? }` → grant token |
| `DELETE` | `/teams/:slug/grants/:id` | admin; revoke |
| `POST` | `/teams/:slug/agent-key/rotate` | admin |
| `POST` | `/teams/:slug/policy` | admin; e.g. `{ allow_pre_issued_grants: bool }` |
| `GET`  | `/teams/:slug/requests` | admin; pending claim/teammate requests |
| `POST` | `/teams/:slug/requests/:id/decide` | admin; `{ approve: bool, grant?, create_seat? }` |
| `POST` | `/teams/:slug/claim` | stateless claim mirror of WS `claim` |
| `GET`  | `/teams/:slug/members` | roster **projected by viewer**: seats with role, account/availability/activity + `watching` list; non-admins never see credentials/grants/audit/policy/other charters |
| `POST` | `/teams/:slug/availability` | set the caller's seat availability (`available\|away\|dnd\|away_until`) |
| `GET`  | `/teams/:slug/audit` | admin; audit records |

Sending an Envelope still requires the sender to **hold the occupancy** of `from` (replaces token==member). `v` → `musterd/0.2`. All read endpoints return a **viewer-scoped projection** per the recipient's `visibility_level`.

## 8. Error / refusal codes

Add `claim_conflict` (seat occupied; 409), `expired_grant` (410/403). Reuse `forbidden` (bad key / not allowed to observe / not admin), `not_found` (no such seat/role), and surface account states via `refused.code` (`disabled`/`banned`). `version_mismatch` covers a v0.1 client hitting a v0.2 server.

## 9. Migration

- `members` → `seats` (+ `role`, `account_status`; drop `token_hash`). Add `roles`, `grants`, `requests`, `audit`, and team `policy`/`agent_key_hash`, per-human `credential_hash`.
- Schema v2 migration; since musterd is pre-1.0 and local, a one-shot reset of existing local DBs is acceptable (documented), or a best-effort migration that mints an agent key, creates one role per distinct `members.role`, turns members into `active` seats, and marks the creator admin.
- Surface changes: `team add` provisions a seat (no token); MCP env `MUSTERD_TOKEN` → `MUSTERD_AGENT_KEY` + `MUSTERD_CLAIM` (+ optional pre-issued `MUSTERD_GRANT`); `init` and CLI `join` move to the claim/request flow.
