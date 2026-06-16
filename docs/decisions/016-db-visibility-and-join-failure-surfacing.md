# 016 — make the served database visible; surface join failures

- Status: accepted
- Date: 2026-06-15

## Context

A dogfooding session lost an agent ("Shayanne shows offline") for a non-obvious reason: the `musterd serve` daemon had been restarted in a shell without `MUSTERD_DB` set, so it opened the **default** db (`~/.musterd/musterd.db`) instead of the one the agent was registered in (`~/musterd-demo/demo.db`). The agent's adapter (autojoin on) connected, the daemon rejected the unknown token, and the only visible symptom was "offline" — no indication that (a) a *different database* was being served, or (b) the join had been *rejected*.

Two silent failure modes compounded: **which db is live is invisible**, and **a rejected (auto)join is invisible**.

## Decision

Make both observable (all additive; no SPEC/protocol-contract change):

1. **Expose the served db.** `GET /health` now returns `{ ok, v, db, schema }` (db path + applied schema version). `musterd serve` prints the db path on startup and logs `db`/`schema` on the `listening` event. `RunningServer` exposes `dbPath`. `musterd status` prints a header — `team · server · db: <path> (schema N)` — so a wrong-db ("everyone offline") is obvious at a glance. (localhost-only daemon today, ADR 007 — exposing the local fs path over `/health` is acceptable; revisit if the daemon ever leaves localhost.)
2. **Surface join failures.** The server's `unauthorized` message now explains the likely cause ("this member may not exist on the database this daemon is serving — a daemon started against a different `MUSTERD_DB` will not recognize tokens minted elsewhere"). The MCP adapter retains the last join-failure reason (`MusterdClient.lastJoinError`) and the dormant tool guards (`team_send`/`team_inbox_check`) include it, so a silent autojoin failure reads as the real cause instead of a generic "call team_join first".

## Consequences

- `/health` gains two fields; existing clients ignoring them still work. `renderStatusHeader` omits the db segment when `/health` lacks it (pre-0.2 daemon), so it degrades cleanly.
- The wrong-db class of confusion is now self-diagnosing from `serve` output, `status`, or `/health`.
- Tightened a pre-existing flaky test (`claude detect … real CLI`) with a 15s timeout — it shells out to the real `claude` binary (non-hermetic, ~4–8s) and tripped vitest's 5s default under parallel load. The non-hermetic smell remains noted in `06-testing.md`'s spirit; fully hermeticizing it is a separate cleanup.
- `musterd init` now validates the cached team/token against the live daemon (`cachedTeamLive`) and falls back to team creation when it's stale (db reset / different server) — so init remains the single entry point even on a fresh/empty daemon, with no pre-`team create` step. (Dogfood follow-up: needing `team create` before `init` was a workaround, not good UX.)
- Does **not** address the underlying ergonomics of `MUSTERD_DB` being an easy-to-forget, shell-scoped switch — picking/standardizing one db is still on the operator. A future `musterd serve` could default more loudly or warn on an empty/just-created db.
