# 029 — role template format: JSON for user files, in-source for built-ins

- Status: accepted
- Date: 2026-06-23

## Context

ADR 026 makes a Role a harness-agnostic *provisioning template*; the provisioning-recipe design
left "the exact template file format (YAML vs TOML)" explicitly open. Phase 1 (this build) needs a
concrete on-disk format for user-authored templates (`.musterd/roles/<name>.*`) and a way to ship
the built-in seed library (`generalist`, `reviewer`, `backend`, `frontend`, `docs`).

The design doc wrote its examples in YAML. But YAML needs a runtime parser dependency, and hard
rule #6 (`AGENTS.md`) gates any new runtime dependency behind an ADR. JSON and a TS-module both
avoid the dep. This is the decision the recipe parked.

## Problem

1. What format do **user-authored** role templates use on disk?
2. How do the **built-in** templates ship, given the package builds with plain `tsc`?

## Decision

1. **User-authored templates are JSON** — `.musterd/roles/<name>.json`. JSON needs no new runtime
   dependency (it parses natively), validates cleanly through a zod schema (`RoleTemplateSchema`,
   hard rule #4), and carries no code-execution risk (unlike a TS/JS module that a user would
   `import`). The charter accepts a **string or an array of lines** (normalized to one string), so
   multi-line prose stays readable in JSON without manual `\n` escaping — recovering most of YAML's
   ergonomic edge without the dependency.

2. **Built-in templates ship in-source** (`onboard/roles/builtins.ts`) as raw data, validated
   through the *same* `parseRole` as user files. `tsc` does not copy non-TS assets into `dist/`, so
   JSON-file built-ins would require a bundler/copy build step — a new build dependency we decline
   under the same instinct as hard rule #6. Expressing the seed in-source keeps the build a plain
   `tsc` and guarantees the built-ins are always present at runtime. User files and built-ins share
   one schema and one parser, so they cannot validate differently.

**Not adopted: YAML.** It is the friendliest authoring format but costs a runtime parser dependency
for a Phase-1 slice that does not need it. **Not adopted: TS/JS module templates for users.** They
would execute arbitrary code on load. If demand for YAML/TOML user files appears, adding a parser is
a clean, ADR-gated follow-up — the schema and loader are format-agnostic behind `JSON.parse`.

### Scope note (deviation recorded)

Phase 1's Claude Code renderer provisions a role's **`tools.mcp_servers`** (via `claude mcp add`)
and injects its **charter** into `AGENTS.md`. `tools.resource_scopes` are **declared-only**
(coordination, not a sandbox — ADR 026 §1/§4) and `tools.permissions` are **parsed and
forward-compatible but not yet written** into harness settings. Harness *permission* provisioning,
the Cursor/Codex renderers, and a `musterd uninstall` command are explicit fast-follows (see
provisioning-recipe.md "Settled vs open"), kept out of this slice to hold it to the smallest correct
change.

## Consequences

- A user reproduces a role by dropping a JSON file in `.musterd/roles/`; a teammate reproduces it by
  provisioning the same checked-in template locally (reproducibility lives in the template, recipe §4).
- `role create` round-tripping a built-in into an editable `.musterd/roles/<name>.json` (recipe
  "open") becomes a straightforward serialize-to-JSON, since both share the schema.
- Adding YAML/TOML later is additive and ADR-gated; it does not invalidate any JSON template.
- Moves "template file format" from open → settled in `provisioning-recipe.md`.
