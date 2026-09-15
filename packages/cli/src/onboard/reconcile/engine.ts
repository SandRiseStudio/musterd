import { randomUUID } from 'node:crypto';
import type {
  FragmentLedger,
  HarnessId,
  LedgerFragment,
  ReconcileJournal,
  Surface,
} from '@musterd/protocol';
import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import { harnessAdapters } from '../harnesses/index.js';
import { musterdCoreAdapter } from '../harnesses/musterd.js';
import { loadProvisioning, saveProvisioning } from '../manifest.js';
import type { HarnessContext } from './context.js';
import {
  registryOrder,
  type FragmentIntent,
  type HarnessAdapter,
  type HarnessAvailability,
  type ObservedFragment,
} from './fragments.js';
import { createHarnessLocks, type HarnessLease } from './lock.js';
import {
  loadJournal,
  loadLedger,
  loadLockRecord,
  removeJournal,
  saveJournal,
  saveLedger,
} from './store.js';

/**
 * The crash-safe fragment reconciler (ADR 282, hardened by ADR 286). One fragment mutation is one
 * journaled operation under one container lease: acquire/reclaim, recover any earlier journal,
 * re-read the latest container, plan from the action matrix, publish the `prepared` journal, apply
 * the scoped patch, persist ledger + contribution, clear the journal, release. A stop anywhere
 * leaves a deterministic resume; recovery compares the observed fragment against the journal's
 * old/intended fingerprints (retry / finalize / conflict).
 *
 * Reconciliation repairs ACTUAL state and never edits desire: the desired set is saved by the
 * caller (configure/init/uninstall) before this runs, and nothing here writes it.
 */

export type PlannedAction =
  | 'none'
  | 'create'
  | 'add-owner'
  | 'release-owner'
  | 'remove'
  | 'repair-launch-marker';

export type FragmentResultKind =
  | 'applied'
  | 'unchanged'
  | 'satisfied-unmanaged'
  | 'conflict'
  | 'release-blocked'
  | 'repair-needed'
  | 'busy'
  | 'invalid-container'
  | 'pending'
  | 'failed';

export type JournalRecovery = 'none' | 'retried' | 'finalized' | 'conflict';

export interface ReconcileResult {
  harness: HarnessId;
  resourceKey: string;
  scope: string;
  action: PlannedAction;
  result: FragmentResultKind;
  recovery: JournalRecovery;
  detail?: string;
}

export interface ReconcileReport {
  results: ReconcileResult[];
  /** True iff nothing conflicted, failed, stayed busy, or still needs repair. */
  ok: boolean;
}

export type ObservationKind =
  | 'absent'
  | 'unmanaged-equivalent'
  | 'unmanaged-conflict'
  | 'owned-exact'
  | 'owned-drifted'
  | 'legacy-launch-marker'
  | 'invalid-container';

export interface FragmentInspection {
  harness: HarnessId;
  resourceKey: string;
  fragmentKey: string;
  scope: string;
  desired: boolean;
  observation: ObservationKind;
  owners: string[];
  ownedHere: boolean;
  plan: PlannedAction;
  planned: FragmentResultKind;
  journal: 'none' | 'pending' | 'invalid';
  lock: 'free' | 'held' | 'invalid';
}

export interface HarnessInspection {
  harness: HarnessId;
  surface: Surface;
  desired: boolean;
  availability: HarnessAvailability;
  fragments: FragmentInspection[];
}

export interface EngineOptions {
  /** Adapter registry override (tests, fixtures). Defaults to the shipped registry. */
  registry?: HarnessAdapter[];
  /**
   * Internal, non-selectable fragment producers, desired whenever the selection is nonempty
   * (ADR 281: the canonical musterd-core skill/primer remains while ANY harness is desired).
   * Defaults to musterd-core — except under a `registry` override, where fixtures opt in.
   */
  producers?: HarnessAdapter[];
  tracer?: Tracer;
}

