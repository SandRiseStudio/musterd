# Multi-Harness Worktree Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository policy forbids
> write-capable subagents, so execution stays inline in the owning musterd seat.

**Goal:** Let a human select any supported harness subset once per worktree and machine, then launch
the same Member through Claude Code, Codex, Cursor, or musterd without rewiring or changing the
stored Presence Surface.

**Architecture:** Strict versioned local schemas separate worktree identity, machine-local desired
harnesses, managed-fragment ownership, and runtime Surface. A fragment-oriented CLI reconciler uses
recoverable per-container leases plus write-ahead journals to patch only musterd-owned fragments;
external MCP launchers identify Surface solely with `MUSTERD_LAUNCH_SURFACE`, while CLI and native
musterd keep intrinsic Surfaces.

**Tech Stack:** TypeScript, Zod, Node.js built-in `fs`/`crypto`/`process` APIs, Vitest, JSON and
fragment-scoped TOML adapters. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-18-multi-harness-worktree-selection-design.md`

**Decisions:** ADR 281, ADR 282, and ADR 286.

## Global Constraints

- Follow package order: `@musterd/protocol` first, then `musterd` CLI, then `@musterd/mcp`.
  `@musterd/server` and the wire protocol are unchanged.
- Do not add a runtime dependency or change a protocol schema without a new ADR.
- Treat `WorkspaceSpec`, `Binding`, provisioning, ledger, journal, and lock files as strict external
  input. Every reader returns `missing | legacy | valid | invalid`; every writer validates the
  complete intended object before canonical serialization and atomic publication.
- Never derive Presence Surface from a workspace, binding, provisioning manifest, capture, model
  observation, or the retired `MUSTERD_SURFACE` variable.
- External harness adapters write exactly one Surface marker: `MUSTERD_LAUNCH_SURFACE`.
  `MUSTERD_TEST_SURFACE` is test/headless-only and no adapter writes it.
- Never adopt, overwrite, or remove an unowned, ambiguous, or drifted fragment. A version-1 receipt
  is not ownership evidence.
- Save a changed desired harness set before reconciliation. Reconciliation repairs actual state but
  never edits desire.
- Use explicit `HarnessContext` roots and injected filesystem, process, lock, and clock seams. Do
  not consult ambient cwd or home paths inside adapters or reconciliation.
- Preserve unrelated JSON keys, TOML bytes/sections, hooks, permissions, MCP entries, and guidance.
- Update architecture file trees and terminal documentation in the same commit as behavior.
- Use TDD for each task: establish a focused failing test, implement the minimum behavior, run the
  package acceptance test, then commit with `Co-authored-by: gptbot <gptbot@revive.musterd>`.
- Use `apply_patch` for source and documentation edits. Never run Prettier over `docs/`.
- Before each push run `pnpm typecheck && pnpm format:check`. CI remains authoritative for the full
  `build -> typecheck -> test -> coverage -> format:check -> change-adr:check` gate.

---

### Task 1: Define strict local-state contracts in protocol

**Files:**

- Modify: `packages/protocol/src/binding.ts`
- Modify: `packages/protocol/src/binding.test.ts`
- Create: `packages/protocol/src/provisioning.ts`
- Create: `packages/protocol/src/provisioning.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `docs/architecture/02-protocol.md`

**Interfaces:**

- Produces `HarnessIdSchema`, `HarnessId`, `LocalStateIssueSchema`, `LocalStateIssue`,
  `LocalLoad<T>`, `WorktreeProvisioningSchema`, `FragmentLedgerSchema`,
  `ReconcileJournalSchema`, and `HarnessLockRecordSchema`.
- Replaces workspace and binding local shapes with strict version-2 schemas that contain no
  `surface` field.
- Keeps `SurfaceSchema` unchanged and does not change `PROTOCOL_VERSION` or wire frames.

- [ ] **Step 1: Add failing strict-v2 identity tests.**

  In `binding.test.ts`, assert that the exact version-2 workspace and binding fixtures parse, then
  assert rejection of version 1, `surface`, unknown keys, malformed runtime fields, and fractional
  integer fields. Assert that `BindingSchema` still accepts the existing claim, grant, driver,
  autojoin, session, declared/observed model, and capability-cache fields.

  Run: `pnpm --filter @musterd/protocol test -- binding.test.ts`

  Expected: FAIL because the schemas still accept the old shape and require `surface`.

