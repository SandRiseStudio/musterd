# musterd protocol — SPEC v0.2 (DRAFT)

> **Status: DRAFT, not implemented.** This is the normative protocol draft for the membership/identity model in `membership-model.md`. The **live** spec is `SPEC.md` (v0.1). When v0.2 is accepted and implemented, this is promoted into `SPEC.md`, the version bumps to `musterd/0.2`, and ADRs record the breaking changes. Until then `SPEC.md`/code remain v0.1.

Version under design: **`musterd/0.2`**. RFC 2119 keywords.

## 0. What changes from v0.1 (and why it's breaking)

| Area | v0.1 (live) | v0.2 (draft) |
|---|---|---|
| Auth unit | per-member token (`mskd_…`) = one member | **team credentials** (agent key + human credential); identity chosen by **claim** |
| Join | `hello {team, as, token}` → presence as that member | `join {team, key, claim}` → **claim** a named member or **observe** |
| Concurrency | N sessions = N presences of one member; fan-out | **single-active**: one live claim per member; 2nd is **refused** |
| Member state | `presence.status` (online/away/offline) + `left_at` | **three axes**: account status · availability · activity |
| Observers | none | **human-only** read-only watchers |
| Activation | implicit auto-join on session start | **explicit claim**; opt-in auto-claim |

This is a MAJOR-of-MINOR change (new required join shape, new auth) → `musterd/0.2`, gated by ADR.

## 1. Credentials

- **Agent join key** — team-scoped secret. Authorizes a session to **claim an agent member** on that team. Stored hashed server-side; carried in a harness config. Not an identity.
- **Human credential** — a human member's secret. Authorizes acting as that human member and, if the member's role permits, **observing**.
- **Admin** — a capability on a human member (the creator by default). Authorizes governance: create/disable/ban/archive members, mint/rotate the agent key, grant observer-permitting roles.

Servers MUST store only hashes of credentials. A `banned` member's human credential MUST be rejected.

## 2. Join & claim handshake (WS)

Replaces v0.1 `hello`. State machine: `connecting → join → (granted|refused) → [subscribed] → live`.

```jsonc
// client → server
{ "type":"join", "v":"musterd/0.2", "team":"dawn",
  "key":"<agent join key | human credential>",
  "claim": { "kind":"member", "name":"Ada" }      // claim a named member
          | { "kind":"observe" },                  // human-only, role-gated
  "surface":"claude-code" }

// server → client (success)
{ "type":"granted", "claim":"member"|"observer",
  "member": <Member> | null, "observer_handle": "watcher-3" | null,
  "presence_id":"01J…", "server_time": 1733760000000 }

// server → client (failure)
{ "type":"refused", "code":"claim_conflict"|"forbidden"|"not_found"|"disabled"|"banned",
  "message":"…", "claimable": ["…names…"], "hint":"musterd team add <name> --kind agent" }
```

Rules:
- `claim.member` MUST present a valid **agent key** (for agent members) or the matching **human credential** (for human members), AND the member MUST be `active` and **not currently claimed**. Otherwise `refused`.
- `claim.observe` MUST present a **human credential** whose member role permits observing. Agents MUST NOT observe.
- A member MAY be claimed by **at most one** live session (single-active). A second claim → `refused {code:"claim_conflict", claimable, hint}`.
- On grant, the server creates the live attachment (presence) and, for members, marks the member `claimed`.

## 3. Release & grace

- On clean disconnect or `leave`, the claim enters a **grace window = the presence timeout (45s)**. Within the window a re-`join` with the same claim reclaims the seat (no `refused`). After it, the member returns to `claimable` and a team `presence` offline event fires.
- During grace the member displays as `online` (held), not `offline`, so a harness restart is invisible to teammates.

## 4. Member account status (Axis 1)

`provisioned` → `active` → (`disabled` ⇄ `active`) → `banned` ; any → `archived`.

- `provisioned`: created, never successfully claimed.
- `active`: claimable / claimed.
- `disabled`: admin-paused; cannot be claimed; credential still valid for un-disable by admin only.
- `banned`: cannot be claimed; human credential rejected.
- `archived`: retired; hidden from default roster; not claimable.

Transitions are **admin-only** and delivered as governance operations (HTTP, §7). They are roster governance, **not** work approval.

## 5. Availability (Axis 2) & Activity (Axis 3)

- **Availability** (`available | away_until(ts) | off_hours`) derives from the member's `availability` schedule. v0.2 still **stores** it; enforcement remains roadmap, but the displayed state MUST reflect a manually-set `away_until`.
- **Activity** (`offline | online | working | talking`) applies only while claimed:
  - `offline` = unclaimed.
  - `online` = claimed, idle.
  - `working` carries `meta.state` from the member's latest `status_update` (self-reported only; servers MUST NOT infer).
  - `talking` MAY be derived from an active thread with another member (display sugar; optional).

**Display resolution (first match wins):** archived/banned/disabled → provisioned(`created · waiting to join`) → away(`off until <ts>`) → unclaimed(`offline`) → claimed(`working: x` / `talking: y` / `online`).

## 6. Observers (human-only)

- A granted observer receives the live team stream and appears under a roster **`watching`** list with `observer_handle`. It is **not addressable** (no envelope `to` may target it) and MUST NOT send acts. There is **no** promotion from observer to member.

## 7. HTTP deltas (governance + bootstrap)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/teams` | now returns `{ team, member(creator+admin), human_credential, agent_key }` |
| `POST` | `/teams/:slug/members` | admin-only; creates a member in `provisioned`; returns its claim name (no per-member token) |
| `POST` | `/teams/:slug/members/:name/status` | admin-only; `{ to: "disabled"|"active"|"banned"|"archived" }` |
| `POST` | `/teams/:slug/agent-key/rotate` | admin-only; rotates the agent join key |
| `GET`  | `/teams/:slug/members` | roster includes account status, availability, activity, and the `watching` list |
| `POST` | `/teams/:slug/claim` | HTTP claim for stateless agents (mirror of WS `join` claim) |

Envelope (§2 of v0.1) and the 7 acts are **unchanged** in v0.2; `v` becomes `musterd/0.2`. Sending still requires the sender to hold the claim on `from`.

## 8. New/changed error codes

Add `claim_conflict` (member already claimed; HTTP 409). Reuse `forbidden` (bad key / not allowed to observe), `not_found` (no such member), and introduce surfacing of account states via `refused.code` (`disabled`/`banned`). `version_mismatch` covers a v0.1 client hitting a v0.2 server.

## 9. Migration

- `members.token_hash` → removed; add `account_status`; add team-level `agent_key_hash` and per-human `credential_hash`.
- A migration (schema v2) creates the new columns/tables; since musterd is pre-1.0 and local, a one-shot reset is acceptable for existing local DBs (documented), or a best-effort migration that mints an agent key and marks existing members `active`.
- `team add` output, `init`, the MCP env (`MUSTERD_TOKEN` → `MUSTERD_AGENT_KEY` + `MUSTERD_CLAIM`), and the CLI `join` flow all change accordingly.
