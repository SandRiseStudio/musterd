# musterd protocol — SPEC

**Version:** `musterd/0.2` (draft)
**Status:** v0.2 draft — designed in the open, versioned from the first commit. v0.2 adds the **minimal trust model** (single-active Members + reclaim grace) and **roster activity** over v0.1; it is a backward-compatible MINOR (new optional fields + one new error). The full shared-teams governance model is designed for v0.3 (`docs/design/membership-model.md`, `spec-v0.3-draft.md`, `security.md`) and deliberately not yet specified here.
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
  "id":   "<ULID>",            // client-generated, globally unique
  "v":    "musterd/0.2",       // protocol version; MUST match server's supported version
  "team": "<team-slug>",       // [a-z0-9-], 1..32
  "from": "<member-name>",     // sender, a Member in `team`
  "to":   { "kind": "member", "name": "<member-name>" },  // or {"kind":"team"} or {"kind":"broadcast"}
  "act":  "<act>",             // one of the 7 acts (§3)
  "body": "<string>",          // human/agent-readable content; MAY be empty
  "thread": "<ULID|null>",     // optional thread root id; null/absent starts a thread
  "meta": { },                 // optional, act-specific (§3); unknown keys MUST be preserved
  "ts":   1733760000000        // sender clock, epoch ms; server records its own receive time too
}
```

Recipient (`to`) is one of:
- `{"kind":"member","name":"<name>"}` — delivered to that Member.
- `{"kind":"team"}` — delivered to every current Member of the Team except the sender.
- `{"kind":"broadcast"}` — in v0.1, delivered as `team`. The distinct kind is RESERVED for future cross-Team/announce semantics; implementations MUST keep it distinct on the wire even while delivering it as team.

Validation: an Envelope with an unknown `act` MUST be rejected. Unknown `meta` keys MUST be accepted and preserved (forward-compatibility). A server MUST reject an Envelope whose `from`/`team` do not match the authenticated Member.

## 3. Collaboration acts

Acts are the typed intents of coordination, grounded in the **Co-Gym** collaboration-act taxonomy (Shao et al., *Collaborative Gym*, arXiv 2412.15701). v0.1 defines seven:

| Act             | Meaning | Required `meta` | Optional `meta` |
|-----------------|---------|-----------------|-----------------|
| `message`       | plain communication, no protocol semantics | — | — |
| `status_update` | report what you are doing / have done | — | `progress` (0..1), `state` (string) |
| `request_help`  | ask a Member or the Team to assist / unblock you | — | `blocking` (bool), `topic` (string) |
| `handoff`       | transfer a unit of work to someone | — | `artifact` (string), `summary` (string) |
| `accept`        | accept a prior `request_help`/`handoff` | `in_reply_to` (ULID) | — |
| `decline`       | decline a prior `request_help`/`handoff` | `in_reply_to` (ULID) | `reason` (string) |
| `wait`          | signal you are paused / blocked | — | `until` (epoch ms), `reason` (string) |

Rules:
- `accept` and `decline` MUST carry `meta.in_reply_to` referencing the Envelope they answer, and SHOULD set `thread` to that Envelope's thread (or its `id` if it was a root).
- Acts are the stable contract; `meta` is the extension point. New acts are a versioned change to this spec.

## 4. Identity, Presence, Lifecycle

- **Authentication:** each Member has a secret token, issued once when the Member is added. A request/connection presents the token; the server authorizes it to act **as that Member in that Team** and no other. Servers MUST store only a hash of the token, never the plaintext.
- **Presence lifecycle:** a client attaches a Presence by connecting (declaring its Surface), keeps it alive with heartbeats, and detaches on disconnect. A Member is **online** while it has a fresh Presence, **offline** otherwise; **away** is set only explicitly by a client and MUST NOT be inferred by the server. Heartbeat cadence and timeout are implementation parameters (this repo: 15s heartbeat, 45s timeout).
- **Single-active (v0.2):** a Member MAY hold at most **one** live Presence at a time. A server MUST refuse a second concurrent attach for the same Member with a `member_busy` error (this repo: HTTP 409 / WS `error`). On detach, the server SHOULD hold the seat for a short **reclaim grace** (this repo: 45s, tracked as `held_until`) so the same Member can rejoin without losing it; the grace is swept by the reaper. *(Rationale: a Member is an identity, not a session — one identity should not be worn by N sessions at once. The v0.3 seat-claim model generalizes this; ADR 007/010.)*
- **Roster activity (v0.2):** a roster/status response carries, per Member, a coarse `activity` of `offline | online | working`, derived server-side by a **two-clocks rule** — liveness (presence) decides `offline` vs present, and the latest `status_update` decides `online` (idle) vs `working` (a self-reported task). The backing task summary rides in `state` with a `last_status_at` timestamp (for staleness display). These fields are **optional/additive** — a v0.1 client that ignores them still conforms.
- **Member lifecycle:** `forever` (default), `session` (intended to last one working session), or `until <ts>`. The server stores lifecycle and availability but does NOT enforce schedules or auto-expiry at runtime (enforcement is on the roadmap). Schema/field support exists from day one so enforcement can be added without a breaking change.

## 5. Transport

A conforming server MUST expose the message-routing semantics of §2–§4. This repo's server offers two bindings (full detail in `docs/architecture/02-protocol.md`):

- **WebSocket** for live, present clients: handshake `hello → welcome → subscribe → subscribed`, then `send`/`deliver`/`heartbeat`/`presence`/`ack`/`error` frames.
- **HTTP/JSON** for stateless one-shot clients (team/member management, send, inbox fetch, presence ping).

Both bindings MUST funnel sends through one validate→persist→route path so semantics are identical.

**Delivery guarantee:** at-least-once. The message log is authoritative; each Member has a cursor (high-water mark). A client MAY receive a message both live and again on inbox fetch after reconnect; clients MUST dedupe by `Envelope.id`.

## 6. Versioning & compatibility

- The version string is `musterd/MAJOR.MINOR`. `v0.1` was the first; **`v0.2`** is current (single-active + reclaim grace, roster activity — all additive).
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

- Co-Gym (collaboration acts): *Collaborative Gym: A Framework for Enabling and Evaluating Human-Agent Collaboration*, arXiv 2412.15701.
- MAST (coordination-failure analysis motivating the layer): *Why Do Multi-Agent LLM Systems Fail?*, arXiv 2503.13657.