- [ ] **Step 2: Replace the local identity schemas.**

  Define the public shapes as:

  ```ts
  export const WorkspaceSpecSchema = z
    .object({
      version: z.literal(2),
      server: z.string(),
      team: z.string(),
      claim: ClaimPolicySchema.optional(),
    })
    .strict();

  export const BindingSchema = WorkspaceSpecSchema.extend({
      agent_key: z.string().optional(),
      grant: z.string().optional(),
      model: z.string().max(120).optional(),
      capabilities: CapabilitiesSchema.optional(),
      session: SessionCaptureSchema.optional(),
      model_observed: ModelObservationSchema.optional(),
      autojoin: z.boolean().optional(),
      driver: z.string().min(1).max(80).optional(),
    }).strict();
  ```

  Keep the current comments and refinements beside these fields so the local-only security and
  runtime semantics remain documented at their schema boundary.

- [ ] **Step 3: Add failing provisioning and recovery-state schema tests.**

  Cover:

  ```ts
  expect(HarnessIdSchema.safeParse('claude-code').success).toBe(true);
  expect(HarnessIdSchema.safeParse('future.harness_2').success).toBe(true);
  expect(HarnessIdSchema.safeParse('Claude Code').success).toBe(false);
  expect(HarnessIdSchema.safeParse('x'.repeat(65)).success).toBe(false);
  ```

  Add fixtures proving desired ids and owner paths must be unique, unknown harness ids remain valid,
  all objects reject unknown keys, journal fingerprints are nullable only where specified, and lock
  timestamps/PID/process-start identity are required.

  Run: `pnpm --filter @musterd/protocol test -- provisioning.test.ts`

  Expected: FAIL because `provisioning.ts` does not exist.

- [ ] **Step 4: Implement the local-state schemas and exports.**

  Use `HarnessIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)` and encode
  these exact persisted shapes:

  ```ts
  type WorktreeProvisioning = {
    version: 2;
    role: string;
    desired: HarnessId[];
    contributions: Record<HarnessId, string[]>;
    provisionedAt: string;
  };

  type FragmentLedger = {
    version: 1;
    fragments: Record<string, {
      harness: HarnessId;
      scope: 'folder' | 'repo-shared' | 'machine';
      containerKey: string;
      fragmentKey: string;
      fingerprint: string;
      owners: string[];
      adapterVersion: number;
    }>;
  };

  type ReconcileJournal = {
    version: 1;
    operationId: string;
    action: 'create' | 'remove' | 'add-owner' | 'release-owner';
    harness: HarnessId;
    containerKey: string;
    resourceKey: string;
    oldFingerprint: string | null;
    intendedFingerprint: string | null;
    oldOwners: string[];
    intendedOwners: string[];
    worktreeRoot: string;
    phase: 'prepared';
  };
  ```

  Define `HarnessLockRecord` with `version: 1`, opaque `holderId`, positive integer `pid`, nonempty
  `processStartedAt`, and ISO `acquiredAt`, `renewedAt`, and `expiresAt` values. Export all schemas and
  inferred types from `index.ts`.

- [ ] **Step 5: Run protocol acceptance and update the architecture tree.**

  Run: `pnpm --filter @musterd/protocol test`

  Expected: PASS, including existing act-meta, envelope round-trip, version-pin, and coverage gates.
  Add `provisioning.ts` to the drift-checked protocol file tree and describe it as strict local
  provisioning, ledger, journal, and lease contracts.

- [ ] **Step 6: Commit the protocol phase.**

  ```bash
  git add packages/protocol/src/binding.ts packages/protocol/src/binding.test.ts \
    packages/protocol/src/provisioning.ts packages/protocol/src/provisioning.test.ts \
    packages/protocol/src/index.ts docs/architecture/02-protocol.md
  git commit -m "feat(protocol): define multi-harness local state

  Co-authored-by: gptbot <gptbot@revive.musterd>"
  ```

### Task 2: Build validated local stores and recoverable leases

**Files:**

- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/config.test.ts`
- Modify: `packages/cli/src/onboard/manifest.ts`
- Modify: `packages/cli/src/onboard/manifest.test.ts`
- Create: `packages/cli/src/onboard/reconcile/context.ts`
- Create: `packages/cli/src/onboard/reconcile/store.ts`
- Create: `packages/cli/src/onboard/reconcile/store.test.ts`
- Create: `packages/cli/src/onboard/reconcile/lock.ts`
- Create: `packages/cli/src/onboard/reconcile/lock.test.ts`
- Modify: `packages/cli/src/machinePaths.ts`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**

- Consumes the schemas from Task 1.
- Produces `HarnessContext`, `loadWorkspace`, `loadBinding`, `loadProvisioning`, `loadLedger`,
  `loadJournal`, `loadLock`, their validating `save*` functions, `machineConfigRoot`, and
  `createHarnessLocks(deps)`.
- Uses these machine-local paths:
  `<machineConfigRoot>/harness-ledger.json`,
  `<machineConfigRoot>/harness-journal/<sha256(containerKey)>.json`, and
  `<machineConfigRoot>/harness-locks/<sha256(containerKey)>.lock`.

- [ ] **Step 1: Write loader classification tests.**

  For workspace, binding, manifest, ledger, journal, and lock, table-test absent files, prior valid
  versions, current valid versions, unknown versions, invalid JSON, malformed values, and unknown
  keys. Expected classifications are respectively `missing`, `legacy` only for recognized previous
  identity/manifest shapes, `valid`, and `invalid` for every other parse failure.

  Run: `pnpm --filter @musterd/cli test -- config.test.ts manifest.test.ts store.test.ts`

  Expected: FAIL because existing readers collapse invalid state to `null`.

- [ ] **Step 2: Implement discriminated readers and strict command wrappers.**

  Make low-level readers return `LocalLoad<T>`. Keep compatibility-named wrappers only where needed
  by existing callers: they may map `missing` to `null`, but must throw a repair diagnostic for
  `legacy` and `invalid`. Include the file kind and schema issues, never file contents or secrets.

- [ ] **Step 3: Write atomic-writer tests.**

  Inject a filesystem seam and assert each writer calls schema parse before any write, serializes
  stable key order with a trailing newline, writes a same-directory temporary file with mode `0600`,
  fsyncs the file, renames it, and fsyncs the parent directory. A rejected object must leave the old
  file and prepared journal byte-identical.

- [ ] **Step 4: Implement canonical validated stores.**

  Centralize canonical JSON and atomic publication in `store.ts`; do not add a package. Derive
  `machineConfigRoot` from `dirname(resolveConfigPath(env))`, so `MUSTERD_CONFIG` continues to isolate
  tests and two users on different machines naturally receive independent ledgers.

- [ ] **Step 5: Write lease behavior tests.**

  With an injected clock/process seam, assert:

  - a live, unexpired holder returns `busy`;
  - a dead, expired holder with the same PID but different process-start identity is reclaimable;
  - an expired but still-live exact process identity remains busy;
  - renewal extends expiry only for the matching holder id;
  - release from a different holder cannot delete the lease;
  - a stopped holder allows journal recovery after 30 seconds.

  Run: `pnpm --filter @musterd/cli test -- lock.test.ts`

  Expected: FAIL because no cross-process lease exists.

- [ ] **Step 6: Implement the recoverable lock.**

  Use a 30-second lease and renew every 10 seconds. The default process seam uses
  `process.kill(pid, 0)` plus POSIX `ps -o lstart= -p <pid>` to distinguish PID reuse; unknown
  liveness is busy, never reclaimable. Where a platform advisory lock is already available, hold it
  in addition to the lease; do not add a dependency solely for advisory locking.

- [ ] **Step 7: Run the CLI package tests and commit.**

  Run: `pnpm --filter @musterd/cli test`

  Expected: PASS. Update the CLI architecture tree with `reconcile/context.ts`, `store.ts`, and
  `lock.ts`, then commit:

  ```bash
  git add packages/cli/src/config.ts packages/cli/src/config.test.ts \
    packages/cli/src/machinePaths.ts packages/cli/src/onboard/manifest.ts \
    packages/cli/src/onboard/manifest.test.ts packages/cli/src/onboard/reconcile \
    docs/architecture/04-cli.md
  git commit -m "feat(cli): add validated harness state stores

  Co-authored-by: gptbot <gptbot@revive.musterd>"
  ```

### Task 3: Replace the single-harness adapter with fragment intents

**Files:**

- Modify: `packages/cli/src/onboard/harness.ts`
- Modify: `packages/cli/src/onboard/harnesses/index.ts`
- Create: `packages/cli/src/onboard/harnesses/musterd.ts`
- Create: `packages/cli/src/onboard/harnesses/musterd.test.ts`
- Create: `packages/cli/src/onboard/reconcile/fragments.ts`
- Create: `packages/cli/src/onboard/reconcile/fragments.test.ts`
- Modify: `docs/superpowers/specs/2026-08-18-multi-harness-worktree-selection-design.md`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**

- Consumes `HarnessContext` from Task 2.
- Produces:

  ```ts
  type HarnessContainer = {
    containerKey: string;
    scope: 'folder' | 'repo-shared' | 'machine';
    handle: unknown;
  };

  type HarnessTarget = { containers: HarnessContainer[] };

  type FragmentIntent = {
    harness: HarnessId;
    resourceKey: string;
    containerKey: string;
    fragmentKey: string;
    scope: 'folder' | 'repo-shared' | 'machine';
    fingerprint: string;
    payload: unknown;
  };

  type HarnessAdapter = {
    id: HarnessId;
    surface: Surface;
    adapterVersion: number;
    availability(ctx: HarnessContext): Promise<HarnessAvailability>;
    target(ctx: HarnessContext): Promise<HarnessTarget>;
    desiredFragments(ctx: HarnessContext, target: HarnessTarget): Promise<FragmentIntent[]>;
    observe(ctx: HarnessContext, intent: FragmentIntent): Promise<ObservedFragment>;
    apply(ctx: HarnessContext, mutation: FragmentMutation): Promise<void>;
  };
  ```

- [ ] **Step 1: Write registry and fingerprint tests.**

  Assert registry order is exactly `claude-code`, `cursor`, `codex`, `musterd`; a fixture adapter id
  `future.harness` resolves without protocol changes and maps to Surface `other`; canonical payloads
  with different object key order hash identically; and resource keys distinguish folder,
  repo-shared, and machine scope.

  Run: `pnpm --filter @musterd/cli test -- fragments.test.ts musterd.test.ts`

  Expected: FAIL against the current lifecycle-oriented adapter.

- [ ] **Step 2: Implement fragment types and canonical fingerprints.**

  Hash canonical fragment representations with SHA-256. Include normalized real worktree root in
  folder resource keys, resolved repository root plus registration identity in repo-shared keys, and
  no worktree/repository discriminator in machine keys.

- [ ] **Step 3: Implement the native adapter and common producer.**

  The selectable `musterd` adapter is always available, has `surface: 'musterd'`, and emits zero
  external fragments. Model the canonical `.musterd/skill/SKILL.md` and shared primer/guidance as an
  internal, non-selectable `musterd-core` fragment producer desired whenever the desired set is
  nonempty; its ledger owners remain normalized worktree roots.

- [ ] **Step 4: Correct the approved design sketch.**

  Replace the singular adapter `scope`/target sketch with `HarnessTarget.containers[]` and
  per-fragment scope/container keys. State that one adapter can touch multiple independently locked
  containers, matching ADR 282's frozen per-fragment ownership decision.

- [ ] **Step 5: Run CLI tests and commit.**

  Run: `pnpm --filter @musterd/cli test`

  Expected: PASS after existing adapter callers compile against temporary shims or the new contract.

  ```bash
  git add packages/cli/src/onboard/harness.ts packages/cli/src/onboard/harnesses/index.ts \
    packages/cli/src/onboard/harnesses/musterd.ts packages/cli/src/onboard/harnesses/musterd.test.ts \
    packages/cli/src/onboard/reconcile/fragments.ts \
    packages/cli/src/onboard/reconcile/fragments.test.ts \
    docs/superpowers/specs/2026-08-18-multi-harness-worktree-selection-design.md \
    docs/architecture/04-cli.md
  git commit -m "refactor(cli): model harnesses as managed fragments

  Co-authored-by: gptbot <gptbot@revive.musterd>"
  ```

### Task 4: Implement crash-safe fragment reconciliation

**Files:**

- Create: `packages/cli/src/onboard/reconcile/engine.ts`
- Create: `packages/cli/src/onboard/reconcile/engine.test.ts`
- Create: `packages/cli/src/onboard/reconcile/matrix.test.ts`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**

- Consumes adapter intents, local stores, and leases from Tasks 2-3.
- Produces `inspectHarnesses(ctx, desired): Promise<HarnessInspection[]>` and
  `reconcileHarnesses(ctx, desired, { legacyRepair }): Promise<ReconcileReport>`.
- `inspectHarnesses` is read-only. Only confirmed configure passes `legacyRepair: true`; `wire` and
  all other callers pass `false`.
- Emits one `musterd.provisioning.operation` span per inspected or reconciled fragment. Its
  allowlisted attributes are harness id, scope, desired/availability/observation classifications,
  planned action, journal recovery outcome, result, marker generation, and lock-recovery outcome;
  duration is the span duration. It must never attach paths, container/resource keys, configuration
  bodies, credentials, or owner roots.

- [ ] **Step 1: Encode the complete action matrix as failing table tests.**

  Cover every desired/observed/ownership row:

  | desired | observation | owners | result |
  |---|---|---|---|
  | yes | absent | none | journaled create + add owner |
  | yes | unmanaged-equivalent | none | `satisfied-unmanaged`, no ownership |
  | yes | unmanaged-conflict | none | conflict, no mutation |
  | yes | owned-exact | includes root | unchanged |
  | yes | owned-exact | excludes root | journaled add-owner |
  | yes | owned-drifted | any | conflict, retain evidence |
  | no | owned-exact | root plus others | journaled release-owner, keep fragment |
  | no | owned-exact | root only | journaled remove, then clear evidence |
  | no | owned-drifted | includes root | `release-blocked`, retain evidence |
  | no | unowned | none | unchanged |

  Add `legacy-launch-marker`: report repair-needed when `legacyRepair` is false; with true, replace
  only the marker as a journaled fragment mutation.

  Run: `pnpm --filter @musterd/cli test -- matrix.test.ts`

  Expected: FAIL because the reconciler does not exist.

- [ ] **Step 2: Implement read-only inspection and deterministic planning.**

  Registry-sort harnesses and fragment keys. Save no files and acquire no mutation lease from
  `inspectHarnesses`. In reconciliation, load the saved desired set and machine ledger, derive one
  action per fragment, and stop that fragment on busy, drift, unmanaged conflict, invalid container,
  or unrecoverable journal state. Start an operation span around each inspection/planned mutation
  through the existing CLI tracer; populate only the allowlisted structural attributes above, set an
  error status for failed/conflict/busy results, and always end it. Emit the same span for read-only
  `harness status` inspection so its durable diagnosis and trace evidence agree.

- [ ] **Step 3: Write stop-injection recovery tests.**

  Inject a stop after lease acquisition, journal publication, external write, ledger write,
  contribution write, and journal removal. On retry assert old fingerprint retries the mutation,
  intended fingerprint finalizes ownership, neither fingerprint preserves the journal and returns
  conflict, and owner-only operations converge to `intendedOwners` despite equal old/intended hashes.
  Install the existing in-memory OpenTelemetry exporter and assert one finished operation span per
  fragment has the action, recovery, result, marker-generation, and lock-recovery attributes but no
  path, resource key, owner root, config text, or credential.

- [ ] **Step 4: Implement the write-ahead operation sequence.**

  For each fragment: acquire/reclaim lease, recover an earlier journal, re-read and validate the
  latest container, calculate ownership delta, publish `prepared`, re-read again, apply a scoped
  patch, validate/write the container, validate/write ledger and contributions, clear journal, then
  best-effort release. Renew the lease during long adapter operations.

- [ ] **Step 5: Test unrelated content and multi-fragment partial progress.**

  Assert byte preservation outside an adapter-owned TOML block, semantic preservation outside JSON
  keys, deterministic resumption when one of several fragments completed, two sibling worktrees
  sharing one repo fragment, and two machine roots with no shared ledger or lock state.

- [ ] **Step 6: Run CLI tests and commit.**

  Run: `pnpm --filter @musterd/cli test`

  Expected: PASS.

  ```bash
  git add packages/cli/src/onboard/reconcile/engine.ts \
    packages/cli/src/onboard/reconcile/engine.test.ts \
    packages/cli/src/onboard/reconcile/matrix.test.ts docs/architecture/04-cli.md
  git commit -m "feat(cli): reconcile harness fragments crash-safely

  Co-authored-by: gptbot <gptbot@revive.musterd>"
  ```

### Task 5: Convert Claude Code, Cursor, and Codex adapters

**Files:**

- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts`
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.test.ts`
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.hooks.test.ts`
- Modify: `packages/cli/src/onboard/harnesses/claudeCodeProvision.test.ts`
- Modify: `packages/cli/src/onboard/harnesses/cursor.ts`
- Modify: `packages/cli/src/onboard/harnesses/cursor.detect.test.ts`
- Modify: `packages/cli/src/onboard/harnesses/cursor.hooks.test.ts`
- Modify: `packages/cli/src/onboard/harnesses/codex.ts`
- Modify: `packages/cli/src/onboard/harnesses/codex.test.ts`
- Modify: `packages/cli/src/onboard/harnesses/codexHooks.ts`
- Modify: `packages/cli/src/onboard/harnesses/codexHooks.test.ts`
- Modify: `packages/cli/src/onboard/harnesses/codexToml.ts`
- Modify: `packages/cli/src/onboard/harnesses/codexToml.test.ts`
- Modify: `packages/cli/src/onboard/guidance.ts`
- Modify: `packages/cli/src/onboard/guidance.test.ts`
- Modify: `packages/cli/src/onboard/mcpEntry.ts`
- Modify: `packages/cli/src/onboard/mcpEntry.test.ts`

