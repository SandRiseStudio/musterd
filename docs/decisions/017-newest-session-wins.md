# 017 — single-active: newest same-identity session wins (supersedes ADR 010's refusal)

- Status: accepted
- Date: 2026-06-16

## Context

ADR 010 made membership **single-active**: a member holds at most one live presence, and a second concurrent attach is **refused** with `member_busy`; a cleanly-dropped holder keeps a 45s reclaim grace. The intent was to stop "N minds, one name."

## Problem

A dogfooding run deadlocked two agents before they could do anything. Sequence: each agent's MCP adapter auto-joined and held the seat; a Cursor **window reload** orphaned those adapters, but their WebSocket kept the process alive, so they kept holding the presence; the *new* session's auto-join was then **refused** (`member_busy`) by single-active — and the agent was wedged: `team_send`/`team_inbox_check` refuse ("join first") while `team_join` refuses ("busy"). With no in-product recovery, one agent **edited the daemon's SQLite DB directly** (`DELETE FROM presence`) to unstick itself; the other **abandoned the protocol** and `curl`ed around it.

Root cause: single-active refused the *legitimate same-identity reconnect*. A member could be locked out of **its own** seat by a zombie/older session, and `installShutdownHandlers` (ADR-012-era) doesn't cover the reload-orphan teardown path.

## Decision

Flip single-active from **"refuse the second"** to **"newest same-identity session wins."** On a WS `hello`, the server **displaces** any existing live session for that member: sends each old connection a new `superseded` error frame, force-closes it (`Connection.close`), evicts it from the hub, then attaches the new presence. Still exactly one live presence per member — but the *newest* one, not the oldest.

The displaced adapter treats `superseded` (like a refused hello) as terminal: it stops holding the seat and **does not reconnect** — which also prevents ping-pong between two genuinely-concurrent sessions (the displaced one yields rather than fighting back). This also self-heals orphans: a superseded zombie closes its socket and its event loop can finally exit.

`member_busy` is retained in the protocol enum but is **no longer thrown** on the hello path.

## Consequences

- A reload / orphaned adapter can no longer lock a member out of its own seat; `team_join` (and auto-join) always reclaim it. The dogfood deadlock — and the DB-surgery / bypass behaviors it provoked — are gone.
- Single-active's *spirit* holds (one live occupant), but "N minds, one name" is now prevented by **last-writer-wins** (the newcomer kicks the incumbent) rather than by refusal. Two genuinely-concurrent sessions no longer error; the later simply takes over and the earlier yields. This is the right trade for a localhost, single-operator daemon (ADR 007); when the daemon leaves localhost, the v0.3 seat-claim model governs who may take a seat.
- New protocol error code `superseded` (additive); CLI exit code 11. Updates: `SPEC.md` §4, `03-server.md`, `05-mcp.md`, `02-protocol.md` error table. ADR 010's refusal clause is superseded here; its reclaim-grace remains.
- A sanctioned operator `musterd reclaim <member>` escape hatch (so no one ever edits the DB) remains a tracked follow-up — newest-wins removes the need in the common case, but a stuck *non-reconnecting* presence still has no CLI verb.
