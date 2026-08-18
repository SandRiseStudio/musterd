# Multi-harness worktree selection implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this
> plan task-by-task. Do not use `superpowers:subagent-driven-development`: ADR 150 and this
> repository's execution contract require write work to remain in the claimed seat.

**Goal:** Let one worktree keep any locally selected set of harnesses configured and switch between
Claude Code, Codex, Cursor, and musterd by launching them, without rewiring workspace identity.

**Architecture:** Versioned protocol-owned local schemas remove Surface from workspace identity.
The CLI stores a machine-local desired harness set and ownership receipts, then a pure planner plus
idempotent executor reconciles adapter registrations. Each launcher declares runtime Surface; the
MCP adapter no longer infers it from workspace, binding, or session capture.

**Tech Stack:** TypeScript, Zod, Node filesystem APIs, `@clack/prompts`, OpenTelemetry, Vitest,
existing Claude/Codex/Cursor configuration renderers; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-18-multi-harness-worktree-selection-design.md`

## Global Constraints

- ADR 281 authorizes the local protocol-schema break; do not change a wire schema or protocol
  version.
- There is no dual read, automatic migration, legacy write, or Surface fallback. Only explicitly
  confirmed `musterd harness configure` converts legacy local files.
- Harness selection and shared-resource ownership are machine-local and never enter Team state.
- Parse every JSON file, launcher value, and command argument through protocol-owned Zod schemas at
  its boundary.
- Never log paths, config fragments, receipt bodies, team agent keys, grants, or credentials.
- A receipt licenses removal of exactly the recorded musterd-owned fragments; observation alone
  never licenses deletion.
- Pending unavailable harnesses are healthy intent and exit zero; attempted configure/removal
  failures retain retry evidence and exit nonzero.
- Preserve `Team`, `Member`, `Presence`, `Surface`, and `Act` glossary meanings and the brand ANSI
  map. CLI output must be added to `docs/design/figma-brief-terminal.md` before snapshots are
  accepted.
- Follow package build order: protocol must pass before CLI work begins; MCP work begins only after
  the CLI increment passes.
- Use TDD for every behavior change and finish each task with its focused test command and a seat-
  attributed commit containing `Refs ADR-281`.

---

## File structure

- `packages/protocol/src/binding.ts` — strict v2 workspace/binding identity schemas and explicit
  legacy conversion schemas; Surface is absent from v2.
- `packages/protocol/src/harnessProvisioning.ts` — harness id, scope, desired-set, receipt,
  provisioning-manifest, ownership-index, and launch-Surface schemas.
- `packages/protocol/src/binding.test.ts`, `packages/protocol/src/harnessProvisioning.test.ts` —
  clean-break and local-state boundary tests.
- `packages/protocol/src/index.ts` — exports the new local contracts.
- `packages/cli/src/onboard/harness.ts` — adapter lifecycle interfaces shared by every harness.
- `packages/cli/src/onboard/harnesses/{claudeCode,codex,cursor,musterd}.ts` — current adapter
  implementations, resource keys, observation, configuration, and receipt-bounded removal.
- `packages/cli/src/onboard/harnesses/index.ts` — stable adapter registry including native musterd.
- `packages/cli/src/onboard/mcpEntry.ts` — identity-free base MCP entry plus harness-owned
  `MUSTERD_LAUNCH_SURFACE` injection.
- `packages/cli/src/onboard/manifest.ts` — strict/atomic v2 worktree manifest reads and writes,
  including explicitly confirmed v1 conversion.
- `packages/cli/src/onboard/ownership.ts` — chmod-600 machine ownership index, normalized owners,
  atomic writes, and provisioning lock.
- `packages/cli/src/onboard/reconcile.ts` — pure stable planner and side-effect executor.
- `packages/cli/src/onboard/reconcile.test.ts`, `packages/cli/src/onboard/ownership.test.ts` — full
  transition matrix, retry semantics, sibling-worktree, and separate-machine tests.
- `packages/cli/src/commands/harness.ts` — `harness configure` and read-only `harness status`.
- `packages/cli/src/commands/harness.test.ts` — interaction, rendering, exit-code, and conversion
  tests.
- `packages/cli/src/commands/wire.ts`, `packages/cli/src/commands/wire.test.ts` — deterministic
  selected-set reconciliation and binding materialization.
- `packages/cli/src/onboard/init.ts`, `packages/cli/src/onboard/init.test.ts` — detected-by-default
  multi-select and shared reconciler use.
- `packages/cli/src/bin.ts`, `packages/cli/src/help/catalog.ts`, associated tests — dispatch and
  discoverability for the new command group.
- `packages/cli/src/commands/uninstall.ts` and tests — release every receipted harness before local
  state removal.
- `packages/mcp/src/config.ts`, `packages/mcp/src/binding.ts` — strict runtime Surface resolution
  and legacy-file rejection.
- `packages/mcp/src/launchSurface.ts`, `packages/mcp/src/launchSurface.test.ts` — pure resolution of
  operator, launcher, and in-process Surface sources.
- `packages/mcp/src/binding.test.ts`, `packages/mcp/src/surface-drift.test.ts` — no fallback or
  capture promotion.
- `tests/scenarios/multi-harness-switch.test.ts` — sequential same-Member acceptance with byte-stable
  configuration.
- `docs/architecture/{02-protocol,04-cli,05-mcp,06-testing}.md` and
  `docs/design/figma-brief-terminal.md` — current implementation, exact terminal frames, and tests.

### Task 1: Break local identity schemas cleanly

**Files:**
- Modify: `packages/protocol/src/binding.ts`
- Modify: `packages/protocol/src/binding.test.ts`
- Create: `packages/protocol/src/harnessProvisioning.ts`
- Create: `packages/protocol/src/harnessProvisioning.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `docs/architecture/02-protocol.md`

