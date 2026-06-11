# 009 — CLI ships as `@musterd/cli`; unscoped `musterd` is blocked on npm

- Status: accepted
- Date: 2026-06-11

## Context

The original plan reserved the **unscoped** npm name `musterd` for the CLI (a placeholder `0.0.1` publish "so the name can't be squatted"), with `@musterd/server`, `@musterd/protocol`, `@musterd/mcp` scoped. The CLI `package.json` was named `musterd` with bin `musterd`.

## Problem

Attempting to publish `musterd` (even a minimal placeholder) is rejected by npm:

```
403 Forbidden - PUT https://registry.npmjs.org/musterd
Package name too similar to existing package multer
```

`multer` (the Express middleware, 2.1.x) trips npm's typosquatting protection. The unscoped name `musterd` is therefore **permanently unobtainable** — this is a registry policy, not a transient conflict. Separately, the real CLI package can't be published as-is regardless: it depends on `@musterd/{mcp,server,protocol}` as `workspace:*`, which aren't published, so `npm i musterd` would fail until they are.

## Decision

Distribute the CLI as **`@musterd/cli`** under a new npm **org** `musterd` (free for public packages), keeping the **bin/command name `musterd`** unchanged (a `package.json` `bin` is independent of the package name). Creating the `musterd` org reserves the **entire `@musterd/*` scope** in one step — a stronger reservation than a single unscoped package, and consistent with the three already-scoped packages.

- `packages/cli/package.json` name `musterd` → `@musterd/cli` (bin still `musterd`; `publishConfig.access: public`).
- Install/usage changes from `npm i -g musterd` / `npx musterd` to **`npm i -g @musterd/cli`** / **`npx @musterd/cli`**; once installed the command is still `musterd`.
- Name reservation = create the `musterd` org, then publish the standalone placeholder `npm-reserve/musterd-cli/` (`@musterd/cli@0.0.0`, no workspace deps) to grab the headline package while the real one is unpublishable.

Unaffected (intentionally): the MCP server *id* `musterd` registered in harness configs (`.cursor/mcp.json`, `claude mcp add musterd`), the `musterd` bin, and all brand/CLI prose. These are not npm package names.

## Consequences

- One real code change: the CLI package name. Nothing imports the CLI by package name, so the rename is safe; build + tests stay green.
- Docs updated in lockstep: `README.md` (quickstart + packages table), `00-overview.md`, `04-cli.md`, `07-conventions.md`, `docs/implementation-plan.md`.
- Publishing requires the `musterd` org to exist first (a one-time web action at npmjs.com/org/create by the account owner; cannot be done from CLI). After that: `npm publish ./npm-reserve/musterd-cli`.
- The plan's "reserve unscoped `musterd`" milestone is satisfied by org creation + the `@musterd/cli` placeholder instead.
