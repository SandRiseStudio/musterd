# 026 — harness tool environment: two universes, and role-as-provisioning-template

- Status: accepted (direction); implementation deferred (phased — see §Decision/3)
- Date: 2026-06-23

## Context

The v0.3 capability set (`membership-model.md`, `SPEC.md` Appendix A.1) lists `tool_allowlist`
and `declared_resource_scopes` alongside `can_message` / `can_flag_urgent` / `can_observe` /
`visibility_level`, as if musterd governs "tools" uniformly. But musterd **does not run the agent**.
The harness (Claude Code, Codex, Cursor) owns the agent's actual tool environment — its MCP server
config, its file/bash/web tools, its permission prompts. Today musterd's only footprint there is a
single additive registration: the adapter runs `claude mcp add musterd -s local -e K=V -- <cmd>`
(`packages/cli/src/onboard/harnesses/claudeCode.ts`). It registers *musterd's own* MCP server and
nothing else.

So "tool access" is not one thing musterd relates to one way. It is two, and conflating them makes
the capability model dishonest about what musterd can enforce. This ADR splits them and records the
scope decision (2026-06-23 brainstorm): **provisioning the harness environment is in scope, phased**,
with cross-harness teams as the end state.

## Problem

Settle, before any of the deferred capability work is built:

1. What does musterd actually *do* about tool access, given the harness owns it?
2. Is provisioning the harness environment in scope at all, or does musterd stay "team membership
   only" and leave the tool environment entirely to the user?
3. If in scope, what is the shape (the role template), and what does it mean across harnesses?

## Decision

### 1. Two tool universes

- **Universe 1 — musterd's own acts** (`team_*`: join, send, inbox, status, resolve, …). musterd
  controls these fully. The `can_message` / `can_flag_urgent` / `can_observe` / `visibility_level`
  capabilities **are** the allowlist for this universe and are **enforced server-side** — the server
  rejects an act the seat lacks. Real authorization.
- **Universe 2 — the harness's tools** (file edit, bash, web, *other* MCP servers — Figma,
  Supabase, …) plus repo/dir scopes. musterd has **zero runtime control**. It does two honest
  things and only these:
  - **Provision** (write-time): musterd already writes the harness config at `init`; a role can
    extend that recipe to register *which* MCP servers, set permission defaults, and inject the
    charter into the primer. This is what makes a "pre-built agent" *do* something instead of being
    an advisory label.
  - **Declare** (run-time): `declared_resource_scopes` is the seat stating what it will touch.
    musterd surfaces it on the roster and audits it — for **coordination** (two agents in a shared
    dir can see they overlap; pairs with git worktrees) and audit — but does **not** enforce it.

This **refines the v0.3 capability set**: `tool_allowlist` + `declared_resource_scopes` are
Universe 2 (provision + declare, harness/sandbox-enforced — Principle 4); the `can_*` flags +
`visibility_level` are Universe 1 (musterd-enforced).

### 2. Role = harness-agnostic provisioning template

A Role is the reusable bundle: **charter** (the *declared lens* — instructions/attention scope,
served on claim per `SPEC.md` Appendix A.3; "declare the lens, not the résumé",
`human-agent-dynamics.md` §3) + **capability defaults** (both universes) + a **tool/MCP recipe**
(Universe 2 provisioning) + **capacity**. Creating an agent instantiates a **seat** from a role;
provisioning renders the harness environment from the template. (Named/pooled seats: a pool is a
role with capacity > 1 and unnamed seats — the degenerate case of the named-seat primitive.)

The template is **harness-agnostic** ("file-edit + Supabase MCP + scope `packages/**`"); each
**harness adapter renders it** into that harness's format (Claude Code → `.mcp.json` + settings
permissions; Cursor → `.cursor/mcp.json`; Codex → its config). musterd owns the *intent*; the
adapter owns the *translation*.

### 3. Provisioning is in scope — phased

1. **Phase 1 (near):** support **all existing harnesses** (Claude Code, Codex, Cursor) for today's
   additive musterd-server registration; design the provisioning-recipe shape.
2. **Phase 2:** musterd provisions the fuller Universe-2 environment per harness (MCP servers,
   permission defaults, charter/primer injection), rendered per-harness from the agnostic template.
3. **Phase 3:** musterd's **own harness**.
4. **Phase 4:** **mixed-harness teams** — humans and agents on one team running *different*
   harnesses, including musterd's own. The seat/charter/capabilities are harness-agnostic, so the
   team is indifferent to which harness a member runs; only the adapter differs.

### 4. Provisioning is a starting point, not a security boundary

musterd writes the *initial* config; the user or agent can edit it afterward, and the harness still
runs its own permission prompts. Real enforcement (the shared-teams threat model, `security.md`)
needs OS/sandbox isolation that lives **below** musterd. `declared_resource_scopes` is for
coordination + audit, **never** a sandbox. State this loudly wherever provisioning is documented.

## Consequences

- **Refines, doesn't replace, the v0.3 capability model.** `membership-model.md` and
  `SPEC.md` Appendix A.1 should gain the enforce-vs-(provision+declare) split; the wire/protocol is
  untouched — provisioning is a client/onboarding concern, and the only protocol seam (charter
  served on `claim`) is already reserved (`SPEC.md` Appendix A.3).
- The harness adapter's job grows from "register the musterd MCP server" to "render a role's
  environment." The harness registry / surfaces abstraction already anticipates per-harness
  divergence, so this lands there, not in the protocol.
- **Cross-harness teams fall out for free** once seats/charters/capabilities are harness-agnostic.
- **Governed by ADR 027** (non-invasive coexistence): all provisioning must stay additive,
  reversible, and non-obligating.
- Implementation deferred. This records direction + the two-universes model that the pre-built-agent
  / role-template work and the deferred v0.3 capability set both depend on.