**Interfaces:**
- Produces: `WorkspaceSpecSchema`, `BindingSchema` with `version: 2` and no `surface`.
- Produces: `LegacyWorkspaceSpecSchema`, `LegacyBindingSchema`, used only by the interactive
  converter.
- Produces: `HarnessIdSchema`, `RegistrationScopeSchema`, `HarnessReceiptSchema`,
  `ProvisionManifestV2Schema`, `HarnessOwnershipIndexSchema`, and `LaunchSurfaceSchema`.

- [ ] **Step 1: Write failing v2 and legacy-isolation tests**

```ts
it('requires v2 identity and strips no unknown Surface field', () => {
  expect(() => WorkspaceSpecSchema.parse({ version: 2, server: URL, team: 'revive', surface: 'codex' }))
    .toThrow();
  expect(WorkspaceSpecSchema.parse({ version: 2, server: URL, team: 'revive' })).toEqual({
    version: 2, server: URL, team: 'revive',
  });
});

it('keeps legacy parsing outside the current schema', () => {
  const old = { server: URL, team: 'revive', surface: 'cursor' };
  expect(() => WorkspaceSpecSchema.parse(old)).toThrow();
  expect(LegacyWorkspaceSpecSchema.parse(old).surface).toBe('cursor');
});
```

- [ ] **Step 2: Run the protocol tests and verify red**

Run: `pnpm --filter @musterd/protocol test -- binding harnessProvisioning`

Expected: FAIL because the v2 and provisioning schemas do not exist and current identity still
requires `surface`.

- [ ] **Step 3: Implement strict local schemas**

```ts
export const HarnessIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const RegistrationScopeSchema = z.enum(['folder', 'repo-shared', 'machine', 'in-process']);
export const LaunchSurfaceSchema = SurfaceSchema;

export const OwnedFragmentsSchema = z.object({
  mcpServers: z.array(z.string()),
  permissions: z.object({
    allow: z.array(z.string()), ask: z.array(z.string()), deny: z.array(z.string()),
  }).strict(),
  guidance: z.object({ files: z.array(z.string()), contentVersion: z.number().int() }).strict()
    .optional(),
}).strict();

export const HarnessReceiptSchema = z.object({
  adapterVersion: z.literal(1),
  harness: HarnessIdSchema,
  scope: RegistrationScopeSchema,
  resourceKey: z.string().min(1).nullable(),
  owned: OwnedFragmentsSchema,
  lastAction: z.enum(['configured', 'unchanged', 'released', 'removed']),
  observed: z.enum(['configured', 'absent', 'drifted', 'in-process']),
  updatedAt: z.string().datetime(),
}).strict();

export const ProvisionManifestV2Schema = z.object({
  version: z.literal(2),
  role: z.string().optional(),
  desired: z.array(HarnessIdSchema),
  receipts: z.record(HarnessIdSchema, HarnessReceiptSchema),
  updatedAt: z.string().datetime(),
}).strict().superRefine(requireSortedUniqueDesired);

export const HarnessOwnershipIndexSchema = z.object({
  version: z.literal(1),
  resources: z.record(z.string().min(1), z.object({
    harness: HarnessIdSchema,
    owners: z.array(z.string()),
    receipt: HarnessReceiptSchema,
  }).strict().superRefine(requireSortedUniqueOwners)),
}).strict();
```

Implement `requireSortedUniqueDesired` and `requireSortedUniqueOwners` as pure refinements that
compare each array to a sorted `Set` copy. Add `version: z.literal(2)` to current identity schemas,
remove `surface`, and retain explicit legacy schemas only for Task 5's converter.

- [ ] **Step 4: Export and document the local-only contract**

Add `export * from './harnessProvisioning.js';` and update the protocol architecture file tree and
local-schema section. State explicitly that none of these types enter a frame or `SPEC.md`.

- [ ] **Step 5: Run the protocol package acceptance gate**

Run: `pnpm --filter @musterd/protocol test`

