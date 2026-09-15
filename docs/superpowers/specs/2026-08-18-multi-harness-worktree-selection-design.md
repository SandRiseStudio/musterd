# Multi-harness worktree selection — configure once, switch by launching

- Date: 2026-08-18; revised 2026-08-19 after independent review
- Status: approved 2026-08-19 (nick)
- Decisions: [ADR 281](../../decisions/281-multi-harness-worktree-selection.md),
  [ADR 282](../../decisions/282-crash-safe-multi-harness-reconciliation.md), and
  [ADR 286](../../decisions/286-launcher-surface-convergence.md)
- Builds on: ADR 018 (workspace binding), ADR 026 (harness tool environment), ADR 027
  (non-invasive coexistence), ADR 030 (provisioning manifest), ADR 080 (committed launch spec), ADR
  116 (agent harness selection), ADR 143 (workspace-anchored identity), ADR 165 (universal MCP
  entry), ADR 213 (cross-worktree launch guard), ADR 251 (native harness), ADR 275
  (capture-attested Surface)
- Lane: `01M0B1DP6Z4GD249S026VB0368`

## Purpose

A human chooses the harnesses that should be available in a worktree on one machine, then opens that
worktree through Claude Code, Codex, Cursor, or musterd without changing configuration between
launches. Another human or machine may choose a different set for another checkout of the same Team.

The design separates three facts:

| fact | lifetime | source of truth |
|---|---|---|
| Team and Member binding | worktree | `.musterd/workspace.json` and `.musterd/binding.json` |
| desired harnesses and managed fragments | worktree × machine | `.musterd/provisioned.json` plus the machine fragment ledger |
| current Surface | Presence | explicit launcher identity |

No field serves two rows. In particular, desired harnesses never determine Presence Surface, and a
launch never changes desired harness state.

This is a clean runtime and local-schema break. There is no dual read, automatic migration, legacy
runtime output, or fallback to a previously declared Surface. A confirmed `harness configure` repair
is the single explicit conversion path for recognized local identity and registration state.

## Invariants

1. A worktree may desire zero, one, or several harnesses.
2. Selection is machine-local and never synchronized through Team state or committed files.
3. The same physical registration may have several worktree contributors on one machine.
4. Ownership exists only when musterd has durable fragment evidence; equivalent contents do not
   confer ownership.
5. Musterd never overwrites or removes an unowned or externally changed fragment.
6. Every external mutation is recoverable after a stop between external and local writes.
7. Runtime Surface comes from the launcher, not identity or provisioning files.
8. A future adapter is pluggable, but a new wire-level Surface still requires a protocol ADR.

## 1. Strict identity and local-state loading

`WorkspaceSpecSchema` and `BindingSchema` become explicit strict version-2 objects and remove
`surface`. `WorkspaceSpecSchema` is `{ version: 2, server, team, claim? }`.
`BindingSchema` retains local credentials, driver/autojoin policy, session capture, model declaration
and observation, and cached capabilities. The schema change is local; wire frames and `SPEC.md`'s
protocol version do not change.

Every loader returns a discriminated result instead of collapsing parse failures to absence:

```ts
type LocalLoad<T> =
  | { kind: 'missing' }
  | { kind: 'legacy'; value: unknown }
  | { kind: 'valid'; value: T }
  | { kind: 'invalid'; issues: readonly LocalStateIssue[] };
```

A recognized legacy identity is the previous otherwise-valid shape containing `surface`. An
unrecognized version, unknown field, malformed value, or invalid JSON is `invalid`, never `legacy`.
Ordinary CLI commands and MCP startup reject both with a specific repair message. Only
`musterd harness configure` can convert `legacy`, and only after the human confirms the complete
desired set.

Every local-state writer validates its complete intended object through the matching strict current
schema before canonical serialization, fsync, and atomic publish. A failed validation leaves the
previous file and prepared journal unchanged. The same boundary applies to adapter-owned container
representations before a scoped external replacement.

## 2. Worktree provisioning manifest

The ignored `.musterd/provisioned.json` advances to a strict new version:

