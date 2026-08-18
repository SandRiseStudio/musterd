# Multi-harness worktree selection — configure once, switch by launching

- Date: 2026-08-18
- Status: approved 2026-08-18 (nick)
- Decision: [ADR 281](../../decisions/281-multi-harness-worktree-selection.md)
- Builds on: ADR 018 (workspace binding), ADR 038 (harness adapters), ADR 080 (provisioning
  manifest), ADR 143 (folder-scoped Codex configuration), ADR 165 (universal MCP entry), ADR 213
  (cross-worktree launch guard), ADR 251 (native harness), ADR 275 (machine-local provisioning)
- Lane: `01M0B1DP6Z4GD249S026VB0368`

## Purpose

A user chooses the harnesses they want available in a worktree once, then opens that worktree in
Claude Code, Codex, Cursor, or musterd without changing configuration between sessions. Harness
selection is local to that worktree on that machine. Team identity remains shared; runtime Surface
identity comes from the launcher.

This design replaces the current one-workspace/one-`surface` model. It deliberately provides no
backward-compatible read path.

## 1. The three facts are separate

| fact | lifetime | source of truth |
|---|---|---|
| Team and Member binding | worktree | `.musterd/workspace.json` + `.musterd/binding.json` |
| desired harnesses and ownership receipts | worktree × machine | ignored `.musterd/provisioned.json` plus the machine ownership index |
| current Surface | Presence | explicit runtime launch identity |

The first fact answers _who and where_. The second answers _what this machine should keep ready_.
The third answers _where this Member is attached now_. No file or field serves two rows.

The worktree and binding schemas advance to a new local version and remove `surface`. Their
remaining Team, server, claim, credential, driver, and model responsibilities do not change. The
schema version is local provisioning metadata; this change does not alter `SPEC.md`'s wire envelope
or protocol version.

## 2. Local state

### Worktree provisioning manifest

The existing ignored `.musterd/provisioned.json` becomes the sole worktree-local source for desired
harness state:

```ts
type HarnessId = string; // parsed against the installed adapter registry

type HarnessProvisioning = {
  version: 2;
  desired: HarnessId[]; // unique, stable registry order on write
  receipts: Record<HarnessId, HarnessReceipt>;
};
```

Each receipt contains the adapter version, registration scope, stable resource key, exact owned
fragments or identifiers needed for safe removal, last successful action, and last observed state.
It contains no team agent key, grant, credential, or other secret. Receipt schemas are strict;
unknown harness ids or malformed receipts stop reconciliation with a repair message rather than
being discarded.

The desired set is not copied into `workspace.json`, committed configuration, server state, or Team
acts. A clone on another machine starts with no desired set and obtains one through `musterd init`
or `musterd harness configure`.

### Machine ownership index

Resources with `repo-shared` or `machine` scope use a chmod-600 index under the machine's musterd
config root:

```ts
type HarnessOwnershipIndex = {
  version: 1;
  resources: Record<ResourceKey, {
    harness: HarnessId;
    owners: string[]; // normalized real worktree roots, sorted and unique
    receipt: SharedResourceReceipt;
  }>;
};
```

The set of owner paths is canonical state; no stored numeric reference count can drift away from
it. Tests substitute independent config roots to model separate machines. Nothing in this index is
Team-synchronized.

## 3. Harness adapter contract

The onboarding layer discovers behavior through one registry:

```ts
type HarnessAdapter = {
  id: HarnessId;
  surface: Surface;
  registrationScope: 'folder' | 'repo-shared' | 'machine' | 'in-process';
  availability(ctx): Promise<Availability>;
  resourceKey(ctx): Promise<string | null>;
  observe(ctx): Promise<ObservedRegistration>;
  configure(ctx): Promise<HarnessReceipt>;
  remove(ctx, receipt): Promise<RemovalResult>;
};
```

`availability` distinguishes available from unavailable-with-reason. Unavailability is not an
error when the harness is selected: it produces `pending`, retains desire, and can become
configured on a later `wire` after installation.

`resourceKey` identifies the physical registration independently of a worktree. Folder-scoped
resources include the normalized worktree root. Repository-shared resources identify the resolved
repository root and harness registration name. In-process resources return no physical key and
perform no external write.