Expected: PASS, including strict unknown-field rejection and ≥95% protocol line coverage in the
repository coverage gate.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/protocol/src docs/architecture/02-protocol.md
git commit -m "feat(protocol): version local harness configuration" \
  -m "Refs ADR-281" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 2: Give every harness one lifecycle contract

**Files:**
- Modify: `packages/cli/src/onboard/harness.ts`
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts`
- Modify: `packages/cli/src/onboard/harnesses/codex.ts`
- Modify: `packages/cli/src/onboard/harnesses/cursor.ts`
- Create: `packages/cli/src/onboard/harnesses/musterd.ts`
- Modify: `packages/cli/src/onboard/harnesses/index.ts`
- Modify: `packages/cli/src/onboard/mcpEntry.ts`
- Modify: adapter and `mcpEntry` tests beside those files

**Interfaces:**
- Consumes: protocol `HarnessReceipt`, `RegistrationScope`, `Surface`.
- Produces: `HarnessContext`, `ObservedRegistration`, `Availability`, and `HarnessAdapter`.
- Produces: `buildEntry(surface: Surface): McpServerEntry` whose only default env field is
  `MUSTERD_LAUNCH_SURFACE`.

- [ ] **Step 1: Write failing contract tests for all four registry entries**

```ts
for (const adapter of HARNESSES) {
  expect(adapter).toMatchObject({
    id: expect.any(String), surface: expect.any(String),
    registrationScope: expect.stringMatching(/^(folder|repo-shared|machine|in-process)$/),
  });
  expect(typeof adapter.availability).toBe('function');
  expect(typeof adapter.resourceKey).toBe('function');
  expect(typeof adapter.observe).toBe('function');
  expect(typeof adapter.configure).toBe('function');
  expect(typeof adapter.remove).toBe('function');
}
expect(HARNESSES.map((h) => h.id)).toEqual(['claude-code', 'cursor', 'codex', 'musterd']);
```

Assert external entries contain their adapter's launch Surface and no identity/credential env;
assert native musterd has `in-process`, a null resource key, and no external write.

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @musterd/cli test -- harnesses mcpEntry`

Expected: FAIL on the missing lifecycle fields, native adapter, and launch marker.

- [ ] **Step 3: Define the adapter interfaces**

```ts
export interface HarnessContext {
  dir: string;
  entry: McpServerEntry;
  binding: Binding;
}
export interface Availability { available: boolean; reason?: string }
export interface ObservedRegistration {
  state: 'configured' | 'absent' | 'drifted' | 'in-process';
  ownedFragments: { mcpServers: string[]; permissions: ProvisionPermissions; files: string[] };
}
export interface Harness extends HarnessProvisioningCapabilities {
  id: HarnessId;
  label: string;
  surface: Surface;
  registrationScope: RegistrationScope;
  availability(ctx: HarnessContext): Promise<Availability>;
  resourceKey(ctx: HarnessContext): Promise<string | null>;
  observe(ctx: HarnessContext): Promise<ObservedRegistration>;
  configure(ctx: HarnessContext): Promise<HarnessReceipt>;
  remove(ctx: HarnessContext, receipt: HarnessReceipt): Promise<void>;
}
```

Extract the unchanged optional members into:

```ts
interface HarnessProvisioningCapabilities {
  guidance?: HarnessGuidance;
  provision?: (plan: ProvisionPlan, scope?: 'local' | 'shared') => Promise<ProvisionResult>;
  unprovision?: (plan: UnprovisionPlan, scope?: 'local' | 'shared') => Promise<void>;
  refreshHooks?: {
    applies: (dir: string) => boolean;
    run: (dir: string) => { files: string[]; warnings: string[] };
  };
  observeModel?: (payload: ModelObservationInput) => string | undefined;
}
```

Rename the current interface in place rather than maintaining a second lifecycle type; adapt doctor
callers to `availability` + `observe`.

- [ ] **Step 4: Adapt external harnesses and add receipt-bounded removal**

For each harness, wrap its existing detection/config rendering in the new context. Derive resource
keys from normalized folder or repository roots. Removal must call existing marker/server removal
helpers with `receipt.owned`, then re-observe absence; never remove an entry merely because it is
named `musterd`.

- [ ] **Step 5: Add native musterd and launch-marker construction**

```ts
export function buildEntry(surface: Surface): McpServerEntry {
  const launch = resolveMcpLaunch();
  return {
    command: launch.command,
    args: launch.args,
    env: { MUSTERD_LAUNCH_SURFACE: LaunchSurfaceSchema.parse(surface) },
  };
}
```

The native adapter returns `{ state: 'in-process', ownedFragments: emptyOwned }`, a successful
in-process receipt, and performs no filesystem or CLI write in configure/remove.

- [ ] **Step 6: Run focused adapter tests**

Run: `pnpm --filter @musterd/cli test -- harnesses mcpEntry`

