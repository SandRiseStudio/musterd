# 282 — Crash-safe multi-harness reconciliation

- Status: accepted
- Date: 2026-08-19
- Supersedes in part: ADR 030 (name-only provisioning receipts), ADR 080 (single-Surface `wire`),
  ADR 275 (capture-derived Presence Surface), ADR 281 (per-harness receipts and shared-resource
  ownership)
- Relates to: ADR 018 (workspace binding), ADR 026 (harness tool environment), ADR 027
  (non-invasive coexistence), ADR 116 (agent harness selection), ADR 143 (workspace-anchored
  identity), ADR 165 (one universal MCP entry), ADR 213 (cross-worktree launch guard), ADR 251
  (native musterd harness)
- Lane: `01M0B1DP6Z4GD249S026VB0368`
- Detailed design:
  [multi-harness worktree selection](../superpowers/specs/2026-08-18-multi-harness-worktree-selection-design.md)

## Context

ADR 281 separated worktree identity, the machine-local desired harness set, and the Surface of a
live Presence. That direction is correct, but independent review before implementation found that
its ownership and recovery mechanism was not sufficient.

A harness registration is not one indivisible resource. One configuration file may contain a
musterd MCP entry, permissions, hooks, guidance, and unrelated human-authored entries. Several
worktrees may contribute to one repository-scoped registration. A receipt attached to one harness
cannot say which worktree owns which fragment, and a receipt that records only a server name cannot
prove that the current fragment is still what musterd wrote.

Atomic replacement protects a JSON or TOML file from partial bytes, but it does not make a sequence
of external configuration and local receipt writes atomic. A process can stop after changing the
harness file but before recording ownership, or after removing the last shared fragment but before
releasing its owner. Retrying from only the old receipt can then overwrite or remove configuration
without authority.

The review also found three boundary errors: local schema readers collapse malformed files to
`null`; registry ordering had leaked into the proposed protocol contract; and the acceptance test
treated the binding as immutable even though Presence attachment legitimately updates capture,
model-observation, claim, grant, and capability-cache fields.

## Problem

Define a reconciliation contract that:

1. proves ownership at fragment granularity and represents several worktrees contributing to one
   physical registration;
2. recovers deterministically after a stop between external and local writes;
3. never adopts, overwrites, or removes an unowned or externally changed fragment;
4. keeps machine-local selection independent across machines;
5. rejects old or malformed local identity state loudly; and
6. identifies Presence Surface from the launcher without treating legitimate binding updates as
   provisioning drift.

## Decision

### 1. Ownership is recorded per managed fragment

Each MCP entry, permission entry, hook, and managed guidance block is a separate resource fragment.
A machine-local ledger records, for each fragment key:

- the harness id and registration scope;
- a canonical fingerprint of the exact fragment musterd last wrote;
- the normalized worktree roots that currently contribute ownership; and
- the adapter and schema versions needed to interpret it.

The worktree provisioning manifest stores the desired harness ids and that worktree's contribution
references. It does not duplicate a shared physical receipt. Owner sets, never numeric reference
counts, are canonical state. A `repo-shared` or `machine` fragment remains while at least one owner
contributes to it.

An existing equivalent fragment without ledger evidence is `unmanaged-equivalent`: it satisfies the
desired capability but is never adopted and is never removed by musterd. A same-key fragment with
different contents is `unmanaged-conflict`. A fragment whose current fingerprint differs from its
owned fingerprint is `owned-drifted`. Both conflict states stop mutation and preserve evidence.

### 2. Every external mutation has a durable write-ahead journal

Before an adapter changes a managed fragment, the reconciler acquires the machine resource lock and
writes a strict, fsynced journal record containing an operation id, resource key, old fragment
fingerprint, intended fragment fingerprint, and owner/contribution delta. It then applies a
fragment-scoped read/modify/write that preserves unrelated content, persists the worktree and
machine ledger result, and clears the journal.

At startup and before a new reconciliation, recovery compares the observed fragment with the journal:

- observed equals old: the external mutation did not land, so retry it;
- observed equals intended: the mutation landed, so finalize ledger state;
- observed equals neither: external state changed ambiguously, so report conflict and mutate nothing.

Owner-only operations do not change a fragment fingerprint. Their recovery idempotently converges
the worktree contribution and machine owner set to the journal's intended owners, then clears the
journal.

Temporary-file replacement still prevents partial local JSON. The journal, not rename alone, closes
the external-write/receipt-write gap. Adapters re-read the containing harness file immediately before
their scoped replacement and apply their transform to that latest parse; they never replace the file
from a stale whole-file snapshot.

### 3. Reconciliation is conservative and deterministic

Registry order is CLI policy. `@musterd/protocol` validates strict state shapes and unique harness
ids but neither imports the installed registry nor sorts selections.