`configure` and `remove` are idempotent. `remove` receives the successful receipt and may remove
only the fragments named there. Observation alone never grants deletion authority. The adapter
registry holds Claude Code, Codex, Cursor, and musterd entries; the reconciler contains no switch on
those names.

## 4. Reconciliation

`musterd wire` reads the saved desired set, registry, worktree receipts, machine ownership index,
and observed registrations. It produces and applies a stable plan in registry order.

For each adapter:

| desired | available | observed/owned | result |
|---|---:|---|---|
| yes | yes | correct | `unchanged` |
| yes | yes | absent or drifted | configure, then `configured` |
| yes | no | any | retain desire, `pending` |
| no | any | receipted folder resource | remove exact owned fragments, then `removed` |
| no | any | shared resource with other owners | release this owner, preserve resource, `released` |
| no | any | last-owned shared resource | remove exact resource, then release final receipt |
| no | any | unreceipted registration | preserve it, report `unmanaged` |

State commits follow the external side effect:

- A configure receipt and shared owner are recorded only after configuration succeeds.
- A folder receipt is deleted only after removal succeeds.
- Releasing a non-final shared owner updates the machine index atomically, then drops the local
  receipt.
- For a final shared owner, physical removal succeeds before the final owner and receipts are
  deleted.
- Any failure leaves the old receipt/ownership evidence retryable and exits nonzero.

Manifest and ownership-index writes use temp-file-plus-rename in their containing directory.
Concurrent index updates take the existing machine-local provisioning lock. A reconciler crash
therefore produces either the old valid state or the new valid state, never a partial JSON file.

The plan is conservative when state is inconsistent. It can recreate a selected registration from
known desired state, but it never adopts an existing registration as owned merely because it looks
equivalent. `harness status` explains the ambiguity; a future explicit adoption operation would
require its own decision.

## 5. Commands and interaction

### `musterd init`

After Team and Member setup, init shows one multi-select containing every registered harness:

- detected available harnesses are preselected;
- supported unavailable harnesses remain selectable and display their reason;
- the confirmed set is written locally and reconciled;
- unavailable selections finish as pending and do not make init fail.

The set can be empty. That is useful for a CLI-only human worktree and is not rewritten to a
default behind the user's back.

### `musterd harness configure`

This is the only interactive editor for the desired set. Existing selections are preselected.
Confirmation saves the new desired set and runs the same reconciler as `wire`; cancellation writes
nothing.

It is also the only old-schema conversion entry point. When it sees a legacy workspace or binding
with `surface`, it explains the clean break, removes that field while advancing the local schema,
and preselects the corresponding harness when one exists. The user confirms the whole set before
any write. There is no automatic conversion in init, status, join, wire, MCP startup, or another
ordinary command.

All other commands reject legacy local files with:

```text
this worktree uses the retired single-Surface configuration
run `musterd harness configure` to choose its harnesses
```

### `musterd harness status`

This command is read-only. One row per registry entry reports desired, availability, scope,
observed registration, ownership, and a concise repair. It exits nonzero only when state cannot be
parsed or a selected available harness is failed/drifted; pending unavailable selections are
healthy intent and exit zero.

### `musterd wire`

Wire is non-interactive. It requires a valid new-schema worktree and saved desired set, prints the
stable reconciliation plan/results, exits zero for configured/unchanged/pending states, and exits
nonzero if an attempted configure or removal fails. It never changes the desired set.

CLI wording and ANSI treatment are added to the terminal brief before implementation snapshots are
accepted. `Team`, `Member`, `Presence`, `Surface`, and `Act` retain their brand glossary meanings;
the UI calls these choices _harnesses_, never Surfaces.

## 6. Runtime Surface resolution

External registrations created by an adapter include a non-secret launch marker:

```text
MUSTERD_LAUNCH_SURFACE=claude-code | codex | cursor | ...
```

The marker says which harness owns the process launch. It does not contain Team, Member, or
credential identity. The native musterd harness supplies its Surface directly to the in-process
adapter and writes no launcher configuration.

Runtime resolution is strict and ordered:

1. an explicit operator `MUSTERD_SURFACE` override, for deliberate headless/testing use;
2. the harness-owned `MUSTERD_LAUNCH_SURFACE` marker;
3. a Surface supplied directly by an in-process harness.