Expected: PASS; user MCP entries and config sections survive all removal tests.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/cli/src/onboard
git commit -m "refactor(cli): define harness registration lifecycles" \
  -m "Refs ADR-281" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 3: Persist desired state and shared ownership atomically

**Files:**
- Modify: `packages/cli/src/onboard/manifest.ts`
- Modify: `packages/cli/src/onboard/manifest.test.ts`
- Create: `packages/cli/src/onboard/ownership.ts`
- Create: `packages/cli/src/onboard/ownership.test.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/config.test.ts`

**Interfaces:**
- Produces: `readProvisionManifestV2(dir, knownIds): ProvisionManifestV2 | null`; syntactically
  valid but unregistered desired/receipt ids fail with a repair error.
- Produces: `writeProvisionManifestV2(dir, manifest): string` using temp-file-plus-rename.
- Produces: `readLegacyProvisionManifest(dir): LegacyProvisionManifestV1 | null`, callable only by
  Task 5's interactive converter.
- Produces: `withOwnershipLock<T>(configRoot, fn): Promise<T>`, `claimOwner`, `releaseOwner`, and
  `ownersFor`.
- Produces: `readHarnessOwnershipIndex(root, knownIds)` and `writeHarnessOwnershipIndex(root,
  index)` with the same registry-id validation and atomic-write rules.

- [ ] **Step 1: Write failing manifest tests**

```ts
it('round-trips sorted desired state and receipts atomically', () => {
  writeProvisionManifestV2(dir, manifest({ desired: ['musterd', 'codex'] }));
  expect(readProvisionManifestV2(dir, knownIds)?.desired).toEqual(
    ['claude-code', 'codex', 'cursor', 'musterd']
      .filter((id) => ['musterd', 'codex'].includes(id)),
  );
});

it('does not let the ordinary reader accept v1', () => {
  writeRawManifest({ version: 1, role: 'generalist', harness: 'codex', mcpServers: [] });
  expect(() => readProvisionManifestV2(dir, knownIds)).toThrow(/run `musterd harness configure`/);
});
```

Add interrupted-rename, chmod, malformed JSON, unknown harness id, and exact preservation of legacy
role-provisioning receipt data during explicit conversion.

- [ ] **Step 2: Write failing ownership tests**

Use two sibling worktree paths and two temporary config roots. Assert path normalization, sorted
unique owners, one root's independence from the other, final-owner retention on failed cleanup, and
mode `0600`.

- [ ] **Step 3: Run focused tests and verify red**

Run: `pnpm --filter @musterd/cli test -- manifest ownership config`

Expected: FAIL because v2 state and ownership storage do not exist.

- [ ] **Step 4: Implement atomic manifest storage and explicit v1 conversion**

Use `openSync(..., 0o600)`, `writeFileSync`, `fsyncSync`, and `renameSync` in the target directory.
The ordinary reader throws the prescribed clean-break message for v1; the separately exported
legacy reader parses it only for a confirmed `harness configure` conversion and nests its
role/server/permission/guidance data unchanged in v2.

- [ ] **Step 5: Implement the owner-set index under the configurable musterd root**

```ts
export async function withOwnershipLock<T>(root: string, fn: () => Promise<T>): Promise<T>;
export function claimOwner(index: HarnessOwnershipIndex, key: string, harness: HarnessId,
  worktree: string, receipt: HarnessReceipt): HarnessOwnershipIndex;
export function releaseOwner(index: HarnessOwnershipIndex, key: string,
  worktree: string): { index: HarnessOwnershipIndex; remaining: string[] };
```

Follow the existing `withConfigLock` exclusive-create pattern: create a dedicated ownership lock
with `openSync(..., 'wx')`, bound retries, stale-owner recovery, and `finally` cleanup. Do not lock
the unrelated global config file and do not add a locking dependency.

- [ ] **Step 6: Run focused persistence tests**

Run: `pnpm --filter @musterd/cli test -- manifest ownership config`

Expected: PASS with hermetic temp roots and no writes to real `~/.musterd`.

- [ ] **Step 7: Commit Task 3**

