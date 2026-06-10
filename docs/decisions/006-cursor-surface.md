# 006 — add `cursor` Presence surface

- Status: accepted
- Date: 2026-06-10

## Context

`musterd init` onboarding supports Cursor as a harness. A member hosted in Cursor needs an honest Presence surface.

## Problem

The `Surface` enum was `cli | claude-code | codex | web | ios | slack | other`. A Cursor-hosted agent would have had to present as `other`, losing the information that it is in Cursor — which the roster/status UI and the onboarding "waiting to join" check rely on.

## Decision

Add `cursor` to the `Surface` enum (`@musterd/protocol` `SURFACES`) and to the `presence.surface` CHECK constraint. Because musterd is **pre-release with no existing databases**, this is folded directly into the v1 schema (the CHECK list) rather than introduced as a migration. It is an additive, backward-compatible enum value (servers accept one more value).

## Consequences

- Updated in lockstep: `packages/protocol/src/acts.ts`, `packages/server/src/db/schema.ts`, `docs/architecture/01-data-model.md`, `docs/architecture/02-protocol.md`.
- Future post-release surface additions must come as a schema migration (CHECK constraints can't be altered in place in SQLite without a table rebuild); this one is free only because no data exists yet.
- `SPEC.md` §1 lists surfaces by example ("such as `cli`, `claude-code`, `codex`") and does not enumerate them normatively, so no spec-version bump is required.