```ts
type HarnessId = string; // non-empty bounded id; resolved against the installed CLI registry

type WorktreeProvisioning = {
  version: 2;
  role: string; // existing role-template projection; empty means generalist
  desired: HarnessId[]; // unique; serialized in CLI registry order
  contributions: Record<HarnessId, string[]>; // fragment resource keys owned by this worktree
  provisionedAt: string;
};
```

The protocol schema enforces uniqueness and shape only. It does not import the installed adapter
registry or sort `desired`; canonical registry ordering belongs to CLI serialization.

`contributions` is evidence that the worktree participates in machine-ledger ownership. It is not a
complete physical receipt and cannot authorize removal on its own. It stores no Team agent key,
grant, credential, config body, or environment value.

The explicit converter retains the version-1 `role` value. Version-1 `harness`, `mcpServers`,
`permissions`, and `guidance` lists do not become version-2 ownership evidence: their name-only
records cannot prove current contents. Existing physical fragments are re-observed as unmanaged
unless another valid ownership source exists.

Saving a new desired set happens before reconciliation. A stop immediately afterward leaves honest
intent plus incomplete work; the next `wire` resumes it. Reconciliation never rewrites desire as a
repair.

## 3. Machine fragment ledger

A chmod-600 ledger under the machine musterd config root owns cross-worktree coordination:

```ts
type FragmentLedger = {
  version: 1;
  fragments: Record<string, {
    harness: HarnessId;
    scope: 'folder' | 'repo-shared' | 'machine';
    containerKey: string;
    fragmentKey: string;
    fingerprint: string;
    owners: string[]; // normalized real worktree roots; sorted and unique
    adapterVersion: number;
  }>;
};
```

The map key is the stable fragment resource key. `containerKey` identifies the physical config
container for locking; `fragmentKey` identifies the independently managed subtree or marked block.
Examples include the `musterd` MCP entry, one permission item, one hook, or one generated guidance
file/block. Canonical fingerprints are adapter-defined SHA-256 hashes of the fragment representation,
not whole containing files.

Folder fragments include the normalized worktree root in their resource key. Repository-shared
fragments include the resolved repository root and registration identity. Machine fragments omit a
worktree/repository discriminator. The native in-process harness has no fragment ledger entries.

Owner paths are local coordination identifiers, not Team identity. Two machines have independent
ledger roots and independent owner sets even when their repository remotes are identical.

## 4. Write-ahead journal

The same machine config root contains strict per-operation journal records:

```ts
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

`HarnessLocks` is a cross-process recoverable lease keyed by `containerKey`, not an in-memory
mutex. Its record has an opaque holder id, PID, process-start identity, acquisition/renewal times,
and an expiry. The holder renews before expiry; a successor may reclaim an expired lease only after
confirming the recorded PID and process-start identity are no longer live. Where available, the
lease also holds a crash-releasing advisory file lock. A live unexpired holder reports `busy`; a
crashed holder cannot strand recovery.

One fragment mutation is one journaled operation. A harness that owns several fragments converges
one fragment at a time; a stop may leave a partially configured harness, but every completed
fragment remains attributable and the next run deterministically finishes the set.

The operation order is:

1. acquire or safely reclaim the recoverable lock keyed by `containerKey`;
2. recover any earlier journal for that container;
3. parse the latest containing config and observe the fragment;
4. compute the intended fragment and ownership delta;
5. write, fsync, and atomically publish the `prepared` journal;
6. re-read the containing config and apply the fragment patch to that latest valid parse;
7. atomically write the containing config;
8. persist the machine ledger and worktree contribution result;
9. remove the journal and release the lock.

Recovery observes the fragment and compares fingerprints:

| observation | recovery |
|---|---|
| equals `oldFingerprint` | retry the external mutation |
| equals `intendedFingerprint` | finalize ledger/contribution state |
| equals neither | report conflict; preserve journal and mutate nothing |

For `add-owner` and `release-owner`, old and intended fragment fingerprints are intentionally equal.
Recovery ignores that tie and idempotently writes `intendedOwners` plus the matching worktree
contribution state before clearing the journal.

The journal contains hashes and ownership metadata, not config bodies or secrets. Atomic JSON
replacement protects the journal and ledger from partial bytes; the journal closes the larger gap
between an external harness write and ownership persistence.

## 5. Adapter contract

The CLI owns one adapter registry:

```ts
type HarnessContext = {
  worktreeRoot: string;
  repoRoot?: string;
  machineConfigRoot: string;
  workspace?: WorkspaceSpec;
  binding?: Binding;
  fs: HarnessFileSystem;
  process: HarnessProcess;
  locks: HarnessLocks;
  clock: HarnessClock;
};

