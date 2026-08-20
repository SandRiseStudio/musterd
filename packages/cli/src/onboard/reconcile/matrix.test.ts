import { beforeEach, describe, expect, it } from 'vitest';
import type { FragmentLedger, WorktreeProvisioning } from '@musterd/protocol';
import { memoryFs, type HarnessContext, type MemoryFs } from './context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type FragmentIntent,
  type FragmentMutation,
  type HarnessAdapter,
  type ObservedFragment,
} from './fragments.js';
import { loadJournal, loadLedger, saveLedger } from './store.js';
import { saveProvisioning, loadProvisioning } from '../manifest.js';
import { reconcileHarnesses } from './engine.js';

const ROOT = '/w/a';
const MACHINE = '/machine/.musterd';

/** A scriptable fake harness: one folder container, one fragment, in-memory physical state. */
interface FakeState {
  /** The physical fragment as the adapter would observe it. */
  observed: ObservedFragment;
  applied: FragmentMutation[];
  applyError?: Error;
}

function fakeAdapter(id: string, state: FakeState, payload: unknown = { hooks: true }): HarnessAdapter {
  const fragmentKey = 'entry';
  const containerKey = `folder ${ROOT} ${id} settings`;
  return {
    id,
    surface: 'other',
    adapterVersion: 1,
    availability: async () => ({ available: true }),
    target: async () => ({ containers: [{ containerKey, scope: 'folder', handle: null }] }),
    desiredFragments: async () => [
      {
        harness: id,
        resourceKey: folderResourceKey(ROOT, id, fragmentKey),
        containerKey,
        fragmentKey,
        scope: 'folder',
        fingerprint: canonicalFingerprint(payload),
        payload,
      },
    ],
    observe: async () => state.observed,
    apply: async (_ctx, mutation) => {
      if (state.applyError) throw state.applyError;
      state.applied.push(mutation);
      // Mirror the physical effect so post-apply observation agrees.
      state.observed =
        mutation.kind === 'remove'
          ? { state: 'absent' }
          : { state: 'present', fingerprint: mutation.intent.fingerprint };
    },
  };
}

function ctxOf(fs: MemoryFs): HarnessContext {
  let now = 1_000_000;
  return {
    worktreeRoot: ROOT,
    machineConfigRoot: MACHINE,
    env: {},
    fs,
    proc: { pid: 42, startedAt: () => 's42', liveness: () => false },
    clock: { now: () => (now += 1) },
  };
}

const DESIRED_PAYLOAD = { hooks: true };
const DESIRED_FP = canonicalFingerprint(DESIRED_PAYLOAD);
const RESOURCE = folderResourceKey(ROOT, 'fake', 'entry');
const CONTAINER = `folder ${ROOT} fake settings`;

function seedProvisioning(fs: MemoryFs, desired: string[], contributions: Record<string, string[]> = {}) {
  const provisioning: WorktreeProvisioning = {
    version: 2,
    profile: '',
    desired,
    contributions,
    provisionedAt: '2026-08-19T00:00:00.000Z',
  };
  saveProvisioning(ROOT, provisioning, fs);
}

function seedLedger(fs: MemoryFs, fingerprint: string, owners: string[]) {
  const ledger: FragmentLedger = {
    version: 1,
    fragments: {
      [RESOURCE]: {
        harness: 'fake',
        scope: 'folder',
        containerKey: CONTAINER,
        fragmentKey: 'entry',
        fingerprint,
        owners,
        adapterVersion: 1,
      },
    },
  };
  saveLedger(fs, MACHINE, ledger);
}

function ledgerOwners(fs: MemoryFs): string[] | undefined {
  const got = loadLedger(fs, MACHINE);
  return got.kind === 'valid' ? got.value.fragments[RESOURCE]?.owners : undefined;
}

