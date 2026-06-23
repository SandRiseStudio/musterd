# 027 — non-invasive harness coexistence: musterd is a guest, not a captor

- Status: accepted
- Date: 2026-06-23

## Context

`musterd init` writes into the harness's own configuration: it registers an MCP server
(`claude mcp add -s local`), appends a primer block to `AGENTS.md` (ADR 012/023), and documents an
optional `SessionStart` hook (`harness-hooks.md`). As provisioning grows (ADR 026 — registering
other MCP servers, permission defaults, charter injection), musterd's footprint in someone else's
tool grows with it.

That footprint is the adoption risk. musterd's whole incremental-adoption path is: a developer tries
it in one repo, and if it isn't pulling its weight, they keep using Claude Code there as if musterd
weren't installed. The moment setting up musterd *captures* the harness — breaks the user's existing
tools, or forces them onto a team just to open a session — musterd has become a cost to adopt rather
than an addition (2026-06-23 brainstorm).

## Problem

Setting up musterd in a directory MUST NOT capture the harness. A user MUST be able to use their
harness (Claude Code, Codex, Cursor) in a musterd-configured directory **without being forced to use
musterd** — and to walk away cleanly.

## Decision

Anything musterd writes into a harness MUST satisfy three properties:

1. **Additive.** musterd only *adds* (its MCP server entry, an appended primer block, an optional
   hook). It never removes, rewrites, or reorders the user's existing MCP servers, tools, or
   settings. (Already true: the adapter adds one server; the primer is appended with the user's
   content kept — ADR 023.)
2. **Reversible.** Everything musterd wrote is cleanly removable, restoring the prior state. *Gap
   today:* `musterd reset` (ADR 022) wipes the db + `config.json` but does **not** touch the harness
   footprint (`.mcp.json` entries, hooks, the `AGENTS.md` primer block). Closing that — an
   `init`-undo / per-folder uninstall that removes exactly what musterd added — is the follow-up
   this ADR mandates.
3. **Non-obligating.** Registering musterd's tools ≠ being on a team. A session can ignore musterd
   entirely and just code — the tools sit unused, no presence, no obligation. The dormant-until-join
   model (M3, `harness-hooks.md`) already provides this.
   - **Tension recorded:** `MUSTERD_AUTOJOIN=1` makes a session show presence on launch. That is a
     *chosen* convenience for the operator driving the agent, opt-in at `init` and per-operator
     (the token lives in the gitignored `.musterd/binding.json`, never inherited by a teammate who
     clones the repo). The "just code" escape MUST stay trivial: don't join / `team_leave` / the
     tools are simply inert if unused.
   - **Scope:** `-s local` keeps every change **project-scoped**; musterd never touches the user's
     global harness setup.

## Consequences

- **Guardrail on ADR 026.** Every provisioning step the role-template work adds is bound by these
  three properties — additive registration, a clean uninstall, no forced team membership.
- **Surfaces a real gap:** there is no per-folder musterd uninstall today. `reset` is machine-global
  and leaves harness config behind. Reversibility (property 2) makes building that uninstall a
  requirement, not a nicety.
- **Onboarding copy stays honest:** init should say, in effect, "musterd adds its tools to
  Claude Code here — you can still use Claude Code normally," matching the additive reality.
- Costs nothing to hold now (today's behavior already satisfies 1 and 3); it is a standing
  constraint that keeps the growing footprint from quietly violating the adoption promise.