type HarnessContainer = {
  containerKey: string; // stable lock key; hashed for journal/lock filenames
  scope: 'folder' | 'repo-shared' | 'machine';
  handle: unknown; // adapter-private (a path, a CLI target, …)
};

type HarnessTarget = { containers: HarnessContainer[] };

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

`target` enumerates the physical containers this adapter manages fragments in — PLURAL, and each
fragment carries its own scope and container key: one adapter can touch multiple independently
locked containers (Claude Code's repo-shared MCP registration beside its folder-scoped hooks,
permissions, and guidance), matching ADR 282's frozen per-fragment ownership decision. There is no
adapter-level scope. The adapter keeps platform-specific paths and command details behind the
opaque container `handle`. `desiredFragments` is pure with respect to external configuration.
`observe` reads ONE fragment back as a canonical fingerprint (or absent / legacy-launch-marker /
invalid-container). `apply` performs one scoped, journaled fragment mutation against the latest
parse and refuses a changed expected container instead of writing from a stale snapshot.

The context makes roots and side effects explicit. Adapters do not call ambient `cwd`, homedir,
global process environment, time, or locks behind the reconciler's back. Tests can therefore build
two complete machine directory trees rather than pointing two cases at different config files in
one shared tree.

The adapter registry contains Claude Code, Codex, Cursor, and musterd. The reconciler contains no
conditional on those ids. The musterd adapter is in-process: it is selectable and visible in
status, returns an empty container set and no fragments, and supplies Surface directly when the
native host launches.

Harness ids are extensible strings. Adapter `surface` remains the closed protocol `Surface` union.
A fixture future adapter uses `other`; introducing a distinct Surface requires a separate protocol
ADR and version decision.

## 6. Observation and reconciliation states

Each desired fragment is classified independently:

| state | definition |
|---|---|
| `absent` | no fragment occupies the key |
| `owned-exact` | ledger ownership exists and the fingerprint matches |
| `owned-drifted` | ledger ownership exists but current contents differ |
| `unmanaged-equivalent` | intended contents exist without ownership evidence |
| `unmanaged-conflict` | the key exists with different contents and no ownership evidence |

The stable action matrix is:

| desired | state/ownership | action/result |
|---|---|---|
| yes | unavailable harness | retain desire; `pending` |
| yes | `absent` | journal create; `configured` |
| yes | `owned-exact` and this worktree owns | `unchanged` |
| yes | `owned-exact` but worktree is not an owner | journal owner addition; `contributed` |
| yes | `unmanaged-equivalent` | no mutation; `satisfied-unmanaged` |
| yes | `owned-drifted` or `unmanaged-conflict` | no mutation; `conflict` |
| no | this worktree is not an owner | `unchanged` |
| no | non-final owner | journal owner release; preserve fragment; `released` |
| no | final owner and `owned-exact` | journal removal; `removed` |
| no | final owner and `owned-drifted` | retain evidence; `release-blocked` |

Adding an owner to an `owned-exact` shared fragment changes only ledger and worktree contribution
state, but it is journaled because a stop between those two local stores must still recover.

The reconciler never adopts an unmanaged equivalent fragment. It is immediately usable because the
harness already has the intended configuration, but later deselection leaves it untouched. Explicit
adoption or force repair is outside this decision.

## 7. Commands

### `musterd init`

After Team and Member setup, init presents every registered harness as a multi-select. Detected
available harnesses are preselected. Supported unavailable harnesses remain selectable with a
reason and reconcile to `pending`. An empty set is valid. Confirmation saves desire and runs the
same reconciler as `wire`; cancellation writes nothing.