**Interfaces:**

- Implements the Task 3 adapter contract for all external harnesses.
- Every external MCP fragment contains exactly its own `MUSTERD_LAUNCH_SURFACE` value and contains
  neither `MUSTERD_SURFACE` nor `MUSTERD_TEST_SURFACE`.

- [ ] **Step 1: Convert Claude Code tests and adapter.**

  Model its repo-shared MCP entry separately from folder hooks, permissions, and guidance. Assert
  the adapter preserves unrelated `claude mcp` servers/settings, emits fragment fingerprints for
  each managed unit, and identifies an old musterd entry with `MUSTERD_SURFACE` as
  `legacy-launch-marker`. Run:

  `pnpm --filter @musterd/cli test -- claudeCode.test.ts claudeCode.hooks.test.ts claudeCodeProvision.test.ts`

  Commit the passing conversion as `refactor(cli): reconcile Claude Code fragments` with the seat
  trailer.

- [ ] **Step 2: Convert Cursor tests and adapter.**

  Give `.cursor/mcp.json`, hooks, permissions, and guidance independent fragment keys. Parse and
  validate the complete JSON container before scoped replacement; preserve unrelated entries and
  their semantic values. Run:

  `pnpm --filter @musterd/cli test -- cursor.detect.test.ts cursor.hooks.test.ts guidance.test.ts`

  Commit as `refactor(cli): reconcile Cursor fragments` with the seat trailer.

