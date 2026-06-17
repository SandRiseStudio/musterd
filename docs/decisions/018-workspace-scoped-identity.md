# 018 — one workspace binding, read by both the CLI and the MCP adapter

- Status: accepted
- Date: 2026-06-17

## Context

A musterd member's identity (server, team, member name, token, surface) was resolved two
different ways depending on the surface:

- **MCP adapter** — from `MUSTERD_*` env, baked by `musterd init` into the **per-workspace** MCP
  server entry (`claude mcp add -s local …`). Workspace-scoped and immutable per binding.
- **CLI** — from the **global** `~/.musterd/config.json`, which has **one identity slot per
  team**, mutable by any invocation on the machine.

## Problem

A two-agent dogfood (2026-06-17 redux of the 2026-06-16 run) exposed the divergence. The Ui agent
couldn't reach its MCP tools, fell back to shelling out to the `musterd` CLI, and the CLI resolved
identity from the global config — whose `lab` slot held **Api**, not Ui. Every send failed with
`envelope from/team must match the authenticated member`. Worse, two agents on one machine share
that single global slot, so `init`/`join` from one stomps the other. (`join` also silently
relabeled another member's token rather than refusing — fixed alongside this as a separate guard.)

Root cause: the CLI's identity model is **machine-global**, but every real use is
**workspace-scoped**. The agent's Bash shell doesn't inherit the MCP server's `MUSTERD_*` env, so a
shelled-out CLI had no access to its own token and fell into the wrong global slot.

## Decision

Make identity resolution **workspace-scoped and shared**, the way git resolves config by directory.

- A single file — `<workspace>/.musterd/binding.json` (`{server, team, member, token, surface}`,
  schema `BindingSchema` in `@musterd/protocol`) — is the source of truth. `musterd init` writes it
  (0600, gitignored), and **both** surfaces read it.
- Aligned resolution core, identical for both: **`MUSTERD_*` env → `.musterd/binding.json`**
  (explicit `MUSTERD_BINDING` path, else walk up from cwd). Env wins so a host can still inject
  identity and hosted/no-filesystem setups keep working.
- The CLI adds two tails on top — **explicit `--flags`** (humans pass them; the adapter has no
  argv) and a **global `~/.musterd/config.json` default** (a human typing `musterd status` in `~`
  has no binding; an adapter is always launched into one). These asymmetries are the deliberate
  "aligned unless there is reason not to" — they reflect real differences between the surfaces, not
  divergent identity stores.

Net: inside any bound workspace, `musterd <cmd>` and the MCP adapter resolve to the **same member**,
so two agents on one machine can no longer collide on the global slot.

## Consequences

- The shelled-out-CLI footgun is closed structurally: identity follows the folder, so even an agent
  that ignores the "use the `team_*` tools, not the CLI" primer line lands on the right member.
- `BindingSchema` + `BINDING_DIR`/`BINDING_FILE` are additive to `@musterd/protocol` (kept pure —
  no `node:fs`); the ~18-line walk-up reader is duplicated in `cli` and `mcp`, contract-locked by
  the shared schema. A future shared node-lib could dedupe it; not worth a package today.
- `init` now writes a second token-bearing file (`.musterd/binding.json`) in addition to the
  harness config; both are gitignored via the existing secret-warning flow. The harness env is
  **kept** (back-compat, hosted/manual launches) — env-first means every existing binding works
  untouched. This is the justified exception to single-source-of-bytes.
- Updates: `docs/architecture/04-cli.md` + `docs/architecture/05-mcp.md` (identity resolution lives
  in the CLI/MCP docs, not the wire-level `SPEC.md`). The MCP adapter optionally migrating fully off
  env onto the binding file is a clean follow-up, not a prerequisite.