```bash
git add packages/cli/src/onboard packages/cli/src/config.ts packages/cli/src/config.test.ts
git commit -m "feat(cli): persist selected harness ownership" \
  -m "Refs ADR-281" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 4: Reconcile the desired set with retry-safe side effects

**Files:**
- Create: `packages/cli/src/onboard/reconcile.ts`
- Create: `packages/cli/src/onboard/reconcile.test.ts`
- Modify: `packages/cli/src/onboard/doctor.ts`
- Modify: `packages/cli/src/onboard/doctor.test.ts`

**Interfaces:**
- Consumes: `HarnessAdapter[]`, v2 manifest, ownership index, `HarnessContext`.
- Produces: `planHarnessReconciliation(input): ReconcileAction[]` as a pure function.
- Produces: `reconcileHarnesses(input): Promise<ReconcileReport>`.
- `ReconcileResult` is exactly `configured | unchanged | pending | released | removed | unmanaged |
  failed`.

- [ ] **Step 1: Write the failing pure transition table**

```ts
it.each([
  ['yes', 'yes', 'correct', 'unchanged'],
  ['yes', 'yes', 'absent', 'configure'],
  ['yes', 'no', 'absent', 'pending'],
  ['no', 'yes', 'receipted-folder', 'remove'],
  ['no', 'yes', 'shared-other-owners', 'release'],
  ['no', 'yes', 'shared-last-owner', 'remove-shared'],
  ['no', 'yes', 'unreceipted', 'unmanaged'],
])('%s/%s/%s plans %s', (desired, available, observed, action) => {
  expect(planHarnessReconciliation(fixture({ desired, available, observed }))[0].action)
    .toBe(action);
});
```

- [ ] **Step 2: Write failing executor and failure-injection tests**

Assert configure records receipt/owner only after success; folder removal deletes receipt only after
success; non-final shared release preserves the physical resource; last-owner failure preserves the
owner and receipt; pending exits healthy; and registry order makes output deterministic.

- [ ] **Step 3: Run the focused reconciler tests and verify red**

Run: `pnpm --filter @musterd/cli test -- reconcile doctor`

Expected: FAIL on missing planner/executor and old one-harness doctor assumptions.

- [ ] **Step 4: Implement the pure planner**

```ts
export type ReconcileAction = {
  harness: HarnessId;
  action: 'configure' | 'unchanged' | 'pending' | 'remove' | 'release' |
    'remove-shared' | 'unmanaged';
  resourceKey: string | null;
};
```

The planner consumes already parsed observations and ownership only; it performs no I/O and emits
one action per registry entry in registry order.

- [ ] **Step 5: Implement the locked executor and safe commit ordering**

Execute one action at a time. Persist receipt/ownership after configure; persist deletion after
remove; for the final shared owner remove physically before dropping evidence. Catch per-adapter
errors into `failed` results, continue reporting remaining adapters, and return nonzero status if
any attempted side effect failed.

- [ ] **Step 6: Add per-harness reconciliation telemetry**

Create child spans under the existing CLI command span with only harness id, scope, abstract states,
planned action, result, and duration. Add a telemetry test that rejects path/config/receipt
attributes.

- [ ] **Step 7: Run the focused reconciler and doctor tests**

Run: `pnpm --filter @musterd/cli test -- reconcile doctor telemetry`

Expected: PASS across the full matrix and injected failures.

- [ ] **Step 8: Commit Task 4**

```bash
git add packages/cli/src/onboard
git commit -m "feat(cli): reconcile selected harness registrations" \
  -m "Refs ADR-281" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 5: Add complete harness commands, deterministic `wire`, and CLI contract

**Files:**
- Create: `packages/cli/src/commands/harness.ts`
- Create: `packages/cli/src/commands/harness.test.ts`
- Modify: `packages/cli/src/commands/wire.ts`
- Modify: `packages/cli/src/commands/wire.test.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/help/catalog.ts`
- Modify: `packages/cli/src/help/catalog.test.ts`
- Modify: `packages/cli/src/render/help.test.ts`
- Modify: `docs/design/figma-brief-terminal.md`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**
- Produces: `harnessCommand(parsed)` dispatching complete `status|configure` behavior.
- Produces: `renderHarnessStatus(report, json): string`.
- Produces: `selectHarnessIds(options): Promise<HarnessId[]>` through `p.multiselect`.
- Produces: `convertLegacyLocalState(dir, confirmedIds): ProvisionManifestV2`, reachable only from
  `harness configure` after confirmation.
- Changes: `wireCommand` calls `reconcileHarnesses` and never changes `desired`.

- [ ] **Step 1: Add exact terminal frames before snapshot code**

Add approved plain and ANSI frames for configured, pending, unmanaged, released, and failed rows;
the legacy two-line error; and wire's stable per-harness summary. Use the existing table-row and
success/warn/error components and brand colors.

- [ ] **Step 2: Write failing status/render/help tests**

```ts
expect(await harnessCommand(parseArgs(['status', '--json']))).toBe(0);
expect(JSON.parse(stdout())).toMatchObject({
  harnesses: [{ id: 'codex', desired: true, availability: 'available', state: 'configured' }],
});
expect(renderCommandHelp('harness')).toContain('configure|status');
```

Add snapshots matching the new terminal frames and assert pending exits zero while failed/drifted
selected available state exits nonzero. Add configure tests proving existing desired ids are
preselected, unavailable adapters remain selectable with reasons, cancellation writes nothing, and
an empty desired set is valid.

- [ ] **Step 3: Rewrite wire tests around saved desire**

Delete `harnessWiredFor`/`wireConfigures` expectations. Seed a v2 workspace, binding, and manifest;
assert all selected available adapters are reconciled, unavailable ones remain pending, JSON names
each result, and manifest `desired` is byte-identical before/after.

