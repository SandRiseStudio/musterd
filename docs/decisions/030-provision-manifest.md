# 030 — provision manifest: record what musterd added so it can be removed exactly

- Status: accepted
- Date: 2026-06-23

## Context

ADR 027 (non-invasive coexistence) requires everything musterd writes into a harness to be
**reversible**, and flags a real gap: today's `musterd reset` (ADR 022) wipes the db + `config.json`
but leaves the harness footprint (`.mcp.json` entries, the `AGENTS.md` primer) behind. As ADR 026's
role provisioning starts registering *additional* MCP servers (Phase 1, this build), reversibility
stops being free: to remove exactly what musterd added — and never clobber the user's own servers —
musterd must *record* what it provisioned. The recipe left "the `render()`/uninstall tracking
format" open.

## Problem

What is the shape and location of the record that lets a future per-folder `musterd uninstall`
remove precisely the MCP servers musterd provisioned?

## Decision

A **provisioning manifest** at **`.musterd/provisioned.json`** (next to `binding.json`), validated
on read through `ProvisionManifestSchema` (hard rule #4):

```json
{
  "version": 1,
  "role": "backend",
  "harness": "claude-code",
  "mcpServers": ["supabase"],
  "provisionedAt": "2026-06-23T18:00:00.000Z"
}
```

- **`mcpServers`** is the load-bearing field — the **names** musterd registered, which is exactly
  what a future `musterd uninstall` passes to `claude mcp remove <name> -s local` to reverse the
  provision precisely, touching nothing the user added themselves.
- **Names accumulate across re-provisions (union).** Provisioning a second role keeps the first
  role's servers in the removal set, so the manifest is always a *complete* record of musterd's
  footprint; `role` / `harness` / `provisionedAt` reflect the latest provision.
- **`version`** gates forward-compatible evolution of the shape.

### Location + secrecy

It lives in `.musterd/` (per-folder, machine/harness-specific — never shared or checked in as the
authoritative team artifact; reproducibility lives in the role *template*, recipe §4). Unlike
`binding.json` it carries **no secret** — only server *names*; the values stay `${ENV}` references
in the harness config (ADR 029 scope note / recipe §4). So it does **not** need gitignoring, and
init does not warn on it.

**Not adopted: folding the record into `binding.json`.** That file is the identity binding (carries
the token, 0600, gitignored); provisioning footprint is a separate concern with a different
lifecycle and no secret — keeping them apart keeps each file's job singular.

**Scope:** the manifest is *written* in this build; the `musterd uninstall` command that *consumes*
it is the noted fast-follow (recipe "Settled vs open"). Writing it now is what makes that uninstall
buildable later without guesswork — closing ADR 027's reversibility gap at the point the footprint
grows, not after.

## Consequences

- Every role provision records its footprint, so reversal is exact and the user's own servers are
  never at risk — satisfying ADR 027 property 2 (reversible) for the growing footprint.
- The future `musterd uninstall` reads one well-known file; `reset` (ADR 022) can later consult it
  to close the same gap machine-wide.
- Moves "the `render()`/uninstall tracking format" from open → settled in `provisioning-recipe.md`.