describe('the reconciliation action matrix (ADR 282)', () => {
  let fs: MemoryFs;
  let state: FakeState;
  beforeEach(() => {
    fs = memoryFs();
    state = { observed: { state: 'absent' }, applied: [] };
  });

  const run = (desired: string[], opts?: { legacyRepair?: boolean }) =>
    reconcileHarnesses(ctxOf(fs), desired, {
      legacyRepair: opts?.legacyRepair ?? false,
      registry: [fakeAdapter('fake', state, DESIRED_PAYLOAD)],
    });

  it('desired + absent + no owners → journaled create + add owner', async () => {
    seedProvisioning(fs, ['fake']);
    const report = await run(['fake']);
    const r = report.results.find((x) => x.resourceKey === RESOURCE)!;
    expect(r.action).toBe('create');
    expect(r.result).toBe('applied');
    expect(state.applied[0]?.kind).toBe('write');
    expect(ledgerOwners(fs)).toEqual([ROOT]);
    // journal cleared after completion
    expect(loadJournal(fs, MACHINE, CONTAINER).kind).toBe('missing');
    // contribution recorded
    const prov = loadProvisioning(ROOT, fs);
    expect(prov.kind === 'valid' && prov.value.contributions['fake']).toEqual([RESOURCE]);
  });

  it('desired + unmanaged-equivalent + no owners → satisfied-unmanaged, NO ownership taken', async () => {
    seedProvisioning(fs, ['fake']);
    state.observed = { state: 'present', fingerprint: DESIRED_FP };
    const report = await run(['fake']);
    const r = report.results[0]!;
    expect(r.result).toBe('satisfied-unmanaged');
    expect(state.applied).toEqual([]);
    expect(ledgerOwners(fs)).toBeUndefined(); // equivalence is not ownership evidence
  });

  it('desired + unmanaged-conflict + no owners → conflict, no mutation', async () => {
    seedProvisioning(fs, ['fake']);
    state.observed = { state: 'present', fingerprint: 'f'.repeat(64) };
    const report = await run(['fake']);
    expect(report.results[0]!.result).toBe('conflict');
    expect(state.applied).toEqual([]);
    expect(ledgerOwners(fs)).toBeUndefined();
  });

  it('desired + owned-exact + owners include this root → unchanged', async () => {
    seedProvisioning(fs, ['fake'], { fake: [RESOURCE] });
    seedLedger(fs, DESIRED_FP, [ROOT, '/w/b']);
    state.observed = { state: 'present', fingerprint: DESIRED_FP };
    const report = await run(['fake']);
    expect(report.results[0]!.result).toBe('unchanged');
    expect(state.applied).toEqual([]);
    expect(ledgerOwners(fs)).toEqual([ROOT, '/w/b']);
  });

  it('desired + owned-exact + owners exclude this root → journaled add-owner', async () => {
    seedProvisioning(fs, ['fake']);
    seedLedger(fs, DESIRED_FP, ['/w/b']);
    state.observed = { state: 'present', fingerprint: DESIRED_FP };
    const report = await run(['fake']);
    const r = report.results[0]!;
    expect(r.action).toBe('add-owner');
    expect(r.result).toBe('applied');
    // Owner-only: the physical fragment is untouched.
    expect(state.applied).toEqual([]);
    expect(ledgerOwners(fs)).toEqual(['/w/a', '/w/b'].sort());
  });

  it('desired + owned-drifted → conflict, evidence retained', async () => {
    seedProvisioning(fs, ['fake']);
    seedLedger(fs, DESIRED_FP, [ROOT]);
    state.observed = { state: 'present', fingerprint: 'd'.repeat(64) };
    const report = await run(['fake']);
    expect(report.results[0]!.result).toBe('conflict');
    expect(state.applied).toEqual([]);
    // Ledger evidence retained for the human to adjudicate.
    expect(ledgerOwners(fs)).toEqual([ROOT]);
  });

  it('undesired + owned-exact + root plus others → journaled release-owner, fragment kept', async () => {
    seedProvisioning(fs, [], { fake: [RESOURCE] });
    seedLedger(fs, DESIRED_FP, [ROOT, '/w/b']);
    state.observed = { state: 'present', fingerprint: DESIRED_FP };
    const report = await run([]);
    const r = report.results[0]!;
    expect(r.action).toBe('release-owner');
    expect(r.result).toBe('applied');
    expect(state.applied).toEqual([]); // fragment kept — another worktree still owns it
    expect(ledgerOwners(fs)).toEqual(['/w/b']);
    const prov = loadProvisioning(ROOT, fs);
    expect(prov.kind === 'valid' && prov.value.contributions['fake']).toBeUndefined();
  });

  it('undesired + owned-exact + root only → journaled remove, evidence cleared', async () => {
    seedProvisioning(fs, [], { fake: [RESOURCE] });
    seedLedger(fs, DESIRED_FP, [ROOT]);
    state.observed = { state: 'present', fingerprint: DESIRED_FP };
    const report = await run([]);
    const r = report.results[0]!;
    expect(r.action).toBe('remove');
    expect(r.result).toBe('applied');
    expect(state.applied[0]?.kind).toBe('remove');
    expect(ledgerOwners(fs)).toBeUndefined();
  });

  it('undesired + owned-drifted + owners include root → release-blocked, evidence retained', async () => {
    seedProvisioning(fs, [], { fake: [RESOURCE] });
    seedLedger(fs, DESIRED_FP, [ROOT]);
    state.observed = { state: 'present', fingerprint: 'd'.repeat(64) };
    const report = await run([]);
    expect(report.results[0]!.result).toBe('release-blocked');
    expect(state.applied).toEqual([]);
    expect(ledgerOwners(fs)).toEqual([ROOT]);
  });

  it('undesired + unowned → unchanged, whatever is physically present', async () => {
    seedProvisioning(fs, []);
    state.observed = { state: 'present', fingerprint: 'x'.repeat(64) };
    const report = await run([]);
    // No ledger entry, not desired: there is nothing of ours here — no fragment row at all, or an
    // unchanged one; either way no mutation and no ownership.
    expect(state.applied).toEqual([]);
    expect(ledgerOwners(fs)).toBeUndefined();
    expect(report.results.every((r) => r.result === 'unchanged')).toBe(true);
  });

  describe('legacy-launch-marker (ADR 286 §1)', () => {
    it('reports repair-needed when legacyRepair is false', async () => {
      seedProvisioning(fs, ['fake']);
      state.observed = { state: 'legacy-launch-marker', fingerprint: 'l'.repeat(64) };
      const report = await run(['fake'], { legacyRepair: false });
      expect(report.results[0]!.result).toBe('repair-needed');
      expect(state.applied).toEqual([]);
    });

    it('with legacyRepair true, replaces only the marker as a journaled fragment mutation', async () => {
      seedProvisioning(fs, ['fake']);
      state.observed = { state: 'legacy-launch-marker', fingerprint: 'l'.repeat(64) };
      const report = await run(['fake'], { legacyRepair: true });
      const r = report.results[0]!;
      expect(r.action).toBe('repair-launch-marker');
      expect(r.result).toBe('applied');
      expect(state.applied[0]?.kind).toBe('repair-launch-marker');
      expect(loadJournal(fs, MACHINE, CONTAINER).kind).toBe('missing'); // journaled, then cleared
    });
  });

  it('an invalid container stops that fragment and mutates nothing', async () => {
    seedProvisioning(fs, ['fake']);
    state.observed = { state: 'invalid-container', issues: [{ path: '<file>', message: 'torn' }] };
    const report = await run(['fake']);
    expect(report.results[0]!.result).toBe('invalid-container');
    expect(state.applied).toEqual([]);
  });

  it('a busy container lease stops that fragment with busy', async () => {
    seedProvisioning(fs, ['fake']);
    // Hold the lease as a live foreign process.
    const { createHarnessLocks } = await import('./lock.js');
    const held = createHarnessLocks({
      fs,
      clock: { now: () => 1_000_000 },
      proc: { pid: 7, startedAt: () => 's7', liveness: () => true },
      machineConfigRoot: MACHINE,
    });
    expect(held.acquire(CONTAINER).status).toBe('acquired');
    // The holder's lease is unexpired, so the reconciler reports busy without consulting liveness.
    const report = await run(['fake']);
    expect(report.results[0]!.result).toBe('busy');
    expect(state.applied).toEqual([]);
  });
});