Add legacy fixtures for workspace, binding, and v1 provisioning manifest. Assert wire and status
reject them with the prescribed two-line error, while a confirmed configure converts all three and
preserves the v1 role/server/permission/guidance receipt inside v2.

- [ ] **Step 4: Run command tests and verify red**

Run: `pnpm --filter @musterd/cli test -- harness wire help`

Expected: FAIL on missing command/frames, missing explicit conversion, and one-Surface wire
behavior.

- [ ] **Step 5: Implement read-only status and deterministic wire**

Status loads/observes but never calls configure/remove or writes state. Wire validates v2 workspace,
materializes a v2 binding while carrying model/autojoin/driver/capabilities forward, builds one entry
per adapter Surface, invokes the reconciler, and returns failure only for failed actions.

- [ ] **Step 6: Implement configure and its one-time conversion transaction**

Render every registry entry through `p.multiselect`, with current desire preselected and unavailable
reasons visible. On a new-schema worktree, save the confirmed set and reconcile it. On legacy state,
read raw files only through protocol legacy schemas, preselect the adapter matching the old Surface,
and preserve v1 role-provisioning receipts. Render and validate all three replacements before
writing; use temp-file-plus-rename per file and restore original bytes after a synchronous write
failure. If the process dies between renames, the next `harness configure` recognizes the mixed
legacy/v2 set and resumes the same explicit conversion; ordinary commands still reject it.

- [ ] **Step 7: Dispatch and document the command**

Add `case 'harness': return harnessCommand(rest)` and catalog entry:

```ts
{
  name: 'harness', signature: '<configure|status> [--json]',
  summary: 'choose and inspect the harnesses configured for this worktree', group: 'setup',
}
```

Update CLI architecture file tree and command contracts in the same change.

- [ ] **Step 8: Run command tests and the CLI package test**

Run: `pnpm --filter @musterd/cli test -- harness wire help && pnpm --filter @musterd/cli test`

Expected: PASS with terminal snapshots matching the brief.

- [ ] **Step 9: Commit Task 5**

```bash
git add packages/cli/src docs/design/figma-brief-terminal.md docs/architecture/04-cli.md
git commit -m "feat(cli): report and reconcile selected harnesses" \
  -m "Refs ADR-281" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 6: Make init configure the selected harness set

**Files:**
- Modify: `packages/cli/src/onboard/init.ts`
- Modify: `packages/cli/src/onboard/init.test.ts`
- Modify: `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/commands/init.test.ts`

**Interfaces:**
- Consumes: registry availability and `reconcileHarnesses`.
- Consumes: Task 5's `selectHarnessIds`.
- Changes: init writes one v2 identity, provisions role tools/guidance into each selected available
  external harness, and records those owned fragments in each receipt.

- [ ] **Step 1: Write failing init multi-select tests**

Stub two available and one unavailable adapter. Assert available adapters are preselected, the
unavailable adapter remains selectable with its reason, an empty selection is accepted, and one
confirmed selection causes exactly one reconciliation pass after identity files are written.

- [ ] **Step 2: Write failing multi-harness provisioning tests**

Choose Claude Code, Codex, Cursor, and musterd. Assert role MCP servers, permissions, and stamped
guidance are applied to each capable selected external adapter; their exact fragments land in that
adapter's receipt; the common primer is written once; native musterd receives no external writes;
and an unavailable selection remains pending without blocking Member setup.

- [ ] **Step 3: Run init/configure tests and verify red**

Run: `pnpm --filter @musterd/cli test -- init harness wire`

Expected: FAIL on single-select init and one-adapter role/guidance provisioning.

- [ ] **Step 4: Replace init's single harness selection with `p.multiselect`**

Render all registry entries. Use `initialValues` from available detection, not configured state.
Write v2 workspace/binding without Surface, persist the confirmed desired set, then call the shared
reconciler. Do not skip identity/primer completion when all selected adapters are pending.

- [ ] **Step 5: Provision role tools and guidance per selected adapter**

Iterate selected available external adapters in registry order. Feed each adapter the same role
plan, write its guidance surface, and merge returned server/permission/file ownership into its
harness receipt. A failure is reported for that adapter without misreporting unattempted fragments
as owned. Write the common AGENTS primer once after reconciliation.

- [ ] **Step 6: Run init/configure tests and CLI package tests**

Run: `pnpm --filter @musterd/cli test -- init harness wire && pnpm --filter @musterd/cli test`

Expected: PASS, including cancellation and no-selection behavior.

- [ ] **Step 7: Commit Task 6**

```bash
git add packages/cli/src/onboard/init.ts packages/cli/src/onboard/init.test.ts \
  packages/cli/src/commands/init.ts packages/cli/src/commands/init.test.ts
git commit -m "feat(cli): select worktree harnesses together" \
  -m "Refs ADR-281" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 7: Resolve Presence Surface only from the launcher