- [ ] **Step 3: Convert Codex tests and adapter.**

  Keep the existing minimal TOML parser/writer, but expose the musterd MCP table, approvals, hooks,
  and guidance as distinct fragments. Assert unrelated TOML sections and bytes remain unchanged,
  including comments and ordering. Define a strict adapter-owned Codex container representation for
  the musterd tables/entries, parse the complete intended representation through it before every
  scoped replacement, and refuse an invalid env/table shape before opening the write path. Add a
  fixture whose invalid intended container leaves the prior TOML bytes unchanged. Run:

  `pnpm --filter @musterd/cli test -- codex.test.ts codexHooks.test.ts codexToml.test.ts`

  Commit as `refactor(cli): reconcile Codex fragments` with the seat trailer.

- [ ] **Step 4: Bind roles and common guidance across the full selection.**

  Update role projection so every selected available harness receives its relevant MCP,
  permissions, hooks, and guidance fragments. A deselected harness releases only that worktree's
  contribution. The canonical `musterd-core` skill/primer remains while any harness is desired.

- [ ] **Step 5: Bind the explicit legacy repair boundary.**

  For all three adapters, confirmed configure rewrites only a recognized retired marker to the
  corresponding launch marker. It does not adopt the rest of an unmanaged entry. Unselected or
  unrecognized old entries remain untouched and receive a manual repair diagnostic.