export interface ReconcileOptions extends EngineOptions {
  /** Only confirmed `harness configure` passes true; `wire` and every other caller pass false. */
  legacyRepair: boolean;
}

const OP_SPAN = 'musterd.provisioning.operation';

function tracerOf(opts?: EngineOptions): Tracer {
  return opts?.tracer ?? trace.getTracer('musterd-cli');
}

/** The selectable registry plus the internal producers, each tagged with its desire rule. */
function enginePlan(
  desired: readonly string[],
  opts?: EngineOptions,
): { adapter: HarnessAdapter; desired: boolean; selectable: boolean }[] {
  const registry = registryOrder(opts?.registry ?? harnessAdapters());
  const producers = opts?.producers ?? (opts?.registry ? [] : [musterdCoreAdapter]);
  return [
    ...registry.map((adapter) => ({
      adapter,
      desired: desired.includes(adapter.id),
      selectable: true,
    })),
    ...producers.map((adapter) => ({ adapter, desired: desired.length > 0, selectable: false })),
  ];
}

/** The fingerprint an observation carries, or null for absent. */
function observedFingerprint(observed: ObservedFragment): string | null {
  return observed.state === 'present' || observed.state === 'legacy-launch-marker'
    ? observed.fingerprint
    : null;
}

interface Classified {
  observation: ObservationKind;
  plan: PlannedAction;
  planned: FragmentResultKind;
}

/**
 * The frozen action matrix (ADR 282 §6). Pure: desired × observation × ledger ownership → the one
 * planned action and its result classification. `legacyRepair` gates the single marker repair.
 */
export function classifyFragment(
  desired: boolean,
  observed: ObservedFragment,
  ledger: LedgerFragment | undefined,
  worktreeRoot: string,
  intentFingerprint: string | null,
  legacyRepair: boolean,
): Classified {
  if (observed.state === 'invalid-container') {
    return { observation: 'invalid-container', plan: 'none', planned: 'invalid-container' };
  }
  if (observed.state === 'legacy-launch-marker') {
    return legacyRepair && desired
      ? { observation: 'legacy-launch-marker', plan: 'repair-launch-marker', planned: 'applied' }
      : { observation: 'legacy-launch-marker', plan: 'none', planned: 'repair-needed' };
  }
  const fp = observedFingerprint(observed);
  const ownedHere = ledger?.owners.includes(worktreeRoot) ?? false;
  if (!ledger) {
    // Unowned: equivalence is not ownership evidence; conflict is not ours to overwrite.
    if (desired) {
      if (fp === null) return { observation: 'absent', plan: 'create', planned: 'applied' };
      if (fp === intentFingerprint) {
        return {
          observation: 'unmanaged-equivalent',
          plan: 'none',
          planned: 'satisfied-unmanaged',
        };
      }
      return { observation: 'unmanaged-conflict', plan: 'none', planned: 'conflict' };
    }
    return {
      observation: fp === null ? 'absent' : 'unmanaged-conflict',
      plan: 'none',
      planned: 'unchanged',
    };
  }
  const drifted = fp !== ledger.fingerprint;
  if (drifted) {
    // Owned but the physical fragment no longer matches our evidence (edited or deleted): never
    // overwrite or remove — retain the evidence and stop.
    return desired
      ? { observation: 'owned-drifted', plan: 'none', planned: 'conflict' }
      : ownedHere
        ? { observation: 'owned-drifted', plan: 'none', planned: 'release-blocked' }
        : { observation: 'owned-drifted', plan: 'none', planned: 'unchanged' };
  }
  if (desired) {
    if (intentFingerprint !== null && intentFingerprint !== ledger.fingerprint) {
      // Owned-exact but the desired representation moved (adapter/content version): safe update.
      return { observation: 'owned-exact', plan: 'create', planned: 'applied' };
    }
    return ownedHere
      ? { observation: 'owned-exact', plan: 'none', planned: 'unchanged' }
      : { observation: 'owned-exact', plan: 'add-owner', planned: 'applied' };
  }
  if (!ownedHere) return { observation: 'owned-exact', plan: 'none', planned: 'unchanged' };
  const others = ledger.owners.filter((o) => o !== worktreeRoot);
  return others.length > 0
    ? { observation: 'owned-exact', plan: 'release-owner', planned: 'applied' }
    : { observation: 'owned-exact', plan: 'remove', planned: 'applied' };
}

