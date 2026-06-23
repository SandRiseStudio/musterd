# 031 — the Codex adapter: project-local TOML, hand-edited, not the global CLI

- Status: accepted
- Date: 2026-06-23

## Context

Codex (OpenAI Codex CLI) is one of the three required harnesses (`cli`/`claude-code`/`codex` are the
surfaces v0.1 names); Claude Code and Cursor shipped in provisioning Phase 1, Codex was deferred to
its own slice (ROADMAP, ADR 029 scope note) because it raised two unresolved questions the other
adapters didn't. This ADR settles both and records the Codex adapter's shape.

Codex reads MCP servers from `[mcp_servers.<name>]` tables in a **TOML** config. Two facts make it
unlike Claude Code (a CLI, no file) and Cursor (a project-local JSON file):

1. **Scope.** Codex config can be **global** (`~/.codex/config.toml`) or **project-local**
   (`.codex/config.toml`, trusted projects). There is a `codex mcp add <name> --env K=V -- <cmd>`
   CLI, but whether it targets the global or the project file is **not a documented, stable flag**.
2. **Format.** It's TOML, and musterd has no TOML dependency — and hard rule #6 gates adding one.

## Problem

1. Which config does the Codex adapter write — global or project-local — given ADR 027 says musterd
   must stay project-scoped and never touch the user's global harness setup?
2. How does it edit TOML without a new runtime dependency, without corrupting the user's other Codex
   settings?

## Decision

### 1. Write the **project-local** `.codex/config.toml` (not the global file, not the CLI)

The adapter writes `<cwd>/.codex/config.toml` — the same non-invasive, project-scoped posture as
Cursor's `.cursor/mcp.json` (ADR 027): one folder, in-tree, gitignorable, cleanly removable, and it
never pollutes the user's *other* Codex projects. A global `~/.codex/config.toml` write would put the
musterd server into **every** Codex session the user runs — exactly the capture ADR 027 forbids.

This is a **deliberate deviation** from the recipe's "prefer the harness's own CLI" guidance (§4):
`codex mcp add`'s write target isn't a documented project/global flag, so using it would bet on
unspecified behavior and risk a global write. Writing the project-local file ourselves is
deterministic and correct-scoped. If Codex later documents a stable `--project`/local scope for its
CLI, switching to it is a clean, additive follow-up (the adapter seam is unchanged).

The file is in-tree and carries the member token, so — like Cursor — `configure` returns its
`secretPath` and init warns + offers to gitignore it.

### 2. Hand-edit only the `[mcp_servers.*]` tables; no TOML dependency

A **minimal helper** (`onboard/harnesses/codexToml.ts`) does block-level text surgery scoped strictly
to `[mcp_servers.<name>]` (+ `.env`) tables: it adds/replaces/removes only musterd's own server
tables and passes **everything else through verbatim**. No general TOML parse, so no new runtime
dependency (hard rule #6 honored) and the user's other settings (model, `[tui]`, their own MCP
servers) are never reformatted or lost. Per-server idempotency and exact removal fall out (same
contract as the Claude Code / Cursor renderers), so `provision`/`unprovision`/`musterd uninstall`
work unchanged.

**Known limitation (documented, not hidden):** the helper recognizes the **table** form
(`[mcp_servers.x]` / `[mcp_servers.x.env]`) that `codex mcp add` and the docs produce — not the
dotted-key form (`mcp_servers.x.command = …` with no header). A comment immediately preceding a
server table is treated as part of that table (removed with it). Both are acceptable for musterd's
own round-tripping; a user hand-authoring exotic TOML is unaffected because we only ever touch tables
whose name we wrote.

### 3. Permissions + env

Codex has **no per-tool allow/ask/deny model**, so a role's `tools.permissions` degrade to declared
intent (charter) — `provision` reports none added, same as Cursor. `${ENV}` secrets are written as
**references** (the template's `${VAR}` string), never resolved or baked; whether Codex expands them
at launch is Codex's concern — musterd never writes a real secret into the role's tool env.

## Consequences

- Codex is now a first-class harness: `detect` (via `~/.codex`), `configure`, `provision`,
  `unprovision`, registered in `HARNESSES`, wired into `init` (copy + manual instructions) and
  `musterd uninstall` (which already resolves by surface). The three required harnesses are complete.
- The hand-rolled TOML helper is the one piece to revisit if Codex's config grows shapes we edit;
  it's deliberately small and well-tested so that's cheap.
- Moves the Codex renderer from open/must-build → shipped in `provisioning-recipe.md` and ROADMAP.