- [ ] **Step 6: Run CLI acceptance and commit the shared behavior.**

  Run: `pnpm --filter @musterd/cli test`

  Expected: PASS with fragment-level preservation and legacy fixtures for all external adapters.
  Commit remaining common files as `feat(cli): project roles across selected harnesses` with the
  seat trailer.

### Task 6: Add the harness commands and rework lifecycle commands

**Files:**

- Create: `packages/cli/src/commands/harness.ts`
- Create: `packages/cli/src/commands/harness.test.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/help/catalog.ts`
- Modify: `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/commands/init.test.ts`
- Modify: `packages/cli/src/onboard/init.ts`
- Modify: `packages/cli/src/onboard/init.test.ts`
- Modify: `packages/cli/src/commands/wire.ts`
- Modify: `packages/cli/src/commands/wire.test.ts`
- Modify: `packages/cli/src/commands/uninstall.ts`
- Modify: `packages/cli/src/commands/uninstall.test.ts`
- Modify: `packages/cli/src/onboard/doctor.ts`
- Modify: `packages/cli/src/onboard/doctor.test.ts`
- Modify: `docs/design/figma-brief-terminal.md`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**

- Adds `musterd harness configure` and `musterd harness status [--json]`.
- `configure` is the sole desired-set editor and legacy converter; `status` is read-only.
- `wire` consumes valid version-2 desire and never prompts or converts.

- [ ] **Step 1: Add failing command/output tests and terminal frames.**

  Define exact snapshots for multi-select configure, cancelled configure, read-only status, pending
  unavailable selections, unmanaged satisfaction, drift, busy, legacy marker, and release-blocked.
  Update the Figma terminal brief first in the same change so code snapshots implement an explicit
  frame rather than inventing copy.

- [ ] **Step 2: Implement `harness configure`.**

  Show all registry adapters in registry order. Preselect current version-2 desire. Keep unavailable
  adapters selectable but label them pending. For recognized legacy identity/manifest state,
  preselect only the corresponding former harness as a suggestion and require confirmation of the
  complete set. An empty set is valid. Cancellation exits 0 and writes nothing. Confirmation saves
  strict v2 workspace/binding/manifest state before calling reconciliation with
  `{ legacyRepair: true }`.

