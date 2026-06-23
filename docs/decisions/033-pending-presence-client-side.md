# 033 — pending presence is client-side (binding-backed), not a server roster entry

- Status: accepted
- Date: 2026-06-23

## Context

Claim-on-first-use (ADR 032) needs a representation for an **unclaimed** session: the recipe calls it
a *pending presence* — "reachable but holding no seat; `team_send`/`team_inbox_check` refuse while
unclaimed," keyed by `(team, workspace, connId, driver)`, with `musterd claim` matching "the pending
session for this workspace" and `--for <claim-code>` disambiguating when several coexist (recipe §6).

The handoff flags how to *represent* it as a decision to make. A.3 (Unreleased) models pending
server-side: a session authenticates with an agent key, registers, and a `claim` frame later occupies
a seat — the server knows the pending connection. But that is the **governed** model (agent key +
grant + request lane), explicitly out of scope for the local slice, and it requires the wire change
ADR 032 declined.

## Problem

Where does an unclaimed session live, given there is **no wire `claim` frame** locally? It cannot hold
a server presence — the existing `hello` authenticates a *specific member token*, which a pending
session by definition does not have. So a server-side pending roster would need exactly the new frame
ADR 032 ruled out.

## Decision

**Pending presence is a client-side state, backed by the workspace binding (ADR 018) and a local
marker file — not a server roster entry.**

- **The state.** A binding with no concrete identity (no `member`+`token`) — only a `claim` policy, or
  nothing — *is* the pending presence. `member`/`token` are made optional on `BindingSchema`;
  `isClaimed(binding)` is the predicate. The MCP adapter loads such a binding, stays reachable (it can
  read the roster — "you can look but not act"), and **refuses `team_send`/`team_inbox_check`** with a
  claim hint. It opens no WebSocket until it claims (nothing to authenticate as).
- **Identity delivery is via the binding**, the ADR 018 single source of truth: `team_join` (in-process)
  or `musterd claim` (any harness) mint-or-reuse the seat and **write it into `.musterd/binding.json`**.
  A (re)launched session — or a shelled-out CLI — then resolves to it through the normal env→binding
  ladder. There is **no IPC channel** into an already-running adapter; in-session live claim is the
  `team_join` tool's job (it sets identity in memory and joins immediately).
- **The marker file** (`.musterd/pending/<code>.json`, `PendingSessionSchema`) is the *visibility +
  disambiguation* affordance, not the delivery mechanism. An unclaimed adapter drops one keyed by
  `(team, workspace, connId, driver)` with a short `code` it surfaces in its refusal messages;
  `musterd claim` lists markers, requires `--for <code>` when several wait, and clears the chosen one
  after writing the binding. The marker holds **no token** (a pending session has no seat), so it is
  not a secret and is not gitignored.

The server-side pending roster (a session present-but-seatless, visible to admins) stays a **reserved
seam** for v0.3 (A.3) — the same way the claim response's `memory` blob is reserved. Locally it buys
nothing the binding + marker don't, and it would require the wire change ADR 032 declined.

## Consequences

- The recipe's pending-presence contract holds with no protocol change: unclaimed = no identity in the
  binding; act-tools refuse cleanly; `musterd claim` resolves the seat for the folder; `--for <code>`
  disambiguates multiple waiting sessions.
- A deliberate scoping line: **identity delivery into a *running* unclaimed session is the in-harness
  `team_join` path, not `musterd claim`.** `musterd claim` sets the folder's seat (next launch / CLI
  use); it does not reach into a live adapter's memory. Distinct simultaneous identities in one shared
  folder are the role-pool (`team_join {role}`, in-process) or worktree-per-agent cases — not one
  shared binding driving N live seats. This matches ADR 018 (identity is workspace-scoped) and keeps
  the mechanism testable without cross-process timing.
- The marker reader is duplicated in the CLI and the adapter (write side), contract-locked by
  `PendingSessionSchema` in `@musterd/protocol` — the ADR 018 duplicate-reader precedent.
- Companion to ADR 032. When the daemon leaves localhost, A.3's governed pending (agent-key auth +
  request lane) supersedes this representation; until then the binding + marker are the local floor.
- Updates: `provisioning-recipe.md` §6; `SPEC.md` A.3 (pointer note); `05-mcp.md` (identity resolution).