For a desired harness, an absent fragment is created, an `owned-exact` fragment is unchanged, and an
`unmanaged-equivalent` fragment is reported as `satisfied-unmanaged`. `owned-drifted` and
`unmanaged-conflict` stop with a repair diagnostic; musterd does not overwrite them.

For a deselected harness, releasing a non-final shared owner changes only contribution state. The
final owner removes a fragment only when its observed fingerprint is still `owned-exact`. A final
owner facing drift retains its receipt and reports `release-blocked`. Failure at any removal or local
cleanup step leaves enough journal and ownership state for an idempotent retry.

### 4. Local schemas and adapter inputs have explicit boundaries

`WorkspaceSpecSchema` and `BindingSchema` become strict local version-2 objects and no longer contain
`surface`. Local loaders return a discriminated result: `missing`, `legacy`, `valid`, or `invalid`.
Ordinary commands reject legacy and invalid files. Only `musterd harness configure` may convert the
recognized old shape, after the human confirms the complete desired harness set. Name-only version-1
provisioning receipts do not become version-2 ownership evidence.

Each adapter receives a `HarnessContext` containing the explicit worktree root, optional resolved
repository root, machine config root, optional parsed identity, and injected filesystem,
process/environment, lock, and clock seams. Adapter behavior must not depend on ambient current
directory or home-directory globals.

Harness ids remain open validated strings. An adapter's runtime Surface must be a member of the
existing protocol `SurfaceSchema`; a novel harness uses `other` until a separate protocol ADR adds a
new Surface. This decision makes harness registration extensible, not the wire vocabulary.

### 5. Commands own distinct responsibilities

- `musterd init` collects the initial machine-local harness multi-selection.
- `musterd harness configure` is the only desired-set editor and legacy converter.
- `musterd wire` non-interactively reconciles an existing valid selection. With no local selection it
  refuses to guess and directs the human to `harness configure`.
- `musterd harness status` reads desired, available, observed, ownership, journal, and repair state
  without mutation.
- `musterd uninstall` first reconciles the desired set to empty. It removes local identity and
  provisioning files only after every owned contribution is released. A blocked fragment or cleanup
  failure returns nonzero and retains recovery evidence.

This supersedes ADR 080's promise that a fresh clone can choose one harness from committed
`workspace.surface` with a single `wire`. A new machine makes one local selection; subsequent
launches and `wire` runs are non-interactive. It also removes ADR 080's fallback from an unknown
Surface to Claude Code.

### 6. The launcher, not capture or provisioning, identifies Presence Surface

Ordinary CLI acts intrinsically use `cli`; the native hosted harness intrinsically uses `musterd`;
and external harness registrations inject a non-secret `MUSTERD_LAUNCH_SURFACE`. An explicit
`MUSTERD_SURFACE` remains the deliberate headless/testing override. A manually launched MCP adapter
without a valid marker or override refuses to join.

This supersedes ADR 275 only where it derives Presence Surface from `binding.session.harness` or
`model_observed.harness`. Capture remains valid for resumability and model observation. ADR 143's
workspace-anchored Member identity remains unchanged.

Launching may update the binding's runtime fields, but it never changes workspace identity, desired
harness state, ledger ownership, or managed registration fragments.

## Consequences

- A human selects any supported harness subset once per worktree and machine, then switches among
  those harnesses by launching them rather than rewiring.
- Equivalent human-authored configuration can make a selected harness usable without giving musterd
  deletion authority.
- Externally changed managed fragments require an explicit human repair instead of silent overwrite.
- Repository-shared registrations survive one worktree's deselection while another worktree owns
  them.
- A fresh clone on a new machine requires one local selection; committed identity alone no longer
  guesses a harness.
- The ledger and journal add local state and failure cases, but make ownership and recovery auditable.
- Existing mistaken prose that names ADR 038 as the harness-registry decision is corrected where
  this behavior is documented; ADR 026 and ADR 116 are the relevant architectural lineage.

## Observability & Evaluation

**Traces.** Reconciliation emits one local provisioning-operation span per harness and resource with
harness id, scope, desired/available/observed classification, planned action, journal recovery path,
result, and duration. It records neither filesystem paths, configuration bodies, nor credentials.
`harness status` is the durable human read for the same state.

**Eval.** The dataset is a deterministic adapter matrix covering every desired/availability/observed
classification, two worktrees sharing a repository registration, two independent machine directory
trees, unmanaged collisions, drift, and a stop injected after every journal phase. Baseline ADR 281
cannot represent per-worktree shared contributions or recover the external-write/receipt-write gap.
Target: every matrix row converges idempotently without changing an unrelated fragment.

**Experiment.** None. This is a configuration-safety correction. The live falsifier configures one
worktree for Claude Code, Codex, Cursor, and musterd, then launches the same Member sequentially on
each Surface without `wire`. Desired state, ownership, and managed fragment fingerprints must remain
unchanged; only explicitly allowlisted binding runtime fields may change.