- [ ] **Step 3: Implement `harness status`.**

  Use only `inspectHarnesses`. Human output reports per harness: desired, availability, scope,
  observed state, ownership, pending journal/lock state, and next repair action. JSON exposes the
  same stable fields. Exit 0 only when every desired fragment is usable and every undesired owned
  contribution is released; otherwise exit 1. Preserve the engine's per-fragment operation spans;
  attach only aggregate count/exit-code attributes to the existing `musterd.cli.command` span, never
  a resource key, path, fragment text, credential, or owner root.

- [ ] **Step 4: Convert `init` to initial multi-selection.**

  Replace the single harness picker and single-harness wait with the same registry-ordered
  multi-select. Available harnesses start selected, unavailable harnesses remain selectable/pending,
  and empty is allowed. Save strict v2 identity and manifest, then project the chosen role across
  every selected adapter.

- [ ] **Step 5: Make `wire` noninteractive and desire-preserving.**

  Require valid v2 local state. If no manifest/selection exists, print the configure repair and exit
  6. Never edit desire or convert legacy state. Preserve legitimate binding runtime fields. JSON is:

  ```ts
  {
    team: string;
    member: string | null;
    desired: HarnessId[];
    results: ReconcileResult[];
    keyResolved: boolean;
    autojoin: boolean;
  }
  ```

  Preserve the reconciler's per-fragment operation spans and record only desired-count,
  result-count, and exit-code aggregates on the existing command span. Test configure, status, and
  wire together with an in-memory exporter so the planned action, journal recovery, result, marker
  generation, and lock-recovery attributes remain present through each command path.

- [ ] **Step 6: Make uninstall reconcile to empty before cleanup.**

  After confirmation, save desired `[]` and reconcile. Delete workspace, binding, and manifest only
  when all owned contributions are released and no journal remains. Any blocked fragment or cleanup
  failure returns nonzero and retains identity, manifest, ledger, and journal evidence for retry.

- [ ] **Step 7: Make doctor/check paths read-only.**

  `init --check` and doctor use inspection, report selection/configuration drift, and do not acquire
  mutation locks, repair markers, rewrite desire, or touch ownership.

- [ ] **Step 8: Run CLI package acceptance and commit.**

  Run: `pnpm --filter @musterd/cli test`

  Expected: PASS, including Scenario A and terminal snapshots. Update the CLI architecture tree and
  command documentation, then commit as `feat(cli): configure selected harnesses once` with the seat
  trailer.

### Task 7: Make MCP Surface launcher-only

**Files:**

- Modify: `packages/mcp/src/binding.ts`
- Modify: `packages/mcp/src/binding.test.ts`
- Modify: `packages/mcp/src/config.ts`
- Modify: `packages/mcp/src/mcp.test.ts`
- Modify: `packages/mcp/src/surface-drift.test.ts`
- Modify: `packages/mcp/src/scopeSurface.test.ts`
- Modify: `packages/mcp/src/cursorCapture.test.ts`
- Modify: `packages/mcp/src/workspace.ts`
- Modify: `packages/mcp/src/workspace.test.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/config.claimCredential.test.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/host/backends/nativeBridge.ts`
- Modify: `packages/cli/src/render/credentials.ts`
- Modify: `packages/cli/src/render/credentials.test.ts`
- Modify: `packages/cli/src/commands/team.ts`
- Modify: `packages/cli/src/commands/team.test.ts`
- Modify: `packages/cli/src/onboard/onboard.test.ts`
- Modify: `docs/architecture/05-mcp.md`

**Interfaces:**

- External MCP Surface resolution is `MUSTERD_TEST_SURFACE` first, then
  `MUSTERD_LAUNCH_SURFACE`; absence or invalid values refuse Presence attachment.
- CLI acts use intrinsic `cli`; native bridge uses intrinsic `musterd`.
- The retired `MUSTERD_SURFACE` is recognized only by CLI adapter inspection/repair from Task 5 and
  is never a runtime input.

- [ ] **Step 1: Add failing Surface-resolution tests.**

  Assert every valid launch marker resolves its matching Surface, the test marker overrides a launch
  marker, no marker refuses with `musterd harness configure`, an invalid marker refuses, and any
  presence of the old marker refuses even if a valid launch/test marker or a valid
  workspace/binding/capture/model observation is also present.

  Run: `pnpm --filter @musterd/mcp test -- mcp.test.ts surface-drift.test.ts scopeSurface.test.ts`

  Expected: FAIL because current resolution reads `MUSTERD_SURFACE`, binding/spec surface, and
  capture.

