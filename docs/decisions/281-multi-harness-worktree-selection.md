# 281 — Select harnesses once; switch Surfaces without rewiring

- **Status:** accepted 2026-08-18
- **Deciders:** nick, gptbot
- **Relates to:** ADR 018 (workspace binding), ADR 038 (harness adapters), ADR 080 (local
  provisioning manifest), ADR 143 (folder-scoped Codex configuration), ADR 165 (one universal MCP
  entry), ADR 213 (cross-worktree launch guard), ADR 251 (native musterd harness), ADR 275
  (machine-local provisioning)
- **Lane:** `01M0B1DP6Z4GD249S026VB0368`
- **Detailed design:**
  [multi-harness worktree selection](../superpowers/specs/2026-08-18-multi-harness-worktree-selection-design.md)

## Context

A musterd worktree can be opened through Claude Code, Codex, Cursor, or musterd's native harness.
Those are Surfaces: runtime locations where the same persistent Member can be present. Today the
local workspace and binding files each store one `surface`, and `musterd wire` derives the harness
to configure from that value. Moving from one harness to another therefore means mutating durable
workspace identity and reconciling a different registration.

That model is also uneven across harnesses. Codex and Cursor registrations are folder-scoped;
Claude Code's registration is shared by sibling worktrees at the repository root; the native
musterd harness needs no external registration at all. Treating all four as one mutable `surface`
field both hides those ownership differences and makes a correctly configured worktree appear
stale whenever the user changes tools.

The configuration is machine-local. Two people on the same Team can use different harnesses on
different machines, and neither person's selection should alter Team state or the other's files.

## Problem

The product conflates three independent facts:

1. which Team and Member this worktree is bound to;
2. which harnesses this machine should keep configured for the worktree; and
3. which Surface launched the current Presence.

As a result, `musterd wire` can point at only one harness, runtime Surface inference can fall back
to stale provisioning data, and repairing one harness can disturb another. Future harnesses would
require more special cases instead of one lifecycle contract.

## Decision

1. **Workspace identity carries no Surface.** Remove `surface` from the local workspace and binding
   schemas. This is a clean schema break, not a compatibility migration: ordinary commands reject
   old files and direct the operator to `musterd harness configure`. That command alone performs
   the one-time conversion while collecting the new selection. This ADR authorizes the otherwise
   prohibited change to the local `@musterd/protocol` schemas; it does not change the wire protocol
   or the protocol version.

2. **A worktree owns a machine-local desired set of harnesses.** `musterd init` presents all known
   harnesses as a multi-select, preselects detected available harnesses, and allows supported but
   unavailable harnesses to be selected as pending. `musterd harness configure` edits the same
   set. The selection and reconciliation receipts live in the ignored local provisioning manifest;
   they are never committed or synchronized through a Team.

3. **Configuration is reconciled, not switched.** `musterd wire` is a deterministic,
   non-interactive reconciler from the saved desired set to machine state. It configures every
   selected available harness, preserves selected unavailable harnesses as pending, and removes a
   deselected harness only when a musterd-owned receipt proves exactly what musterd created.
   Unrelated user configuration is never removed. A pending selection exits successfully; a failed
   configure or removal exits nonzero and retains enough receipt state for an idempotent retry.

4. **Each harness declares its registration lifecycle.** A manifest-driven adapter registry gives
   every harness an id, Surface, registration scope (`folder`, `repo-shared`, `machine`, or
   `in-process`), availability check, resource identity, and configure/remove operations. The
   native musterd harness is `in-process` and therefore selected without writing an external MCP
   registration. A future harness joins by implementing the same contract rather than extending a
   central conditional.

5. **Shared registrations have machine-local ownership, not a blind reference count.** For a
   `repo-shared` resource such as Claude Code, a machine-local index records the normalized set of
   worktrees that selected it. Deselecting from one worktree releases that owner but preserves the
   physical registration while another owner remains. The last owner removes only the received,
   musterd-owned registration. The index is local to the machine and stores owners, not a derived
   integer, so it remains auditable and repairable.

6. **The launcher identifies the current Surface.** An external harness registration supplies a
   non-secret, harness-owned launch identity (`MUSTERD_LAUNCH_SURFACE`). The native harness supplies
   its Surface in process. An explicit operator override remains available for deliberate headless
   use, but workspace and binding files are never consulted as fallback. Surface belongs to the
   runtime Presence; switching harnesses starts a Presence on the new Surface without changing
   workspace configuration.

## Consequences

- A user configures any subset once and can then move between Claude Code, Codex, Cursor, and the
  native musterd harness without running `wire` between sessions.
- The same worktree can have several configured harnesses even though a user normally occupies it
  through one harness at a time.
- Different machines and teammates may select different harness sets for the same repository with
  no shared-state conflict.
- Old workspace and binding files stop working until explicitly converted. There is no silent
  fallback, dual read, or legacy write path.
- Removing a harness becomes more conservative: musterd may leave an unreceipted or ambiguously
  owned registration in place and report it rather than risk deleting user configuration.
- Adding a harness requires a registry entry and lifecycle implementation, not changes to
  workspace identity.

## Observability & Evaluation

**Traces.** Reconciliation emits one existing provisioning-operation span per harness with harness
id, scope, desired/available/observed state, planned action, result, and duration. It never records
paths, config fragments, credentials, or receipt bodies. `musterd harness status` is the durable
operator read: per harness it reports desired state, availability, scope, observed state, ownership,
and the next repair action. `musterd wire` reports each transition and distinguishes configured,
pending, unchanged, released, removed, unmanaged, and failed.

**Eval.** The dataset is the deterministic adapter fixture matrix: every desired/available/observed
transition, injected receipt failure, two sibling worktrees sharing one repository registration,
two isolated machine roots, one fixture-only future harness, and the native `in-process` harness.
The baseline is current `main`: one persisted `surface` selects one adapter, so the sequential
four-harness scenario requires rewiring and cannot preserve config bytes. The target is 100% of the
matrix and sequential-switch assertions passing. The live falsifier is one worktree configured for
Claude Code, Codex, Cursor, and musterd: launch the same Member sequentially through each, observe
the corresponding runtime Surface, and byte-compare workspace, binding, selection, ownership, and
harness registrations before and after. Any required rewire, stale Surface, cross-machine selection
leak, or removal of unrelated configuration fails the evaluation.

**Experiment.** n/a — this is a deterministic configuration and ownership correction, not a user
preference hypothesis. The acceptance matrix and live falsifier decide correctness directly.
