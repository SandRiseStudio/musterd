# musterd protocol — SPEC

**Version:** `musterd/0.3` (draft)
**Status:** v0.3 draft — designed in the open, versioned from the first commit. v0.3 adds the terminal **`resolve` act** (thread-close — the open-vs-done axis, ADR 025) over v0.2; it is a backward-compatible MINOR (one new act, no change to existing fields). v0.2 added the **minimal trust model** (single-active Members + reclaim grace) and **roster activity** over v0.1. The full shared-teams governance model is otherwise **designed but not yet specified** — it activates when the daemon stops being localhost-only. Its wire-level design lives in **Appendix A (Unreleased)** below; the rationale is in `docs/design/membership-model.md` + `docs/design/security.md`.
**License:** MIT (same as the implementation).

> This is the normative protocol. Implementations (this repo's `@musterd/server`, `@musterd/protocol`, and any third-party server or client) MUST conform to it. The implementation-facing distillation with file/function detail is `docs/architecture/02-protocol.md`; where that and this file disagree, **this file wins**. Changes to this spec are versioned and require an ADR (`docs/decisions/`).

The keywords MUST, SHOULD, MAY are used per RFC 2119.

---

## 1. Model

musterd coordinates **Teams** of **Members** with shared messaging.

- A **Team** is a named, persistent group — a **standing roster**, not a project. It outlives any task, session, or repository.
- A **Member** is a durable identity within exactly one Team. `kind` is `agent` or `human` — **humans are first-class Members, not approvers**. A Member has a name (unique within its Team), a free-text role, a **lifecycle** (`forever | session | until <ts>`), and an optional **availability** schedule (stored, not enforced).
- A **Presence** is where a Member is currently attached — a **Surface** such as `cli`, `claude-code`, or `codex`. One Member MAY have multiple simultaneous Presences (like a person on desktop + phone). **A Member is not a session.**
- The server routes each message to wherever the recipient is present; an offline recipient's messages remain in the durable log and surface via their **Inbox** (cursor-based).

These five terms — Team, Member, Presence, Surface, Act — are the glossary; conforming implementations MUST use them with these meanings in any user-facing surface.

## 2. Envelope

Every message is an Envelope (JSON):

```jsonc
{
  "id": "<ULID>", // client-generated, globally unique
  "v": "musterd/0.3", // protocol version; MUST match server's supported version
  "team": "<team-slug>", // [a-z0-9-], 1..32
  "from": "<member-name>", // sender, a Member in `team`
  "to": { "kind": "member", "name": "<member-name>" }, // or {"kind":"team"} or {"kind":"broadcast"}
  "act": "<act>", // one of the 8 acts (§3)
  "body": "<string>", // human/agent-readable content; MAY be empty
  "thread": "<ULID|null>", // optional thread root id; null/absent starts a thread
  "meta": {}, // optional, act-specific (§3); unknown keys MUST be preserved
  "ts": 1733760000000, // sender clock, epoch ms; server records its own receive time too
}
```

Recipient (`to`) is one of:

- `{"kind":"member","name":"<name>"}` — delivered to that Member.
- `{"kind":"team"}` — delivered to every current Member of the Team except the sender.
- `{"kind":"broadcast"}` — in v0.1, delivered as `team`. The distinct kind is RESERVED for future cross-Team/announce semantics; implementations MUST keep it distinct on the wire even while delivering it as team.

Validation: an Envelope with an unknown `act` MUST be rejected. Unknown `meta` keys MUST be accepted and preserved (forward-compatibility). A server MUST reject an Envelope whose `from`/`team` do not match the authenticated Member.

## 3. Collaboration acts

Acts are the typed intents of coordination, grounded in the **Co-Gym** collaboration-act taxonomy (Shao et al., _Collaborative Gym_, arXiv 2412.15701). v0.1 defined seven; **v0.3 adds `resolve`** (ADR 025) for eight:

| Act             | Meaning                                           | Required `meta`/fields    | Optional `meta`                         |
| --------------- | ------------------------------------------------- | ------------------------- | --------------------------------------- |
| `message`       | plain communication, no protocol semantics        | —                         | —                                       |
| `status_update` | report what you are doing / have done             | —                         | `progress` (0..1), `state` (string)     |
| `request_help`  | ask a Member or the Team to assist / unblock you  | —                         | `blocking` (bool), `topic` (string)     |
| `handoff`       | transfer a unit of work to someone                | —                         | `artifact` (string), `summary` (string) |
| `accept`        | accept a prior `request_help`/`handoff`           | `meta.in_reply_to` (ULID) | —                                       |
| `decline`       | decline a prior `request_help`/`handoff`          | `meta.in_reply_to` (ULID) | `reason` (string)                       |
| `wait`          | signal you are paused / blocked                   | —                         | `until` (epoch ms), `reason` (string)   |
| `resolve`       | close a thread — mark the work it tracks **done** | `thread` (ULID)           | `reason` (string)                       |

Rules:

- `accept` and `decline` MUST carry `meta.in_reply_to` referencing the Envelope they answer, and SHOULD set `thread` to that Envelope's thread (or its `id` if it was a root).
- `resolve` is **thread-terminal**: it MUST carry a non-empty `thread` naming the thread it closes (a no-thread root is closed by passing its own `id`). It marks the thread — the proto-work-item — **done**, supplying the open-vs-done axis the other acts lack (`accept` ≠ finished). It MAY follow an `accept` or close a thread directly without one. **Authority:** any Member of the Team MAY `resolve` a thread; v0.3 does not enforce a closer (the norm is the opener or the assignee). Conforming UIs SHOULD treat a thread carrying a `resolve` as closed and stop surfacing its open `request_help`/directed asks as pending.
- Acts are the stable contract; `meta` is the extension point. New acts are a versioned change to this spec.

## 4. Identity, Presence, Lifecycle

- **Authentication:** each Member has a secret token, issued once when the Member is added. A request/connection presents the token; the server authorizes it to act **as that Member in that Team** and no other. Servers MUST store only a hash of the token, never the plaintext.
- **Presence lifecycle:** a client attaches a Presence by connecting (declaring its Surface), keeps it alive with heartbeats, and detaches on disconnect. A Member is **online** while it has a fresh Presence, **offline** otherwise; **away** is set only explicitly by a client and MUST NOT be inferred by the server. Heartbeat cadence and timeout are implementation parameters (this repo: 15s heartbeat, 45s timeout).
- **Single-active is kind-scoped (v0.2 + ADR 042; ADR 017 supersedes ADR 010's refusal):** **agent** Members are single-active, newest-wins — an agent MAY hold at most **one** live Presence at a time, and on a new attach for an agent that already has a live Presence the server MUST keep only the **newest** session: it takes over, and the existing one is told it was **`superseded`** (this repo: WS `error`) and dropped. (This replaces the earlier "refuse the second with `member_busy`" rule — refusing locked a Member out of its _own_ seat after a reload/orphaned session.) **Human** Members instead **fan out**: a human MAY hold multiple simultaneous Presences (watch on a phone while acting on a laptop), so a new human attach adds a Presence alongside the existing ones — no displacement. Agent displacement is **workspace-scoped** (ADR 068): a same-workspace attach does not immediately supersede the incumbent (a transient health-check probe must not flap the seat); instead a same-workspace successor that proves durable (survives a short grace window still attached) reaps its predecessor, which is told `superseded` with `same_workspace:true` and — being a replaced reload orphan — SHOULD exit rather than linger dormant (ADR 092). Either way, on a clean detach the server SHOULD hold a seat for a short **reclaim grace** (this repo: 45s, tracked as `held_until`) so the same Member can rejoin without losing it; the grace is swept per-Presence by the reaper, and a Member goes offline only when its **last** Presence drops. _(Rationale: single-active exists to stop N concurrent autonomous minds wearing one agent identity — an agent hazard, not a human one; a person across devices is the original "one Member, many Presences" — §1, ADR 042. The v0.3 seat-claim model governs who may take a seat once the daemon leaves localhost; ADR 007/010/017/042.)_
- **Roster activity (v0.2):** a roster/status response carries, per Member, a coarse `activity` of `offline | online | working`, derived server-side by a **two-clocks rule** — liveness (presence) decides `offline` vs present, and the latest `status_update` decides `online` (idle) vs `working` (a self-reported task). The backing task summary rides in `state` with a `last_status_at` timestamp (for staleness display). These fields are **optional/additive** — a v0.1 client that ignores them still conforms.
- **Attach context — provenance & workspace (v0.2, ADR 014):** on attach a client MAY declare two facts about _why_ and _where_ the Presence exists: a `provenance` of `session | asked | hook | scheduled | daemon` (why this attachment exists — e.g. `session` means a human opened a harness session, `scheduled` means a timer started it), and a `workspace` string (a "where" label, e.g. `repo@branch`). The server records both on the Presence and surfaces them on the roster; it MUST NOT guess them (they are facts known only to the attaching client). Both are **optional/additive** and carry no routing or authorization meaning — they are read context, rendered as such. _(Rationale: presence answers "is anyone there"; provenance answers "why are they there" — don't make one layer carry another's question. See `docs/design/human-agent-dynamics.md` §2.)_
- **Driver co-presence (v0.2, ADR 021):** on attach a client MAY also declare a `driver` string (≤80 chars) — the name of the human steering this session, when one is — so the roster can render `driven by <name>` instead of showing the driving human as offline. Like provenance/workspace it is a fact known only to the attaching client (the server MUST NOT guess it), is **optional/additive**, and carries no routing or authorization meaning — it names a co-present human but does not link to, authenticate, or stand in for that human's Member. _(An adapter authenticates only as the agent; it never holds the human's token. See `docs/design/human-agent-dynamics.md` §54.)_
- **Member lifecycle:** `forever` (default), `session` (intended to last one working session), or `until <ts>`. The server stores lifecycle and availability but does NOT enforce schedules or auto-expiry at runtime (enforcement is on the roadmap). Schema/field support exists from day one so enforcement can be added without a breaking change.

## 5. Transport

A conforming server MUST expose the message-routing semantics of §2–§4. This repo's server offers two bindings (full detail in `docs/architecture/02-protocol.md`):

- **WebSocket** for live, present clients: handshake `hello → welcome → subscribe → subscribed`, then `send`/`deliver`/`heartbeat`/`presence`/`ack`/`error` frames.
- **HTTP/JSON** for stateless one-shot clients (team/member management, send, inbox fetch, presence ping).

Both bindings MUST funnel sends through one validate→persist→route path so semantics are identical.

**Delivery guarantee:** at-least-once. The message log is authoritative; each Member has a cursor (high-water mark). A client MAY receive a message both live and again on inbox fetch after reconnect; clients MUST dedupe by `Envelope.id`.

## 6. Versioning & compatibility

- The version string is `musterd/MAJOR.MINOR`. `v0.1` was the first; `v0.2` added single-active newest-wins + reclaim grace, roster activity, attach provenance/workspace, driver co-presence (new error codes `member_busy`/`superseded`); **`v0.3`** is current — it adds the terminal `resolve` act (ADR 025) and un-stubs the reserved `memory` seam on the `occupied` frame into a seat-scoped continuity envelope (A.3, ADR 093). All MINOR additions are additive (a new act and new optional fields, no change to existing required fields): a client that ignores `memory` is unaffected.
- Within a MAJOR, MINOR additions MUST be backward-compatible (new optional `meta`, new optional fields, new endpoints, new error codes). New **acts** or any change to envelope-required fields are a MINOR-or-greater, spec-versioned change requiring an ADR.
- A server MUST reject a client whose declared `v` it does not support, with a `version_mismatch` error.

## 7. Roadmap (informative, not part of v0.1 conformance)

These are designed-around but **not** specified/required in v0.1; see `ROADMAP.md`:

- **Step-level streaming** transport option (StreamMA finding: step-level streaming beats wait-for-complete) as a v2 transport mode; v0.1 sends whole Envelopes.
- **Schedule enforcement** of `availability` and `lifecycle`.
- **Team-to-team federation** (the reserved `broadcast` kind anticipates this).
- **Additional Surfaces** (iOS, web, Slack).
- **Sandboxed runtime** for member execution.

Schema and wire formats in v0.1 already reserve the fields these need, so adding them does not break v0.1 clients.

---

### References

- Co-Gym (collaboration acts): _Collaborative Gym: A Framework for Enabling and Evaluating Human-Agent Collaboration_, arXiv 2412.15701.
- MAST (coordination-failure analysis motivating the layer): _Why Do Multi-Agent LLM Systems Fail?_, arXiv 2503.13657.

---

# Appendix A — v0.3 shared-teams governance (SHIPPED — the live auth model)

> **Status: SHIPPED.** v0.3 P0–P3 landed on `main` (2026-06-30) — the hard auth cutover (ADR 069 build plan; ADRs 075–078; banned-inert read-gate follow-up PR #37). This **shared-teams** governance model — seats, agent key + grants, capabilities, approval lane, audit — **is now the live identity/auth model**: the per-member-token path (§4) and the `hello` frame are **removed**, replaced by the `claim` handshake + team **agent key** + admin-issued **grants** + human **credentials** described below. The collaboration **Envelope/Acts (§2–§3) are unchanged** — governance layered on without touching them. Rationale + design review: `docs/design/membership-model.md`, `docs/design/security.md`; the _two universes_ capability split (what musterd enforces vs. provisions/declares for the harness) is ADR 026.
>
> _Spec-hygiene follow-up (tracked, not yet done): fold this appendix into the normative body (§1 identity, §4 auth) and retire the now-superseded `hello`/per-member-token prose in §1–§6, which describes the **pre-cutover (v0.2)** model. Until then: read §1–§6's join/auth text as **historical**, and this appendix as **current**._

## A.0 What the cutover changed (v0.2 → v0.3, shipped in P3)

| Area          | v0.2 (former, §1–§6)                   | v0.3 (shipped)                                                                               |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Identity      | flat Member (name, kind)               | **Seat** in a **Role** (Member = named Seat)                                                 |
| Auth unit     | per-member token = one member          | **agent key** (harness) **+ admin-issued Grant** (seat occupancy)                            |
| Join          | `hello {team, as, token}` → presence   | `claim {seat\|role}` → occupy, or → **request** to an admin                                  |
| Authorization | token == member                        | **grant required**; default **live admin approval**; team opt-in pre-issued                  |
| Concurrency   | N sessions = N presences of one member | **single-active** per _agent_ seat (2nd → `claim_conflict`); _human_ seats fan out (ADR 042) |
| State         | `presence.status` + `left_at`          | **three axes**: account · availability · activity (with `working` staleness)                 |
| Observers     | none                                   | **human-only** read-only watchers                                                            |
| Governance    | none                                   | **own lane**: roles, seats, grants, requests, status — all **audited**                       |

A new join/auth handshake is a MAJOR-of-MINOR change; it **landed as the isolated P3 cutover** (ADR 069 decision 2, 2026-06-30) — one coordinated breaking moment across every surface, with the acts (§2–§3) untouched. (Note: `musterd/0.3` also shipped the `resolve` act, ADR 025.)

## A.1 Roles, Seats & Capabilities

- A **Role** is admin-defined (`backend`, `frontend`, `reviewer`, `lead`…). It groups seats (capacity = its seats) **and carries default capabilities + an optional charter**.
- A **Seat** is the identity record: `{ id, team, role, name?, kind: agent|human, account_status, occupied_by?, availability?, activity?, capabilities, charter? }`. `name` is optional for agent seats (handle `<role>-<n>` if absent), conventional for humans. A seat's `capabilities` start from its role's defaults and may be **narrowed per seat, never widened**.
- **Capabilities (fixed set):** `can_message` (scope), `visibility_level`, `tool_allowlist`, `declared_resource_scopes`, `can_flag_urgent`, `can_observe`, `is_admin`. Servers MUST enforce them on every in-band operation; external scopes (repo/dir/tool) are **declared** here and enforced by the harness/sandbox (Principle 4). ADR 026 frames this as the **two universes** — in-band acts musterd enforces vs harness tools it _provisions + declares_ — and makes the Role a harness-agnostic provisioning template. Custom RBAC is roadmap.
- **Charter** is identity metadata (what the seat is _for_ + instructions); musterd stores and serves it, never enforces behavior. A **memory/context blob** rides the claim response (A.3) as a seat-scoped continuity envelope (ADR 093): `memory` carries `{ headline, saved_at, size_bytes }` or `null`, with the body fetched on demand — an additive MINOR that un-stubs the seam once reserved here.
- An **agent** seat has **at most one** live occupant (single-active); a **human** seat may have multiple concurrent occupant Presences (kind-scoped, ADR 042). Humans claim their own named seat; agent seats may be claimed by name or by an open seat in a role.

## A.2 Credentials

- **Agent join key** — team-scoped secret; authenticates a harness/session; rotatable; hashed. **Not** an identity and **not** sufficient to occupy a seat.
- **Grant** — admin-issued authorization to occupy a seat/role. Fields: `{ id, team, scope: seat|role, target, issued_by, lifetime: "once"|"ttl"|"standing", expires_at?, single_use?, revoked? }`. **At live approval the admin picks the lifetime** (once / N-hours TTL / until-revoke), so reconnects within the window don't re-prompt while keeping "no silent grant." Seat/role-scoped, expiring, revocable. Every issue/use/revoke is audited.
- **Human credential** — per-human-seat secret; acts as that human; observes if role permits.
- **Admin** — capability on a human seat (creator default).

Servers MUST store only hashes of keys/credentials/grants. A `banned` seat's credential MUST be rejected.

## A.3 Claim handshake (WS) — replaced the `hello` frame (removed in P3)

> **Note (local claim-on-first-use is already shipped _without_ this frame — ADRs 032/033).** The
> _local_ claim experience from `provisioning-recipe.md` §5–§6 — the overloaded `team_join`,
> `musterd claim`, the `MUSTERD_CLAIM` folder policy, and client-side pending presence — is built on
> the **existing** `hello`/members primitives, not this handshake: locally a seat is a member + its
> per-member token, auto-mint is the unauthenticated `POST /members`, occupy is `hello` (newest-wins
>
> - grace, §74), and `claim_conflict` is the unique-name `conflict` on mint. This appendix's
>   `claim`/grant frame is the **governed** path (agent key + admin grant + the request
>   lane); it **shipped in P3 (2026-06-30) and is now the sole claim path** — the local `hello`-based
>   occupy this note contrasts against is removed. (Server-side pending presence — a seatless session on
>   the roster — is the request lane's live-approval state, A.5.)

State machine: `connecting → authenticated(key) → claim → (occupied | refused | pending) → [subscribed] → live`.

```jsonc
// client → server
{ "type":"claim", "v":"musterd/0.x", "team":"dawn",
  "key":"<agent key | human credential>",
  "target": { "seat":"Ada" } | { "role":"backend" } | { "observe": true },
  "grant":"<grant token>"?,            // omitted → triggers a request (default path)
  "surface":"claude-code" }

// server → client
{ "type":"occupied", "seat": <Seat>, "presence_id":"01J…", "server_time": <ms>,
  "charter": "<role/seat charter + instructions>"?,   // identity metadata, served not enforced
  "memory": { "headline":"<≤120 chars>", "saved_at": <ms>, "size_bytes": <int> } | null }
                                                       // seat-scoped continuity envelope (ADR 093);
                                                       // null when nothing saved. The body is NEVER
                                                       // here — fetch via GET /teams/:slug/memory.
{ "type":"refused", "code":"claim_conflict"|"forbidden"|"not_found"|"disabled"|"banned"|"expired_grant",
  "message":"…", "claimable":["…"], "hint":"musterd team add <name> --kind agent --role backend" }
{ "type":"pending", "request_id":"01J…", "message":"asked admins to authorize this claim" }
```

Rules:

- Valid **grant** for the target + seat free → `occupied` (account `provisioned`→`active`).
- Valid grant + seat occupied → `refused {claim_conflict, claimable, hint}`.
- **No grant** → `pending`: the server opens a **claim request** (A.5) routed to admins. On approval the server emits `occupied` (or `refused` on deny/timeout). If an admin is co-present in the same session, approval MAY be immediate.
- `observe: true` requires a **human credential** whose seat role permits observing; agents MUST be refused (`forbidden`).
- An **agent** seat MUST have at most one live occupant; a **human** seat MAY have multiple concurrent occupant Presences (kind-scoped single-active, ADR 042).
- **`memory`** carries the seat's continuity envelope (ADR 093) — `{ headline (≤120 chars), saved_at, size_bytes }` — or `null` when the seat has saved nothing. It is the seat-scoped working note an occupant saved before wrapping up; the body is fetched **on demand** over `GET /teams/:slug/memory` (seat-authenticated), never delivered on this frame. Additive and back-compat: a client that ignores `memory` loses nothing.

## A.4 Release & grace

- On clean disconnect or `leave`, the occupancy is held for a **grace window = the presence timeout (45s)**. A re-`claim` of the same seat within the window re-occupies without a new grant or request. After it, the seat returns to `claimable` and a team `presence` offline event fires. During grace the seat shows `online` (held).

## A.5 Governance lane (own surface, audited)

Governance is **not** carried by the collaboration `Envelope`/Acts. It is a distinct set of operations and a **request** object.

**Request** `{ id, team, kind: "claim"|"teammate", from_session, target?, status: pending|approved|denied|expired, decided_by?, ts }`. Created on a no-grant claim (kind `claim`) or an explicit "I need a teammate" (kind `teammate`). Routed to admins; surfaced via `GET /teams/:slug/requests` and a notification. An admin **approves** (issues a grant; for `teammate`, creates a seat then grants), **denies**, or it **expires**.

Governance operations (admin-only; A.7 HTTP): create/rename/disable/ban/archive seats; create/rename roles; issue/revoke grants; rotate the agent key; set team policy (e.g. `allow_pre_issued_grants`); decide requests.

Every governance operation and every grant issue/use/revoke writes an **audit record** (`security.md`): `{ ts, actor, action, target, result }`.

## A.6 State model (three axes)

**Account** (Axis 1): `provisioned → active → (disabled ⇄ active) → banned ; any → archived`. Non-active seats are not claimable.

**Availability** (Axis 2): `available | away | dnd | away_until(ts) | off_hours`. For **humans**, presence is implicit (connected → online; idle → away) while `away`/`dnd`/`away_until` are **explicitly set, never inferred**. For agents, availability is mostly `available` while occupied. Full schedule enforcement is roadmap.

**Activity** (Axis 3, only while occupied): `offline (unoccupied) | online (idle) | working | talking`.

- `working` carries `meta.state` from the seat's latest `status_update`; **self-reported, never inferred**.
- `working` **persists while occupied + alive**; after 5 min without a fresh `status_update` it is rendered **stale** (`working: x · Nm`), never reverting to `online`; it clears on release/timeout.
- Two clocks: heartbeat = alive; last `status_update` = fresh.

**Display resolution (first match wins):** archived/banned/disabled → `provisioned`(`created · waiting to join`) → away(`off until <ts>`) → unoccupied(`offline`) → occupied(`working: x · Nm` / `talking: y` / `online`).

## A.6a Notifications & urgency

Delivery is unchanged (at-least-once, cursor-based); **notification tiering** is a recipient-side policy the server supports:

- **Loud** (notify/page): acts _directed at the recipient_ (`request_help`/`handoff`/`accept`/`decline` to them, @mention) + governance approval requests.
- **Quiet** (stream only): ambient `status_update`, broadcasts, others' threads.
- **Held**: while the recipient is `away`/`dnd`, messages queue → digest on return.

**Breakthrough:** `away` holds all **except** an `urgent`-flagged ping; `dnd` holds quiet but passes directed pings and `urgent`.

**`urgent`** is an envelope `meta.urgent: true` with a **required** `meta.urgent_reason`. It MUST be gated by the sender seat's **`can_flag_urgent`** capability, is **audited**, and the recipient MAY mark it `wasnt_urgent` (recorded against the sender). Servers MUST reject `urgent` from a seat lacking the capability. (Acts themselves are unchanged; `urgent` is a meta flag, not a new act.)

> **Localhost down-payment (ADR 044).** v0.2 ships the _mechanism_ of this section without the governance, mirroring ADR 035's notify down-payment. **Shipped:** the availability axis is self-set + stored + on the roster (`POST /teams/:slug/availability`, reusing `members.availability` — no migration); `meta.urgent`+`meta.urgent_reason` is enforced by `actMetaRules` (additive optional meta → **no protocol-version bump**); and the Loud/Quiet/Held tiers + away/dnd breakthrough run **client-side** in `musterd notify`. **Deferred to the v0.3 governed superset (the named seams):** `can_flag_urgent` enforcement (urgent is **ungated** on localhost), `urgent` auditing, the recipient `wasnt_urgent` feedback, `off_hours` + schedule enforcement, and the A.7 admin endpoints / A.9 seats migration.

## A.7 HTTP deltas

| Method   | Path                                  | Notes                                                                                                                                                                 |
| -------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/teams`                              | returns `{ team, seat(creator+admin human), human_credential, agent_key, policy }`                                                                                    |
| `POST`   | `/teams/:slug/roles`                  | admin; create/rename a role; set its default `capabilities` + `charter`                                                                                               |
| `POST`   | `/teams/:slug/seats`                  | admin; provision a seat (`role`, `name?`, `kind`) in `provisioned`; returns the seat (no token)                                                                       |
| `POST`   | `/teams/:slug/seats/:id/capabilities` | admin; per-seat capability **narrowing** (may not widen past the role) + seat `charter`                                                                               |
| `POST`   | `/teams/:slug/seats/:id/status`       | admin; `{ to: active\|disabled\|banned\|archived }`                                                                                                                   |
| `POST`   | `/teams/:slug/grants`                 | admin; issue a grant `{ scope, target, lifetime, expires_at?, single_use? }` → grant token                                                                            |
| `DELETE` | `/teams/:slug/grants/:id`             | admin; revoke                                                                                                                                                         |
| `POST`   | `/teams/:slug/agent-key/rotate`       | admin                                                                                                                                                                 |
| `POST`   | `/teams/:slug/policy`                 | admin; e.g. `{ allow_pre_issued_grants: bool }`                                                                                                                       |
| `GET`    | `/teams/:slug/requests`               | admin; pending claim/teammate requests                                                                                                                                |
| `POST`   | `/teams/:slug/requests/:id/decide`    | admin; `{ decision:'approve', lifetime:'once'\|'ttl'\|'standing', ttl_hours? }` \| `{ decision:'deny' }` — approve issues a grant of the admin-chosen lifetime        |
| `POST`   | `/teams/:slug/claim`                  | stateless claim mirror of WS `claim`                                                                                                                                  |
| `GET`    | `/teams/:slug/members`                | roster **projected by viewer**: seats with role, account/availability/activity + `watching` list; non-admins never see credentials/grants/audit/policy/other charters |
| `POST`   | `/teams/:slug/availability`           | set the caller's seat availability (`available\|away\|dnd\|away_until`)                                                                                               |
| `GET`    | `/teams/:slug/audit`                  | admin; audit records                                                                                                                                                  |

Sending an Envelope still requires the sender to **hold the occupancy** of `from` (replaces token==member). All read endpoints return a **viewer-scoped projection** per the recipient's `visibility_level`.

## A.8 Error / refusal codes

Add `claim_conflict` (seat occupied; 409), `expired_grant` (410/403). Reuse `forbidden` (bad key / not allowed to observe / not admin), `not_found` (no such seat/role), and surface account states via `refused.code` (`disabled`/`banned`). `version_mismatch` covers an older client hitting this server.

## A.9 Migration

- `members` → `seats` (+ `role`, `account_status`; drop `token_hash`). Add `roles`, `grants`, `requests`, `audit`, and team `policy`/`agent_key_hash`, per-human `credential_hash`.
- Schema migration; since musterd is pre-1.0 and local, a one-shot reset of existing local DBs is acceptable (documented), or a best-effort migration that mints an agent key, creates one role per distinct `members.role`, turns members into `active` seats, and marks the creator admin.
- Surface changes: `team add` provisions a seat (no token); MCP env `MUSTERD_TOKEN` → `MUSTERD_AGENT_KEY` (+ optional pre-issued `MUSTERD_GRANT`) — the seat is resolved from `.musterd/binding.json` (`claim`), not baked into the env (`MUSTERD_CLAIM` survives only as a manual override for binding-less/CI folders, PR #58); `init` and CLI `join` move to the claim/request flow.
