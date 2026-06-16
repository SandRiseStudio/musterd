# 010 — single-active members + 45s reclaim grace

- Status: accepted; the `member_busy` **refusal** is superseded by **ADR 017** (2026-06-16) — single-active is now newest-wins (a second same-identity attach takes over via `superseded` instead of being refused). The single-active *invariant* (one live presence) and the 45s reclaim grace remain.
- Date: 2026-06-11
- Protocol: `musterd/0.2` (M1)

## Context

v0.1 attached a **Presence row per connection** with no per-member ceiling. The MCP adapter
auto-joined every session as a fixed member, so three Claude Code sessions on one member became
three minds wearing one name — the bug [ADR 007](007-v0.2-scope-cut.md) was written to fix. ADR 007
cut the v0.3 governance design back to a **minimal trust model**; this ADR records the server-core
half of that cut (`docs/design/membership-impl-plan.md` M1). The MCP-side half — explicit
activation, dormant-by-default — is M3 and gets its own note.

## Decision

**One live attachment per member.** A `hello` for a member that already holds a live presence is
**refused** with a new protocol error `member_busy` (HTTP/exit 409 / CLI exit 10). The seven acts
and the envelope are unchanged; the bump to `musterd/0.2` carries only this behavior plus the
roster `activity` fields (`offline | online | working`, with `state` + `last_status_at`) that M2
populates.

**A dropped holder keeps a 45s reclaim grace.** On a clean disconnect the Presence row is not
deleted — it is *released*: `conn_id` cleared and `held_until = now + 45s` (new `presence.held_until`
column, migration v2). The reaper sweeps holds whose `held_until` has passed. A held row is the
member's reservation; the next `hello` for that member clears it and attaches fresh (the reclaim).

### How the two clocks interact (deliberately)

- **Single-active** is decided by *active* presence: a row with `conn_id` set and `held_until` NULL.
  A release hold (`held_until` set) does **not** block — it is reclaimable, not occupied. So a holder
  that drops never locks itself out on reconnect, and a different session presenting the same token is
  indistinguishable from a reconnect (acceptable: v0.2 is localhost + per-member tokens; cross-session
  identity is the v0.3 agent-key problem).
- **Roster display** (`listPresence`, `hasLivePresence`) **excludes held rows**, so a member reads
  `offline` the instant its connection drops — display behavior is unchanged from v0.1. The grace is a
  silent reclaim mechanism in M1; M2 will *include* held rows in activity resolution so a brief
  reconnect renders as continuous `working` instead of flickering offline→online.
- The reaper emits `offline` only when it reaps a **live** stale row (a zombie that never released).
  A pure grace-hold expiring is not a state change — the member already went offline at disconnect —
  so it emits nothing, avoiding a duplicate `offline`.

## Alternatives considered

- **Refuse via the in-memory hub** (count live connections) instead of a DB column. Rejected as the
  source of truth: the hub is per-process and loses the grace/`held_until` lifecycle the reaper needs,
  and M2 needs the held row persisted to render reconnect continuity. The DB active-presence query is
  driven by the same connect/release events, so it tracks liveness just as faithfully and survives.
- **Delete on disconnect, allow any reconnect** (no hold). Simpler, but throws away the reservation M2
  builds on and makes "within grace vs after grace" unobservable.

## Consequences

- Schema v2: `ALTER TABLE presence ADD COLUMN held_until INTEGER` (forward-only migration). The v1 DDL
  constant ([ADR 003](003-ddl-as-ts-constant.md)) is untouched; the data-model doc gains a v2 note.
- New store seams: `release()`, `clearMemberPresence()`, `hasActivePresence()`; `reapStale()` now also
  sweeps expired holds; `hasLivePresence`/`listPresence` exclude holds.
- New error code `member_busy` across `@musterd/protocol`, server `MusterdError`, and the CLI exit
  table (exit 10).
- The HTTP `POST /presence` ping (`conn_id` NULL) is intentionally left out of single-active: it never
  claims the active slot and reaps on staleness. Revisit if it ever needs to.
- Tests: single-active refuse + reclaim (`integration.test.ts`); release/grace/reaper + reclaim-clear
  (`store.test.ts`); existing presence/db tests adjusted (schema version, no member opened twice).
