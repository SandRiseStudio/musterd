# 307 — Primer identity is local to the Workspace

- Status: proposed
- Date: 2026-08-24

## Context

ADR 012 put one managed musterd primer in `AGENTS.md` and reused the same renderer for MCP
`instructions`. At the time, both deliveries appeared to describe one binding folder: the file named
the Member, Team, role, and optional charter that `musterd init` had just provisioned, while MCP
initialization rendered the same facts from its runtime configuration.

That equivalence does not survive multiple Workspaces for one repository. `AGENTS.md` is repository
content, so every Workspace inherits the same committed bytes. The binding that identifies a Member
target is instead machine-local and Workspace-local: `.musterd/binding.json` and the MCP launch
configuration. The server's authenticated `occupied` response resolves the actual Member and its
Team-owned Role and charter. ADR 080 already established the same durable/local split for launch
configuration, and ADR 165 removed per-seat state from the repository-root-shared MCP entry for the
same reason.

The failure is live in musterd's own repository. PR #549 committed Stanley's rendered managed block.
Every sibling Workspace then inherited `You are **stanley**`, although each local binding named a
different Member. On 2026-08-24, ten inspected sibling Workspaces carried the Stanley sentence while
their bindings named `dolly`, `gptbot`, `grokbot`, `izzo`, `kimi`, `miley`, `ryder`, `sloane`,
`stanley`, and `wanderer`. A fresh Codex session in the gptbot Workspace followed the committed
instruction and attempted to claim Stanley before consulting its local binding.

The existing self-claim variant does not close the defect. It avoids a fixed Member only when the
renderer receives no Member. `musterd init` deliberately passes the newly provisioned Member, role,
and charter, so any seat can still stamp its local identity into shared repository state. Re-running
`init` repairs one checkout only until those bytes are committed or the Workspace returns to
`origin/main`.

## Problem

One renderer serves two consumers with opposite identity scopes:

- A repository primer must be stable across every Workspace that checks out the repository.
- MCP `instructions` should name the runtime's locally resolved Member target when it is known;
  authenticated occupancy should supply its Team-owned Role and charter.

Keeping the renderer shared lets a local fact cross the Git boundary. Removing identity everywhere
would be safe but would discard correct runtime orientation. Placeholder substitution would make
correctness depend on harness-specific startup hooks and would leave false or unresolved context
when those hooks do not run.

## Decision

Split primer rendering by delivery context while sharing the identity-neutral working-loop body.

1. `renderRepositoryPrimer({ team })` is the only renderer the CLI may pass to `upsertPrimer` or
   include in manual setup output. Its input type cannot accept a Member, role, charter, or claim
   target. It may name the Team because the Team is the repository's standing coordination intent,
   but it never asserts which Member occupies a Workspace.
2. The repository primer says that Member identity is Workspace-local and must come from musterd at
   runtime. With `team_*` tools, the adapter's instructions and authenticated occupancy are
   authoritative. Without them, `musterd whoami` is the read-only diagnostic. If that command finds
   no active local identity, the agent repairs wiring or asks the human; it never claims a named seat
   from repository prose.
3. `renderRuntimePrimer({ team, member? })` is the only renderer used for MCP `instructions`. A
   resolved seat claim gets the current named Member target. An unresolved claim policy gets the
   existing claim-first orientation. These bytes are process-local and never written to the
   repository. They describe intent until the server's authenticated `occupied` response confirms
   the Member.
4. Role and charter do not appear in startup primer content. They are Team facts and become available
   from the Team role library through authenticated occupancy; `team_join` already surfaces the
   server-provided charter. A toolkit is Workspace equipment, not Team identity, and appears in
   neither primer. No toolkit name or legacy toolkit charter may flow into a Role or primer.
5. Both public renderers compose one private identity-neutral loop body. The split is at the identity
   paragraph only; channel, inbox, status, Lane, ask, handoff, and skill guidance remain
   single-sourced.
6. `musterd init` rewrites an existing managed block to the repository form. This is the migration
   path for an already-poisoned repository. This repository's own `AGENTS.md` is rewritten in the
   same change so every existing Workspace receives neutral bytes from Git.
7. Tests hold the boundary at the consumers, not only at string helpers: CLI onboarding and manual
   setup snapshots must contain no Member, role, charter, or fixed claim target; MCP instruction
   tests must retain named and unresolved runtime variants. A regression test renders two repository
   primers for differently bound Members and requires byte-identical output.

This changes a protocol-package TypeScript API, not a Zod schema or the wire protocol. No protocol
version changes. ADR 012 remains in force for the primer and its two delivery surfaces; this ADR
supersedes only its decision that the committed file states a Member identity.

## Consequences

- A commit from one Workspace cannot make another Workspace impersonate its Member or inherit its
  role or charter.
- Runtime MCP context remains specific: gptbot can still receive `You are **gptbot**` from the
  adapter even though `AGENTS.md` names no Member. Its Role and charter arrive only after the Team
  authenticates the occupancy.
- Repository-only or temporarily unwired sessions get an honest state: they know the Team and the
  coordination loop, but do not invent an identity. `musterd whoami` can distinguish a local binding
  from an ambient, read-only human configuration.
- Existing poisoned repositories are not changed remotely. Their next `musterd init` rewrites the
  managed block; maintainers must commit that stable result once. No automatic daemon migration is
  needed because the defect is in repository context, not server state.
- The Team remains in committed prose. A repository intentionally shared across different Teams is
  still represented by the existing `.musterd/workspace.json`/wiring model and needs a separate
  decision; this ADR addresses multiple Members on one repository Team.

## Observability & Evaluation

**Traces.** None. Rendering standing context creates no Presence and emits no Act; adding telemetry
would turn a pure local transform into a side effect. Existing `init` output reports whether the
managed block was created, appended, or updated.

**Eval.** Success is zero Member-specific bytes in committed primer output while named MCP runtime
orientation remains intact. The regression dataset is two different local Member bindings rendered
through both delivery consumers, plus Role/charter fixtures that must not reach startup primer
content. The baseline is the current shared renderer: its repository output differs by Member and
reproduced one false-Stanley instruction across ten sibling Workspaces.

**Experiment.** None yet. The deterministic consumer tests and this repository's corrected managed
block directly falsify the known failure mechanism; session-level identity telemetry would add no
stronger evidence.