The first present source wins, so a deliberate operator override remains possible. Launch-marker
and in-process sources are mutually exclusive; finding both without an override fails with a
diagnostic instead of guessing. Workspace and binding `surface` fields do not exist and are never
fallback inputs. Passive process-name or environment sniffing may support adapter availability
detection, but it cannot establish Presence Surface.

Once resolved, Surface is attached to the runtime Presence using the existing wire protocol. A
Member may therefore close one harness and later attach through another without any provisioning
write. Launching does not update desired state, receipts, ownership, workspace, or binding files.

## 7. Failure and repair behavior

- **Selected harness not installed:** status `pending`, exit zero, desire retained.
- **Selected harness install appears later:** next `wire` configures it without another prompt.
- **External config drift:** selected/owned entries are repaired idempotently; unowned entries are
  reported and preserved.
- **Removal fails:** exit nonzero; receipt and final shared owner remain so retry has authority.
- **Sibling worktree disappears:** its shared owner remains visible as stale; reconciliation does
  not silently delete another worktree's ownership. Explicit garbage collection is follow-on work.
- **Registry no longer knows a selected id:** parsing/reconciliation fails loudly. There is no
  compatibility alias or silent pruning.
- **Legacy workspace or binding:** only `harness configure` can convert it; all other paths stop.
- **No runtime Surface identity:** MCP startup refuses to join and names the missing launcher
  contract. It never substitutes a configured or previously used harness.

No failure mode rewrites the desired set as a repair.

## 8. Extensibility

The native musterd harness proves the `in-process` scope: it participates in selection and status
while configure/remove are no-ops and runtime Surface is supplied directly. A fixture adapter with
a novel id and scope proves the reconciler and command rendering depend on the registry contract,
not a closed union of current product names.

A future external harness chooses the narrowest true registration scope, supplies a stable resource
key and owned receipt, and injects its own launch marker. It does not add a workspace field or a new
Surface inference fallback.

## 9. Implementation surfaces

The implementation changes, in build order:

1. `@musterd/protocol`: versioned strict local workspace, binding, provisioning, ownership, and
   adapter-facing schemas; removal of local `surface` fields under ADR 281. Wire schemas unchanged.
2. CLI onboarding: registry contract, current harness adapters, ownership index, planner/executor,
   `init` multi-select, `harness configure`, `harness status`, and deterministic `wire`.
3. MCP adapter: strict launch-Surface resolution and registration marker propagation.
4. Native harness: registry entry and direct in-process Surface declaration.
5. Architecture and terminal design docs: current file/state lifecycle and exact CLI frames.

Implementation increments obey the repository build order and keep docs current in each commit.

## 10. Verification

### Unit contract

- every row in the reconciliation table, including retry after each side-effect failure;
- strict local schema versions, unknown ids/fields, and legacy rejection;
- deterministic plan and manifest serialization;
- receipt-bounded removal that preserves unrelated config;
- Surface source success, absence, and conflict;
- pending availability as exit zero and failed action as exit nonzero.

### Ownership integration

Using temporary machine config roots:

1. two sibling worktrees select one repository-shared harness;
2. one physical registration and two normalized owners exist;
3. the first deselection preserves the registration;
4. the final deselection removes only the receipted registration;
5. the same worktrees under a second machine root have independent selections and ownership.

### Sequential-switch acceptance

In one worktree, select Claude Code, Codex, Cursor, and musterd and reconcile once. Start and close
the same Member sequentially through each harness. Assert Presence Surfaces `claude-code`, `codex`,
`cursor`, and `musterd`, and byte-compare the workspace, binding, provisioning manifest, ownership
index, and harness config files before and after the four launches. No launch may invoke or require
wire.

### Extensibility and clean break

- a fixture future harness passes configure/status/remove without reconciler name changes;
- the native in-process harness is selectable without creating external config;
- old workspace and binding fixtures fail on every ordinary entry point with the prescribed
  command, then convert only through an explicitly confirmed `harness configure` session;
- no test asserts dual-read, automatic migration, inference fallback, or legacy output.

The milestone gates remain those in the execution contract: package tests during their increments,
Scenario B for external MCP harnesses, Scenario C for cross-Surface behavior, then the full build,
lint, and test definition of done.