/** Allowlisted span attributes ONLY (ADR 282 O&E): classifications and outcomes — never a path,
 *  container/resource key, config body, credential, or owner root. */
function setOperationAttributes(
  span: Span,
  attrs: {
    harness: string;
    scope: string;
    desired: boolean;
    availability: 'available' | 'unavailable';
    observation: ObservationKind | 'unknown';
    action: PlannedAction;
    recovery: JournalRecovery;
    result: FragmentResultKind | 'inspected';
    markerGeneration: 'launch' | 'legacy' | 'none';
    lockRecovery: 'none' | 'reclaimed' | 'busy' | 'invalid';
  },
): void {
  span.setAttribute('musterd.harness', attrs.harness);
  span.setAttribute('musterd.scope', attrs.scope);
  span.setAttribute('musterd.desired', attrs.desired);
  span.setAttribute('musterd.availability', attrs.availability);
  span.setAttribute('musterd.observation', attrs.observation);
  span.setAttribute('musterd.action', attrs.action);
  span.setAttribute('musterd.journal_recovery', attrs.recovery);
  span.setAttribute('musterd.result', attrs.result);
  span.setAttribute('musterd.marker_generation', attrs.markerGeneration);
  span.setAttribute('musterd.lock_recovery', attrs.lockRecovery);
}

function markerGeneration(observation: ObservationKind | 'unknown'): 'launch' | 'legacy' | 'none' {
  if (observation === 'legacy-launch-marker') return 'legacy';
  if (observation === 'owned-exact' || observation === 'unmanaged-equivalent') return 'launch';
  return 'none';
}

function ledgerFragments(ctx: HarnessContext): Record<string, LedgerFragment> {
  const got = loadLedger(ctx.fs, ctx.machineConfigRoot);
  return got.kind === 'valid' ? got.value.fragments : {};
}

/** A release pseudo-intent reconstructed from ledger evidence (no payload — observation only). */
function releaseIntent(resourceKey: string, entry: LedgerFragment): FragmentIntent {
  return {
    harness: entry.harness,
    resourceKey,
    containerKey: entry.containerKey,
    fragmentKey: entry.fragmentKey,
    scope: entry.scope,
    fingerprint: entry.fingerprint,
    payload: undefined,
  };
}

/** Enumerate the fragments one adapter is answerable for: its desired intents plus every ledger
 *  fragment of its harness this worktree still owns (the release candidates). */
async function fragmentsFor(
  ctx: HarnessContext,
  adapter: HarnessAdapter,
  desired: boolean,
  available: boolean,
): Promise<{ intent: FragmentIntent; desired: boolean }[]> {
  const out: { intent: FragmentIntent; desired: boolean }[] = [];
  const seen = new Set<string>();
  if (desired && available) {
    const target = await adapter.target(ctx);
    for (const intent of await adapter.desiredFragments(ctx, target)) {
      out.push({ intent, desired: true });
      seen.add(intent.resourceKey);
    }
  }
  for (const [resourceKey, entry] of Object.entries(ledgerFragments(ctx))) {
    if (entry.harness !== adapter.id || seen.has(resourceKey)) continue;
    if (!entry.owners.includes(ctx.worktreeRoot)) continue;
    out.push({ intent: releaseIntent(resourceKey, entry), desired });
  }
  return out;
}

/** Read-only inspection: no file saves, no mutation lease (ADR 282). Same spans as reconciliation
 *  so `harness status`'s durable diagnosis and trace evidence agree. */
