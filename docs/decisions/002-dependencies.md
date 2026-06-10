# 002 — runtime dependency choices

- Status: accepted
- Date: 2026-06-09

## Context

`07-conventions.md` requires an ADR for any new runtime dependency. The scaffold introduces several.

## Problem

We need to record what runtime deps each package takes and why, and the one architectural exception where the CLI imports `@musterd/server`.

## Decision

- **`@musterd/protocol`**: `zod` only. Pure schema/types; no I/O.
- **`@musterd/server`**: `better-sqlite3` (embedded synchronous store, named in the plan), `ws` (WebSocket, named in the plan), `ulid` (sortable ids per `01-data-model.md`), `zod`. HTTP is served with Node's built-in `http` — no web framework added (small surface; revisit with an ADR if routing grows).
- **`musterd` (CLI)**: `picocolors` (tiny ANSI, honors `NO_COLOR`), `ws`, `zod`. Argument parsing uses a hand-written minimal parser (no `cac`/`mri` dependency) since the command surface is small and fully specified by `04-cli.md`.
- **`@musterd/mcp`**: `@modelcontextprotocol/sdk`, `ulid`, `ws`, `zod`.
- **CLI → `@musterd/server` import exception**: `04-cli.md` allows the CLI to launch the daemon. We take the workspace dependency and import `@musterd/server` **only** in `commands/serve.ts`. Every other command talks to the server over the wire. This keeps the "clients don't import the server" rule intact everywhere except the explicit launcher.

## Consequences

- No web framework / no arg-parsing library to track for CVEs or API drift; both are easily added later behind an ADR if the surface grows.
- The CLI build depends on the server build (`serve.ts`); the dependency graph in `00-overview.md` notes this is launcher-only, not a protocol coupling.
