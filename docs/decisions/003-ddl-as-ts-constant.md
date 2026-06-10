# 003 — DDL stored as a TS constant, not a .sql asset

- Status: accepted
- Date: 2026-06-09

## Context

`03-server.md` listed `packages/server/src/db/schema.sql` as the DDL file loaded by migration v1.

## Problem

`tsc` does not copy non-TS assets to `dist/`. Loading a `.sql` file at runtime via `fs` requires resolving a path that differs between `src/` (tests) and `dist/` (built), plus an extra build step to copy the asset. That is avoidable complexity for a single DDL string.

## Decision

Store the v1 DDL (verbatim from `01-data-model.md`) as an exported TypeScript string constant in `packages/server/src/db/schema.ts` (`SCHEMA_V1_SQL`). `migrations.ts` imports it. No `.sql` asset, no runtime file read, no build asset-copy step.

## Consequences

- `03-server.md` file tree updated: `db/schema.sql` → `db/schema.ts`.
- `01-data-model.md` remains the human-readable authoritative DDL; `schema.ts` must stay character-equivalent to it (a divergence is a bug → fix or ADR).
- If the DDL grows enough to want real `.sql` files + a loader, revisit behind a new ADR.
