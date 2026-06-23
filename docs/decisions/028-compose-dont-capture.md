# 028 — compose, don't capture: musterd defers to proven, universal tools

- Status: accepted
- Date: 2026-06-23

## Context

musterd sits in the middle of an ecosystem of tools that are already proven and universal: **git** (and worktrees), the **harnesses** (Claude Code, Codex, Cursor), the **MCP** server ecosystem, and whatever **branching/workflow** a team already uses. As provisioning grows musterd's footprint (ADR 026 — registering MCP servers, writing permission defaults, optionally arranging worktrees), there is a standing temptation to reinvent or take over what these tools already do well: to become a package manager for MCP servers, to impose a git workflow, to own the harness's permission model, to act as a sandbox.

Principle 4 ("protocol over framework — we connect agents, we don't run them") already says this about the agent *runtime*. This ADR records the same instinct **generalized to the whole surrounding ecosystem**, because the provisioning work is where the temptation to overreach is highest (2026-06-23 brainstorm).

## Decision

**musterd composes with, and defers to, proven/universal tools. It adds only the thing none of them do — named, persistent, cross-harness team coordination — and reinvents nothing they already do well.**

Concrete applications (each already steered a decision in the recipe design — this is the through-line, not a new constraint):

- **MCP ecosystem** — role templates carry *concrete* MCP server entries and *reference* the ecosystem's servers; musterd does **not** build a handle registry, host servers, or version-manage them. (ADR 026.)
- **git / worktrees** — musterd **recommends** worktree-per-agent (stronger per-agent tool isolation) but never **requires** it and never manages a branching model. It must **work well in a plain shared folder**, with per-role tooling degrading to declared-scopes + charter.
- **the harness's permission model** — provision **additively** (merge, never replace); never clamp a folder's permissions or take over the harness. (ADR 027.)
- **isolation/sandboxing** — **provision ≠ enforce** (ADR 026 §4); real isolation is deferred to the OS / harness sandbox. musterd is not a security boundary.

**Recommendations follow the ADR 014 pattern:** when a proven tool would make musterd work better, say so in **one dim, non-moralizing line framed as a capability unlock, shown once and never repeated** ("musterd gives each agent stronger isolation in its own git worktree — works fine without one"). Never nag; never block; degrade gracefully is a **requirement**, not a nicety.

**The built-in role library is a seed of examples, not a catalog or a walled garden.** musterd ships a small set of archetypes (`generalist`, `reviewer`, `backend`, `frontend`, `docs`); users author their own in `.musterd/roles/`. A shared/community registry may exist later, but **musterd does not own or gatekeep it** (same posture as not owning the MCP registry). The `generalist` (no-role) seat gets **nothing extra** — only the musterd MCP server + a bare charter; tooling is something you opt into by choosing a richer role.

## Consequences

- **Unifies the rationale** under ADRs 026 (two universes / provisioning) and 027 (non-invasive coexistence): all three say "add the missing coordination layer; defer the rest."
- **A test for future features:** *are we reinventing something already proven and universal? Then defer to it and compose.* This applies beyond provisioning — to transport, identity, storage, and any future surface.
- **"Degrade gracefully without tool X" becomes a design requirement**, not an afterthought — for git, for worktrees, for any harness-specific capability.
- Bounds scope creep: it is the standing answer to "should musterd also do <thing some proven tool already does well>?" — usually no, compose instead.