### `musterd harness configure`

This is the only desired-set editor. Existing selections are preselected. It is also the only
legacy converter: it parses the recognized old workspace/binding shape, removes `surface`, advances
the local schemas, and uses the corresponding adapter as a suggested selection only when one
exists. `cli`, `web`, or another non-harness Surface produces no guessed harness. The human confirms
the complete set before any conversion write.

### `musterd wire`

Wire is deterministic and non-interactive. It requires valid new identity and provisioning state,
recovers journals, then reconciles every registry entry in registry order. `pending`, `unchanged`,
`contributed`, `released`, and `satisfied-unmanaged` are successful outcomes. Configuration,
removal, parse, drift, or journal conflicts return nonzero. Wire never edits desire.

A fresh clone with committed workspace identity but no local provisioning manifest cannot infer a
harness and directs the human to `musterd harness configure`. This replaces ADR 080's one-Surface
self-wire and Claude Code fallback.

### `musterd harness status`

Status is read-only. It reports desired state, availability, scope, observed classification,
ownership/contribution state, pending journal recovery, and one next repair action for every
adapter. Pending unavailability exits zero. Invalid local state, conflicts, or a selected available
harness that is incomplete exit nonzero.

### `musterd uninstall`

Uninstall saves an empty desired set and reconciles all contributions before removing identity or
provisioning files. A non-final shared owner is released without touching the physical fragment.
The final owner removes only `owned-exact` contents. If a fragment is drifted, an external removal
fails, or local cleanup fails, uninstall returns nonzero and retains the manifest, ledger, and
journal evidence required to retry. Only complete release permits final binding/workspace/local-file
cleanup.

Exact command text and ANSI treatment are added to the terminal brief before CLI snapshots change.
The choices are called harnesses, never Surfaces; Team, Member, Presence, Surface, and Act retain
their brand glossary meanings.

## 8. Runtime Surface

Runtime resolution is explicit:

1. `MUSTERD_TEST_SURFACE`, when deliberately supplied for headless/testing use;
2. the command-owned intrinsic Surface (`cli` for ordinary CLI acts, `musterd` for native host);
3. `MUSTERD_LAUNCH_SURFACE` injected by an external harness registration.

Each execution path permits only its applicable intrinsic or launch source. Conflicting sources
without an explicit override fail instead of guessing. Every value is parsed through
`SurfaceSchema`. A manually started MCP adapter without a launch marker or override refuses to
join and explains the launcher contract.

`MUSTERD_SURFACE` is a retired registration marker and never a runtime input. `harness status`
classifies an external registration that carries it as `legacy-launch-marker` and directs the human
to `harness configure`. Only a human-confirmed configure repair can replace that recognized marker
with `MUSTERD_LAUNCH_SURFACE`, through the same fragment-scoped journal as every other external
change. Ordinary `wire` never silently converts it. This is not a compatibility fallback: the old
registration cannot attach a Presence until repaired.

`binding.session.harness` and `model_observed.harness` remain capture evidence for resumability and
model provenance, not Presence Surface inputs. Workspace and binding contain no persisted Surface.
This supersedes the Surface-ranking portion of ADR 275 while preserving ADR 143's rule that Member
identity resolves from the current worktree.

Launching may update allowed binding runtime fields: session capture, observed model, claim/grant,
driver/autojoin state when explicitly changed by their commands, and cached capabilities learned at
claim. It may not change workspace identity, desired harnesses, worktree contributions, machine
ownership, journal state, or managed fragment fingerprints.

## 9. Failure behavior

- Selected harness unavailable: retain desire and report `pending`.
- Harness becomes available: the next `wire` configures it without another prompt.
- Worktree identity missing: commands that require identity report `missing`, not legacy.
- Legacy identity: only `harness configure` may convert it.
- Malformed or unknown-version local state: fail as `invalid`; never treat it as absent.
- Desired harness id absent from the installed registry: retain desire and fail with an unknown-id
  repair message; never prune or alias it.
