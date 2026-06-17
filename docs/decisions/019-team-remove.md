# 019 — `team remove`: soft-remove a member from the roster

- Status: accepted
- Date: 2026-06-17

## Context

`init`, `team create`, and `team add` all **mint** members; nothing **removes** one. A 2026-06-15 dogfood run (`implementation-plan.md` §4.A, finding b) ran `musterd init` in the wrong folder and minted agent `Ryan` on `dawn`. With no removal verb, a mistaken or stale member lingers on the roster forever — an offline row that can only be cleared by hand-editing the daemon's SQLite DB, the exact "drop to DB surgery" failure mode ADR 017's reclaim verb was created to eliminate.

## Problem

We need a sanctioned way to take a member off a team's roster without:
- losing the member's **message history or provenance** (auditability — a removed member's past acts must still resolve), or
- adding **new schema** (the store already has the primitive), or
- leaving a **zombie live session** holding a name that's no longer on the roster.

## Decision

Add a `team remove` verb as a thin third layer over the existing soft-delete primitive, mirroring the `reclaim` verb (ADR 017 follow-up):

- **Store:** reuse `leaveMember(db, memberId)`, which stamps `left_at`. Every list/auth/route path already filters `left_at IS NULL`, so a removed member drops off the roster, auth, and delivery automatically — no rendering or query changes.
- **HTTP:** `POST /teams/:slug/members/:name/remove` — resolve the target via `getMemberByName`, `404` if absent or already `left_at`, then `leaveMember`. Reusing reclaim's eviction path, force-close any live WS session (`superseded` frame), clear presence, and broadcast `offline` so the seat frees immediately.
- **CLI:** `musterd team remove <name>` routes to `teamRemove`, which resolves team+identity, calls `http.removeMember`, and prints a themed success line (or `--json`).

Soft-delete only — rows are **never** hard-`DELETE`d. Removal is **idempotent**: removing an already-removed (or never-existing) member is a clean `not_found` (CLI exit 6), not an error stack.

Like reclaim, removal is **ungated on localhost-only v0.2**: any team member may remove any member. The v0.3 seat-claim model will govern who may remove whom once the daemon leaves localhost.

## Consequences

- A mistaken/stale member is cleared with a first-class verb; no one needs to edit the daemon's DB. Closes `implementation-plan.md` §4.A finding (b).
- A removed member's **history and provenance survive** (`left_at` set, row kept); past acts still resolve. Note the name is **not** freed for re-add: `members` has a `UNIQUE(team_id, name)` index that ignores `left_at`, so `team add` of a removed name fails. Reusing/reactivating a name is the v0.3 seat-claim model's job (see out-of-scope), not this verb's.
- New HTTP endpoint + CLI verb (additive; no protocol-schema change). Docs updated in lockstep: `04-cli.md` (command, file tree, acceptance tests).
- **Out of scope:** any un-remove/reactivate flow — that is the v0.3 seat-claim model (`implementation-plan.md` §4.D), deliberately not built here.