**Files:**
- Create: `packages/mcp/src/launchSurface.ts`
- Create: `packages/mcp/src/launchSurface.test.ts`
- Modify: `packages/mcp/src/config.ts`
- Modify: `packages/mcp/src/binding.ts`
- Modify: `packages/mcp/src/binding.test.ts`
- Modify: `packages/mcp/src/surface-drift.test.ts`
- Modify: `packages/mcp/src/cursorCapture.test.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `packages/cli/src/host/backends/nativeBridge.ts`
- Modify: `packages/cli/src/host/backends/nativeBridge.test.ts`
- Modify: `docs/architecture/05-mcp.md`

**Interfaces:**
- Consumes: `LaunchSurfaceSchema`.
- Produces: `resolveLaunchSurface({ operator, launcher, inProcess }): Surface`.
- Changes: external `loadMcpConfig(env)` requires operator or launcher identity.
- Changes: `nativeMcpConfig` calls `resolveLaunchSurface({ inProcess: 'musterd' })` directly.

- [ ] **Step 1: Write failing pure resolution tests**

```ts
expect(resolveLaunchSurface({ operator: 'cursor', launcher: 'codex' })).toBe('cursor');
expect(resolveLaunchSurface({ launcher: 'codex' })).toBe('codex');
expect(resolveLaunchSurface({ inProcess: 'musterd' })).toBe('musterd');
expect(() => resolveLaunchSurface({ launcher: 'codex', inProcess: 'musterd' }))
  .toThrow(/conflicting runtime Surface sources/);
expect(() => resolveLaunchSurface({})).toThrow(/no runtime Surface identity/);
```

Add invalid enum input tests parsed at the boundary.

- [ ] **Step 2: Replace legacy binding/capture expectations with failing no-fallback tests**

Assert workspace/binding Surface fields fail parsing; session capture never changes
`config.surface`; heartbeat refresh updates model only; missing launch marker fails startup; explicit
`MUSTERD_SURFACE` remains the deliberate override above a marker.

- [ ] **Step 3: Run MCP tests and verify red**

Run: `pnpm --filter @musterd/mcp test -- launchSurface binding surface-drift cursorCapture`

Expected: FAIL because current config reads Surface from binding/spec and promotes capture.

- [ ] **Step 4: Implement strict launch resolution and remove inference**

```ts
export function resolveLaunchSurface(input: LaunchSurfaceInput): Surface {
  if (input.operator !== undefined) return LaunchSurfaceSchema.parse(input.operator);
  if (input.launcher !== undefined && input.inProcess !== undefined) {
    throw new Error('musterd MCP: conflicting runtime Surface sources');
  }
  const value = input.launcher ?? input.inProcess;
  if (value === undefined) throw new Error('musterd MCP: no runtime Surface identity');
  return LaunchSurfaceSchema.parse(value);
}
```

Delete binding/spec Surface reads, `occupancySurface` capture promotion, and Surface mutation from
`refreshAttestation`. Keep session capture for session/model evidence only. Native construction
passes the in-process value and creates no environment marker.

- [ ] **Step 5: Update MCP architecture and run its package acceptance gate**

Document operator > launcher/direct resolution, mutual exclusivity, no passive inference, and
Surface's Presence lifetime.

Run: `pnpm --filter @musterd/mcp test`

Expected: PASS, including Scenario-B-facing adapter startup fixtures.

- [ ] **Step 6: Commit Task 7**

```bash
git add packages/mcp/src packages/cli/src/host/backends docs/architecture/05-mcp.md
git commit -m "fix(mcp): take Surface identity from the launcher" \
  -m "Refs ADR-281" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 8: Uninstall every owned harness without disturbing siblings

**Files:**
- Modify: `packages/cli/src/commands/uninstall.ts`
- Modify: `packages/cli/src/commands/uninstall.test.ts`
- Modify: `packages/cli/src/onboard/guidance.ts`
- Modify: `packages/cli/src/onboard/guidance.test.ts`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**
- Consumes: worktree v2 receipts and `reconcileHarnesses` removal actions.
- Changes: uninstall clears the desired set and reconciles every receipt before removing local
  identity/provisioning files.

- [ ] **Step 1: Write failing multi-harness uninstall tests**

Seed Claude Code, Codex, Cursor, and native receipts plus unrelated user config. Assert all owned
folder resources are removed, the shared resource remains while a sibling owns it, native performs
no write, guidance is removed by stamps, and unrelated config is byte-preserved.

- [ ] **Step 2: Write a failing removal-error test**

Inject failure for the final shared removal. Assert uninstall exits nonzero and retains manifest,
receipt, and ownership index; it must not delete binding state and falsely claim completion.

- [ ] **Step 3: Run focused uninstall tests and verify red**

Run: `pnpm --filter @musterd/cli test -- uninstall guidance ownership`

Expected: FAIL because uninstall currently chooses one harness from manifest/binding Surface and
deletes state after best-effort removal.

- [ ] **Step 4: Implement all-receipt uninstall with hard failure semantics**

