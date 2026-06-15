# 014 — provenance + "where" captured at attach

- Status: accepted
- Date: 2026-06-15

## Context

`human-agent-dynamics.md` §2 names two attach-time facts that dissolve the "driving vs. supervising" presence confusion without modelling humans or relationships:

- **provenance** — *why* a presence exists (`session | asked | hook | scheduled | daemon`). `(session)` tells the team "someone is behind this"; `(scheduled)` says "nobody need be."
- **the `where` half (workspace)** — a gracefully-degrading location label, captured once at join, so a roster `working:` line is scope-aware instead of project-blind.

Both were the last open product item from v0.2 M3 (`implementation-plan.md` §4.A.3). The locked decisions: capture as fact at attach (never ask the agent per status); degrade gracefully (declared override → folder → branch/subpath qualifier); the most specific qualifier leads; sticky for the session; render dim as location context, not an authoritative scope.

## Decision

Add two **optional, additive** fields to the wire and store, consistent with the maxim "record observable facts; let meaning be read out of the record":

- **Protocol:** `ProvenanceSchema` enum; `HelloFrame` gains optional `provenance` + `workspace` (≤120 chars); `PresenceSchema` gains nullish `provenance` + `workspace`.
- **Server:** presence schema **v3** migration adds nullable `provenance` + `workspace` columns; `attach()` records them; the roster surfaces them per-presence. The HTTP `/presence` ping accepts them too.
- **MCP adapter:** `resolveProvenance()` (env `MUSTERD_PROVENANCE`, default `session`) and `resolveWorkspace()` (the degradation ladder: `MUSTERD_WORKSPACE` → `cwd` folder → `folder@branch`/`folder@subpath`); both resolved once at config load and sent on `hello`.
- **CLI:** `inbox --watch` attaches as `provenance: session` (the supervising posture) with a resolved workspace; the roster renders `online via claude-code (session) · movetrail@feat/login`, dim.

`workspace` is the concrete field name (the SQL-reserved `where` is avoided); it *is* the design doc's "where" half.

## Consequences

- No spec-version bump: `musterd/0.2` stays current; every field is optional/nullish, so v0.1/v0.2 clients that omit or ignore them still conform. Pre-0.2 presence rows read `null`.
- The "driver co-presence" seed (a paired human presence row) stays unbuilt — provenance display is the lighter first cut, exactly as §2 anticipated. Full close of who-is-behind-an-agent remains the v0.3 governance surface.
- `where` is approximately right by design (auto-derived); it is rendered as context, never enforced as scope. A declared override exists for when the auto-signal is wrong.
- `resolveWorkspace` shells out to `git` once at startup (2s timeout, failures swallowed) — cheap, and absent git it degrades to the bare folder.