- Unmanaged equivalent: leave it usable and unowned.
- Unmanaged conflict or owned drift: preserve all contents and report the exact fragment key.
- Stop before external write: journal recovery retries.
- Stop after external write: journal recovery finalizes ownership.
- Ambiguous post-stop contents: preserve journal and stop.
- Sibling worktree disappears: its owner remains visible; garbage collection is follow-on work.
- Last-owner removal fails: retain final ownership and contribution evidence.
- No runtime Surface: refuse Presence attachment rather than use historical configuration.
- Retired `MUSTERD_SURFACE` marker: report `legacy-launch-marker`; only confirmed configure repair
  may replace it with `MUSTERD_LAUNCH_SURFACE`.
- Live container lease: report `busy` and mutate nothing; a stopped lease holder is reclaimed before
  journal recovery.
- Invalid intended local write: retain the previous valid file and prepared journal; report schema
  issues before publication.

No repair path silently changes the desired set, adopts contents, or discards ownership evidence.

## 10. Verification

### Schema and loader contract

- strict workspace, binding, manifest, ledger, and journal schemas;
- unknown fields and versions rejected;
- every ordinary reader distinguishes missing, legacy, and invalid;
- every local-state writer validates the strict complete schema before atomic publication;
- only confirmed `harness configure` converts a legacy fixture;
- protocol validates uniqueness while CLI tests registry-order serialization.

### Reconciliation matrix

- every desired/availability/observed row above;
- unmanaged equivalent is usable but never owned or removed;
- unmanaged conflict and owned drift preserve exact bytes;
- one harness with several fragments converges incrementally;
- a stop injected after every journal step recovers idempotently;
- a crashed lock holder is reclaimed, while a live holder reports `busy` without mutation;
- uninstall failure at every external and local cleanup step retains retry evidence;
- unrelated config entries survive every configure/remove/recovery path.

### Ownership integration

Build two independent temporary machine directory trees. In machine A, two sibling worktrees select
one repository-shared Claude Code registration: one physical fragment gains two owners, the first
deselection preserves it, and the final deselection removes it only when its fingerprint matches.
Machine B has its own checkout paths, config root, selection, ledger, locks, and journal and never
observes machine A's choices.

### Sequential-switch acceptance

In one worktree, select Claude Code, Codex, Cursor, and musterd and reconcile once. Launch and close
the same Member sequentially through all four. Assert Presence Surfaces `claude-code`, `codex`,
`cursor`, and `musterd`.

Before and after every launch:

- `workspace.json` is byte-identical;
- desired selections are byte-identical;
- worktree contributions, machine owner sets, and managed fragment fingerprints are semantically
  identical;
- no journal or config write occurs;
- binding differences contain only the explicit runtime-field allowlist.

The same acceptance begins with one fixture registration per external adapter carrying the retired
`MUSTERD_SURFACE` marker. It must not attach a Presence; status must name the repair; confirmed
configure must replace it with exactly one `MUSTERD_LAUNCH_SURFACE`; and the subsequent launch must
attach the adapter's Surface.

No launch invokes or requires `wire`.

### Extensibility and acceptance gates

- a fixture adapter with a novel harness id and Surface `other` passes configure/status/remove
  without reconciler name changes;
- the native adapter remains selectable without an external target;
- Scenario B passes for Claude Code and Codex against the same Team;
- Scenario C passes across CLI and MCP Surfaces;
- package build, typecheck, lint, formatting, unit, integration, and coverage gates remain green.

## 11. Documentation impact

Implementation updates the current architecture docs in the same commits as behavior:

- `02-protocol.md`: strict local schemas and the distinction from wire protocol;
- `04-cli.md`: state files, adapter/reconciler boundaries, commands, and removal lifecycle;
- `05-mcp.md`: launcher Surface contract and binding runtime writes;
- terminal brief: multi-select, status, conflict, recovery, and legacy-conversion frames.

Historical accepted Decisions remain frozen. ADR 281 receives only a Consequences note pointing to
ADR 282. Existing current-architecture prose that calls ADR 038 the harness-registry decision is
corrected to the actual lineage in ADR 026 and ADR 116.