After confirmation, write `desired: []`, run the same reconciler, and stop on any `failed` result.
Only after every owned registration is removed/released should uninstall remove primer, stamped
guidance, binding, manifest, and local binding-registry entry.

- [ ] **Step 5: Run focused and full CLI tests**

Run: `pnpm --filter @musterd/cli test -- uninstall guidance ownership && pnpm --filter @musterd/cli test`

Expected: PASS with sibling ownership and retry evidence intact.

- [ ] **Step 6: Commit Task 8**

```bash
git add packages/cli/src/commands/uninstall.ts packages/cli/src/commands/uninstall.test.ts \
  packages/cli/src/onboard/guidance.ts packages/cli/src/onboard/guidance.test.ts \
  docs/architecture/04-cli.md
git commit -m "fix(cli): uninstall every owned harness safely" \
  -m "Refs ADR-281" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 9: Prove sequential switching and close the documentation loop

**Files:**
- Create: `tests/scenarios/multi-harness-switch.test.ts`
- Modify: `tests/scenarios/flagship.test.ts`
- Modify: `docs/architecture/06-testing.md`
- Modify: `docs/architecture/04-cli.md`
- Modify: `docs/architecture/05-mcp.md`
- Modify: `docs/implementation-plan.md` only if the Goal status changes

**Interfaces:**
- Consumes: final CLI registry/reconciler and MCP runtime Surface contract.
- Produces: hermetic sequential-switch scenario and future-adapter fixture proof.

- [ ] **Step 1: Write the failing sequential-switch scenario**

```ts
for (const surface of ['claude-code', 'codex', 'cursor', 'musterd'] as const) {
  const session = await launchFixtureHarness({ worktree, surface, member: 'Ada' });
  expect(await rosterSurface('Ada')).toBe(surface);
  await session.close();
  expect(snapshotConfigBytes(worktree, machineRoot)).toEqual(beforeLaunches);
}
```

The fixture configures all four once, records workspace/binding/manifest/index and external harness
config bytes, and asserts no launch invokes wire.

- [ ] **Step 2: Add the future-adapter and two-machine acceptance fixtures**

Register a test-only `future-harness` adapter and prove configure/status/remove without planner or
renderer name branches. Repeat selected-set setup under two config roots and prove no selection or
owner crosses roots.

- [ ] **Step 3: Run scenarios and verify red, then green**

Run first before the final wiring cleanup and record the expected failing assertion. Complete only
the smallest fixture seams required, then run:

`pnpm test:scenarios`

Expected: PASS, including Scenario C and the new sequential-switch scenario.

- [ ] **Step 4: Reconcile every living doc with the shipped behavior**

Update testing, CLI, and MCP architecture prose to the exact implemented commands, files, exit
codes, ownership behavior, and runtime resolution. Update architecture file-tree blocks for every
new source file. Do not edit `SPEC.md`: the wire protocol did not change.

- [ ] **Step 5: Run fast local gates before the final push**

Run: `pnpm typecheck && pnpm format:check`

Expected: PASS. Do not run the full suite locally merely to duplicate CI; the focused package and
scenario tests above are the implementation evidence, and CI `gates` is the full-suite authority.

- [ ] **Step 6: Commit Task 9**

```bash
git add tests/scenarios docs/architecture
git add docs/implementation-plan.md  # only when this task changed milestone state
git commit -m "test: prove harness switching without rewiring" \
  -m "Refs ADR-281" \
  -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```

### Task 10: Publish, merge, and submit the landed outcome

**Files:** none beyond any gate-driven corrections.

**Interfaces:**
- Produces: one squash-merged ADR-281 outcome and an `awaiting_acceptance` lane carrying PR/SHA
  evidence.

- [ ] **Step 1: Rebase onto current main if required**

```bash
git fetch origin main
git rebase origin/main
```

Resolve conflicts once, then rerun `pnpm typecheck && pnpm format:check` and push only with
`git push --force-with-lease` when rebasing changed published history.

- [ ] **Step 2: Mark PR 882 ready and enable squash auto-merge**

```bash
gh pr ready 882
gh pr merge 882 --squash --auto --delete-branch
```

Do not poll. CI `gates` owns the full `build → typecheck → test → coverage → format:check →
change-adr:check` decision.

- [ ] **Step 3: Submit the merged lane for outcome acceptance**

After merge notification, fetch the landed SHA and run the MCP `lane_submit` equivalent through the
active musterd channel with lane `01M0B1DP6Z4GD249S026VB0368`, PR `882`, landed SHA, and nick as the
authorizing human.

- [ ] **Step 4: Clear the local branch after merge**

```bash
git fetch origin main --prune
git switch --detach origin/main
git branch -D docs/adr-281-multi-harness-selection
```

Report the accepted design's material influence: workspace identity is Surface-free, desired
harnesses remain machine-local, and shared registration removal is owner- and receipt-gated.