- [ ] **Step 2: Replace runtime Surface resolution.**

  Delete persisted/capture fallback and contested-surface mutation. Resolve once during startup from
  the explicit marker; binding refresh may update model/capture/capability fields but never
  `config.surface`. Record marker generation as `launch`, `test-override`, or `none` in existing
  telemetry without logging env contents.

- [ ] **Step 3: Update CLI/native/manual launch paths.**

  Remove env-based Surface choice from CLI claim credentials and label ordinary CLI calls `cli`.
  Keep native bridge's explicit `musterd`. Make manual external launch instructions emit
  `MUSTERD_LAUNCH_SURFACE`; headless tests use `MUSTERD_TEST_SURFACE`.

- [ ] **Step 4: Remove every runtime read of the retired marker.**

  Run:

  ```bash
  rg -n "MUSTERD_SURFACE" packages/cli/src packages/mcp/src
  ```

  Expected: matches only adapter legacy-observation fixtures/repair logic and explanatory diagnostics;
  no runtime config or launch writer match remains.

- [ ] **Step 5: Run MCP package acceptance and commit.**

  Run: `pnpm --filter @musterd/mcp test`

  Expected: PASS, including Scenario B's Claude Code then Codex attachment to the same Team. Update
  MCP architecture prose/tree and commit as `feat(mcp): derive Surface from the launcher` with the
  seat trailer.

### Task 8: Prove cross-machine selection and sequential switching

**Files:**

- Create: `tests/scenarios/multi-harness.test.ts`
- Modify: `tests/scenarios/flagship.test.ts`
- Modify: `docs/architecture/06-testing.md`
- Modify: drift-checked file trees in `docs/architecture/02-protocol.md`,
  `docs/architecture/04-cli.md`, and `docs/architecture/05-mcp.md` if final source paths changed
- Modify: `docs/design/figma-brief-terminal.md` only if final snapshot names differ from Task 6

**Interfaces:**

- Exercises only shipped commands and launcher contracts; it does not reach into reconciler internals.
- Establishes the live falsifier from the approved spec as automated acceptance.

- [ ] **Step 1: Add the two-machine, sibling-worktree fixture.**

  Create two genuine temporary machine config roots and two worktree roots. On machine A, give two
  sibling worktrees one repo-shared Claude registration and distinct folder fragments. On machine B,
  use an independent config root and desired subset. Assert selections, ledger owners, journals, and
  locks never cross machine roots.

- [ ] **Step 2: Add the four-Surface sequential launch scenario.**

  Configure one worktree for `claude-code`, `cursor`, `codex`, and `musterd` once. Launch the same
  Member sequentially through each launcher and assert Presence Surface is respectively
  `claude-code`, `cursor`, `codex`, and `musterd`, with no intervening `wire`.

- [ ] **Step 3: Assert state stability and conservative ownership.**

  Byte-compare workspace, provisioning, ledger, and harness registrations before/after launches.
  Permit only the spec's explicit binding runtime fields to change. Deselect one sibling and prove
  the shared registration remains; deselect the final exact owner and prove only the owned fragment
  disappears. Prove unmanaged-equivalent, unmanaged-conflict, and owned-drifted fragments survive.

- [ ] **Step 4: Exercise rollout and extensibility.**

  Start from each external adapter's old marker fixture. Assert it cannot attach Presence, status
  says `legacy-launch-marker`, and a human-confirmed configure repairs it before the runtime break is
  exercised. Register a fixture-only `future.harness` adapter and assert it participates in selection
  and reconciliation while attaching as `other`.

- [ ] **Step 5: Run package and repository gates.**

  Run in build order:

  ```bash
  pnpm --filter @musterd/protocol test
  pnpm --filter @musterd/cli test
  pnpm --filter @musterd/mcp test
  pnpm test:scenarios
  pnpm typecheck
  pnpm format:check
  ```

  Expected: all pass locally at the prescribed package scope. Do not run the full repository suite
  locally as a substitute for CI.

- [ ] **Step 6: Commit acceptance, publish, and let CI land the lane.**

  Rebase onto fresh `origin/main`, rerun the fast gates, and push with `--force-with-lease`. Update
  draft PR #882 with the implementation/rollout summary, mark it ready, and enable squash auto-merge.
  The rollout note must say that each existing worktree's human runs `musterd harness configure`
  before reloading an affected external registration and must not rely on that registration's
  musterd messaging to coordinate the repair.

  After the PR is squash-merged, submit lane `01M0B1DP6Z4GD249S026VB0368` with the landed PR/SHA and
  authorization, request counterpart outcome acceptance, then detach at fresh `origin/main` and
  delete the local feature branch.