export async function inspectHarnesses(
  ctx: HarnessContext,
  desired: readonly string[],
  opts?: EngineOptions,
): Promise<HarnessInspection[]> {
  const tracer = tracerOf(opts);
  const inspections: HarnessInspection[] = [];
  for (const { adapter, desired: isDesired } of enginePlan(desired, opts)) {
    const availability = await adapter.availability(ctx);
    const fragments: FragmentInspection[] = [];
    for (const { intent, desired: fragmentDesired } of await fragmentsFor(
      ctx,
      adapter,
      isDesired,
      availability.available,
    )) {
      const span = tracer.startSpan(OP_SPAN);
      try {
        const entry = ledgerFragments(ctx)[intent.resourceKey];
        const observed = await adapter.observe(ctx, intent);
        const classified = classifyFragment(
          fragmentDesired,
          observed,
          entry,
          ctx.worktreeRoot,
          fragmentDesired ? intent.fingerprint : null,
          false,
        );
        const journalState = loadJournal(ctx.fs, ctx.machineConfigRoot, intent.containerKey);
        const lockState = loadLockRecord(ctx.fs, ctx.machineConfigRoot, intent.containerKey);
        const inspection: FragmentInspection = {
          harness: adapter.id,
          resourceKey: intent.resourceKey,
          fragmentKey: intent.fragmentKey,
          scope: intent.scope,
          desired: fragmentDesired,
          observation: classified.observation,
          owners: entry?.owners ?? [],
          ownedHere: entry?.owners.includes(ctx.worktreeRoot) ?? false,
          plan: classified.plan,
          planned: classified.planned,
          journal:
            journalState.kind === 'missing'
              ? 'none'
              : journalState.kind === 'valid'
                ? 'pending'
                : 'invalid',
          lock:
            lockState.kind === 'missing' ? 'free' : lockState.kind === 'valid' ? 'held' : 'invalid',
        };
        fragments.push(inspection);
        setOperationAttributes(span, {
          harness: adapter.id,
          scope: intent.scope,
          desired: fragmentDesired,
          availability: availability.available ? 'available' : 'unavailable',
          observation: classified.observation,
          action: classified.plan,
          recovery: 'none',
          result: 'inspected',
          markerGeneration: markerGeneration(classified.observation),
          lockRecovery: inspection.lock === 'invalid' ? 'invalid' : 'none',
        });
        const bad =
          classified.planned === 'conflict' ||
          classified.planned === 'release-blocked' ||
          classified.planned === 'repair-needed' ||
          classified.planned === 'invalid-container' ||
          inspection.journal === 'invalid' ||
          inspection.lock === 'invalid';
        span.setStatus({ code: bad ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      } finally {
        span.end();
      }
    }
    inspections.push({
      harness: adapter.id,
      surface: adapter.surface,
      desired: isDesired,
      availability,
      fragments,
    });
  }
  return inspections;
}

interface LedgerDelta {
  resourceKey: string;
  /** null clears the entry. */
  entry: LedgerFragment | null;
}

function applyLedgerDelta(ctx: HarnessContext, delta: LedgerDelta): void {
  const got = loadLedger(ctx.fs, ctx.machineConfigRoot);
  const ledger: FragmentLedger = got.kind === 'valid' ? got.value : { version: 1, fragments: {} };
  if (delta.entry === null) delete ledger.fragments[delta.resourceKey];
  else ledger.fragments[delta.resourceKey] = delta.entry;
  saveLedger(ctx.fs, ctx.machineConfigRoot, ledger);
}

/** Record (or clear) this worktree's contribution to a fragment in `.musterd/provisioned.json`.
 *  Contributions only — reconciliation NEVER rewrites `desired` (ADR 282). */
function applyContribution(
  ctx: HarnessContext,
  harness: HarnessId,
  resourceKey: string,
  contributes: boolean,
): void {
  const got = loadProvisioning(ctx.worktreeRoot, ctx.fs);
  if (got.kind !== 'valid') return; // configure's save precedes reconcile; nothing valid to update
  const provisioning = got.value;
  const current = new Set(provisioning.contributions[harness] ?? []);
  if (contributes) current.add(resourceKey);
  else current.delete(resourceKey);
  const contributions = { ...provisioning.contributions };
  if (current.size === 0) delete contributions[harness];
  else contributions[harness] = [...current].sort();
  saveProvisioning(ctx.worktreeRoot, { ...provisioning, contributions }, ctx.fs);
}

/** Recovery for a prepared journal found under a fresh lease (ADR 282 §4). */
async function recoverJournal(
  ctx: HarnessContext,
  adapter: HarnessAdapter,
  journal: ReconcileJournal,
  currentIntent: FragmentIntent | undefined,
): Promise<JournalRecovery> {
  const entryLike: LedgerFragment | undefined = ledgerFragments(ctx)[journal.resourceKey];
  const pseudo: FragmentIntent =
    currentIntent && currentIntent.resourceKey === journal.resourceKey
      ? currentIntent
      : {
          harness: journal.harness,
          resourceKey: journal.resourceKey,
          containerKey: journal.containerKey,
          fragmentKey: entryLike?.fragmentKey ?? journal.resourceKey,
          scope: entryLike?.scope ?? 'folder',
          fingerprint: journal.intendedFingerprint ?? '',
          payload: undefined,
        };
  const observed = await adapter.observe(ctx, pseudo);
  if (observed.state === 'invalid-container') return 'conflict';
  const fp = observedFingerprint(observed);

  const finalize = (): void => {
    if (journal.intendedFingerprint === null) {
      applyLedgerDelta(ctx, { resourceKey: journal.resourceKey, entry: null });
      applyContribution(ctx, journal.harness, journal.resourceKey, false);
    } else {
      const base: LedgerFragment = entryLike ?? {
        harness: journal.harness,
        scope: pseudo.scope,
        containerKey: journal.containerKey,
        fragmentKey: pseudo.fragmentKey,
        fingerprint: journal.intendedFingerprint,
        owners: journal.intendedOwners,
        adapterVersion: adapter.adapterVersion,
      };
      applyLedgerDelta(ctx, {
        resourceKey: journal.resourceKey,
        entry: {
          ...base,
          fingerprint: journal.intendedFingerprint,
          owners: [...journal.intendedOwners].sort(),
        },
      });
      applyContribution(
        ctx,
        journal.harness,
        journal.resourceKey,
        journal.intendedOwners.includes(journal.worktreeRoot),
      );
    }
    removeJournal(ctx.fs, ctx.machineConfigRoot, journal.containerKey);
  };

  // Owner-only operations have equal old/intended fingerprints: converge ledger owners.
  if (
    journal.oldFingerprint !== null &&
    journal.oldFingerprint === journal.intendedFingerprint &&
    fp === journal.oldFingerprint
  ) {
    finalize();
    return 'finalized';
  }
  if (fp === journal.intendedFingerprint) {
    finalize();
    return 'finalized';
  }
  if (fp === journal.oldFingerprint) {
    // Retry the external mutation, then finalize.
    if (journal.intendedFingerprint === null) {
      await adapter.apply(ctx, { kind: 'remove', intent: pseudo });
      finalize();
      return 'retried';
    }
    if (!currentIntent || currentIntent.fingerprint !== journal.intendedFingerprint) {
      // The journaled write's payload is not derivable any more — preserve the journal.
      return 'conflict';
    }
    await adapter.apply(ctx, { kind: 'write', intent: currentIntent });
    finalize();
    return 'retried';
  }
  return 'conflict';
}

/**
 * Reconcile actual harness state to the SAVED desired set. Only confirmed configure passes
 * `legacyRepair: true`. One fragment at a time; a stopped fragment (busy/conflict/invalid) never
 * blocks the others.
 */
export async function reconcileHarnesses(
  ctx: HarnessContext,
  desired: readonly string[],
  opts: ReconcileOptions,
): Promise<ReconcileReport> {
  const tracer = tracerOf(opts);
  const locks = createHarnessLocks({
    fs: ctx.fs,
    proc: ctx.proc,
    clock: ctx.clock,
    machineConfigRoot: ctx.machineConfigRoot,
  });
  const results: ReconcileResult[] = [];

  for (const { adapter, desired: isDesired } of enginePlan(desired, opts)) {
    const availability = await adapter.availability(ctx);
    if (isDesired && !availability.available) {
      // Selected but not installed: pending, not an error — selection survives (ADR 281).
      results.push({
        harness: adapter.id,
        resourceKey: '',
        scope: '',
        action: 'none',
        result: 'pending',
        recovery: 'none',
        ...(availability.detail !== undefined ? { detail: availability.detail } : {}),
      });
    }
    const fragments = await fragmentsFor(ctx, adapter, isDesired, availability.available);
    // Journals are per-CONTAINER: recovering one found under a sibling fragment's lease needs the
    // journaled fragment's OWN current intent, not the sibling's.
    const intentsByResource = new Map(
      fragments.filter((f) => f.desired).map((f) => [f.intent.resourceKey, f.intent]),
    );
    for (const { intent, desired: fragmentDesired } of fragments) {
      const span = tracer.startSpan(OP_SPAN);
      let observation: ObservationKind | 'unknown' = 'unknown';
      let action: PlannedAction = 'none';
      let recovery: JournalRecovery = 'none';
      let result: FragmentResultKind = 'failed';
      let lockRecovery: 'none' | 'reclaimed' | 'busy' | 'invalid' = 'none';
      let lease: HarnessLease | undefined;
      try {
        // 1. Acquire or safely reclaim the recoverable container lease.
        const priorLock = loadLockRecord(ctx.fs, ctx.machineConfigRoot, intent.containerKey);
        const acquired = locks.acquire(intent.containerKey);
        if (acquired.status === 'busy') {
          lockRecovery = acquired.reason === 'invalid-record' ? 'invalid' : 'busy';
          result = 'busy';
          results.push({
            harness: adapter.id,
            resourceKey: intent.resourceKey,
            scope: intent.scope,
            action,
            result,
            recovery,
          });
          continue;
        }
        lease = acquired.lease;
        if (priorLock.kind === 'valid') lockRecovery = 'reclaimed';

        // 2. Recover any earlier journal for this container.
        const journal = loadJournal(ctx.fs, ctx.machineConfigRoot, intent.containerKey);
        if (journal.kind === 'invalid' || journal.kind === 'legacy') {
          recovery = 'conflict';
          result = 'conflict';
          results.push({
            harness: adapter.id,
            resourceKey: intent.resourceKey,
            scope: intent.scope,
            action,
            result,
            recovery,
            detail: 'unreadable prepared journal — manual repair required',
          });
          continue;
        }
        if (journal.kind === 'valid') {
          recovery = await recoverJournal(
            ctx,
            adapter,
            journal.value,
            intentsByResource.get(journal.value.resourceKey),
          );
          if (recovery === 'conflict') {
            result = 'conflict';
            results.push({
              harness: adapter.id,
              resourceKey: intent.resourceKey,
              scope: intent.scope,
              action,
              result,
              recovery,
              detail: 'prepared journal matches neither fingerprint — evidence preserved',
            });
            continue;
          }
        }

        // 3. Re-read the latest container state and 4. plan from the matrix.
        const entry = ledgerFragments(ctx)[intent.resourceKey];
        const observed = await adapter.observe(ctx, intent);
        const classified = classifyFragment(
          fragmentDesired,
          observed,
          entry,
          ctx.worktreeRoot,
          fragmentDesired ? intent.fingerprint : null,
          opts.legacyRepair,
        );
        observation = classified.observation;
        action = classified.plan;

        if (classified.plan === 'none') {
          result = classified.planned;
          results.push({
            harness: adapter.id,
            resourceKey: intent.resourceKey,
            scope: intent.scope,
            action,
            result,
            recovery,
          });
          continue;
        }

        // 5. Publish the prepared write-ahead journal.
        const oldOwners = entry?.owners ?? [];
        const intendedOwners = (() => {
          switch (classified.plan) {
            case 'create':
            case 'repair-launch-marker':
            case 'add-owner':
              return [...new Set([...oldOwners, ctx.worktreeRoot])].sort();
            case 'release-owner':
              return oldOwners.filter((o) => o !== ctx.worktreeRoot);
            case 'remove':
              return [];
          }
        })();
        const intendedFingerprint = classified.plan === 'remove' ? null : intent.fingerprint;
        const record: ReconcileJournal = {
          version: 1,
          operationId: randomUUID(),
          action:
            classified.plan === 'repair-launch-marker'
              ? 'create'
              : classified.plan === 'add-owner'
                ? 'add-owner'
                : classified.plan === 'release-owner'
                  ? 'release-owner'
                  : classified.plan,
          harness: adapter.id,
          containerKey: intent.containerKey,
          resourceKey: intent.resourceKey,
          oldFingerprint: observedFingerprint(observed),
          intendedFingerprint,
          oldOwners,
          intendedOwners,
          worktreeRoot: ctx.worktreeRoot,
          phase: 'prepared',
        };
        saveJournal(ctx.fs, ctx.machineConfigRoot, record);

        // 6-7. Apply the scoped external mutation (owner-only ops touch nothing physical).
        lease.renew();
        if (classified.plan === 'create') {
          await adapter.apply(ctx, { kind: 'write', intent });
        } else if (classified.plan === 'remove') {
          await adapter.apply(ctx, { kind: 'remove', intent });
        } else if (classified.plan === 'repair-launch-marker') {
          await adapter.apply(ctx, { kind: 'repair-launch-marker', intent });
        }

        // 8. Persist ledger evidence and this worktree's contribution.
        if (classified.plan === 'remove') {
          applyLedgerDelta(ctx, { resourceKey: intent.resourceKey, entry: null });
        } else {
          applyLedgerDelta(ctx, {
            resourceKey: intent.resourceKey,
            entry: {
              harness: adapter.id,
              scope: intent.scope,
              containerKey: intent.containerKey,
              fragmentKey: intent.fragmentKey,
              fingerprint: intent.fingerprint,
              owners: intendedOwners,
              adapterVersion: adapter.adapterVersion,
            },
          });
        }
        applyContribution(
          ctx,
          adapter.id,
          intent.resourceKey,
          intendedOwners.includes(ctx.worktreeRoot),
        );

        // 9. Clear the journal; the lease is released in finally.
        removeJournal(ctx.fs, ctx.machineConfigRoot, intent.containerKey);
        result = 'applied';
        results.push({
          harness: adapter.id,
          resourceKey: intent.resourceKey,
          scope: intent.scope,
          action,
          result,
          recovery,
        });
      } catch (err) {
        result = 'failed';
        results.push({
          harness: adapter.id,
          resourceKey: intent.resourceKey,
          scope: intent.scope,
          action,
          result,
          recovery,
          detail: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setOperationAttributes(span, {
          harness: adapter.id,
          scope: intent.scope,
          desired: fragmentDesired,
          availability: availability.available ? 'available' : 'unavailable',
          observation,
          action,
          recovery,
          result,
          markerGeneration:
            action === 'repair-launch-marker' && result === 'applied'
              ? 'launch'
              : markerGeneration(observation),
          lockRecovery,
        });
        const bad =
          result === 'conflict' ||
          result === 'failed' ||
          result === 'busy' ||
          result === 'release-blocked' ||
          result === 'repair-needed' ||
          result === 'invalid-container';
        span.setStatus({ code: bad ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        span.end();
        lease?.release();
      }
    }
  }
  return {
    results,
    ok: results.every(
      (r) =>
        r.result === 'applied' ||
        r.result === 'unchanged' ||
        r.result === 'satisfied-unmanaged' ||
        r.result === 'pending',
    ),
  };
}
