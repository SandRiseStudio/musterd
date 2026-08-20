import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { nodeFs, type HarnessContext } from '../onboard/reconcile/context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type FragmentMutation,
  type HarnessAdapter,
  type ObservedFragment,
} from '../onboard/reconcile/fragments.js';
import { loadProvisioning } from '../onboard/manifest.js';
import { harnessCommand } from './harness.js';

let cwd: string;
let machineRoot: string;
const cwd0 = process.cwd();

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'musterd-harness-'));
  machineRoot = mkdtempSync(join(tmpdir(), 'musterd-harness-machine-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd0);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(machineRoot, { recursive: true, force: true });
});

/** One scriptable external adapter with a single folder fragment, physical state in-memory. */
function fakeAdapter(
  id: string,
  opts: { available?: boolean; observed?: ObservedFragment } = {},
): HarnessAdapter & { state: { observed: ObservedFragment; applied: FragmentMutation[] } } {
  const state = {
    observed: opts.observed ?? ({ state: 'absent' } as ObservedFragment),
    applied: [] as FragmentMutation[],
  };
  const payload = { entry: id };
  return {
    state,
    id,
    surface: 'other',
    adapterVersion: 1,
    availability: async () => ({
      available: opts.available ?? true,
      detail: opts.available === false ? 'not installed here' : 'ok',
    }),
    target: async (ctx) => ({
      containers: [
        { containerKey: `folder ${ctx.worktreeRoot} ${id}`, scope: 'folder', handle: null },
      ],
    }),
    desiredFragments: async (ctx) => [
      {
        harness: id,
        resourceKey: folderResourceKey(ctx.worktreeRoot, id, 'entry'),
        containerKey: `folder ${ctx.worktreeRoot} ${id}`,
        fragmentKey: 'entry',
        scope: 'folder',
        fingerprint: canonicalFingerprint(payload),
        payload,
      },
    ],
    observe: async () => state.observed,
    apply: async (_ctx, mutation) => {
      state.applied.push(mutation);
      state.observed =
        mutation.kind === 'remove'
          ? { state: 'absent' }
          : { state: 'present', fingerprint: mutation.intent.fingerprint };
    },
  };
}

function ctxOf(): HarnessContext {
  return {
    worktreeRoot: cwd,
    machineConfigRoot: machineRoot,
    env: {},
    fs: nodeFs,
    proc: { pid: process.pid, startedAt: () => 's-test', liveness: () => false },
    clock: { now: () => Date.now() },
    team: 'dawn',
  };
}

function writeV2Identity(): void {
  mkdirSync(join(cwd, '.musterd'), { recursive: true });
  writeFileSync(
    join(cwd, '.musterd', 'workspace.json'),
    JSON.stringify({
      version: 2,
      server: 'http://localhost:4849',
      team: 'dawn',
      claim: { mode: 'seat', name: 'Ada' },
    }),
  );
}

function writeV1Identity(): void {
  mkdirSync(join(cwd, '.musterd'), { recursive: true });
  writeFileSync(
    join(cwd, '.musterd', 'workspace.json'),
    JSON.stringify({
      server: 'http://localhost:4849',
      team: 'dawn',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'Ada' },
    }),
  );
  writeFileSync(
    join(cwd, '.musterd', 'binding.json'),
    JSON.stringify({
      server: 'http://localhost:4849',
      team: 'dawn',
      surface: 'claude-code',
      agent_key: 'mskey_x',
      claim: { mode: 'seat', name: 'Ada' },
      model: 'claude-fable-5',
    }),
  );
  writeFileSync(
    join(cwd, '.musterd', 'provisioned.json'),
    JSON.stringify({
      version: 1,
      role: 'backend',
      harness: 'fake-a',
      mcpServers: ['musterd'],
      permissions: { allow: [], ask: [], deny: [] },
      provisionedAt: '2026-08-01T00:00:00.000Z',
    }),
  );
}

function writeV2Provisioning(desired: string[], contributions: Record<string, string[]> = {}): void {
  mkdirSync(join(cwd, '.musterd'), { recursive: true });
  writeFileSync(
    join(cwd, '.musterd', 'provisioned.json'),
    JSON.stringify({
      version: 2,
      profile: '',
      desired,
      contributions,
      provisionedAt: '2026-08-19T00:00:00.000Z',
    }),
  );
}

async function run(argv: string[], deps: Parameters<typeof harnessCommand>[1]) {
  const lines: string[] = [];
  const code = await harnessCommand(parseArgs(argv), {
    ...deps,
    out: (line) => lines.push(line),
  });
  return { code, out: lines.join('\n') };
}

describe('musterd harness configure', () => {
  it('saves desire FIRST, reconciles with legacyRepair, and reports per-fragment results', async () => {
    writeV2Identity();
    const a = fakeAdapter('fake-a');
    const b = fakeAdapter('fake-b');
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a, b],
      select: ['fake-a'],
    });
    expect(code).toBe(0);
    expect(out).toContain('desired harnesses: fake-a');
    expect(out).toContain('✓ applied');
    expect(out).toContain('worktree configured');
    expect(a.state.applied[0]?.kind).toBe('write');
    expect(b.state.applied).toEqual([]);
    const prov = loadProvisioning(cwd);
    expect(prov.kind === 'valid' && prov.value.desired).toEqual(['fake-a']);
  });

  it('an empty set is valid — everything owned is released', async () => {
    writeV2Identity();
    writeV2Provisioning([]);
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: [],
    });
    expect(code).toBe(0);
    expect(out).toContain('desired harnesses: (none)');
  });

  it('converts a recognized version-1 worktree only after confirmation, retaining role as profile', async () => {
    writeV1Identity();
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: ['fake-a'],
      confirm: true,
    });
    expect(code).toBe(0);
    expect(out).toContain('converted the version-1 identity/manifest to version 2');
    const spec = JSON.parse(readFileSync(join(cwd, '.musterd', 'workspace.json'), 'utf8'));
    expect(spec.version).toBe(2);
    expect(spec.surface).toBeUndefined();
    const binding = JSON.parse(readFileSync(join(cwd, '.musterd', 'binding.json'), 'utf8'));
    expect(binding.version).toBe(2);
    expect(binding.surface).toBeUndefined();
    expect(binding.model).toBe('claude-fable-5'); // runtime fields carried through
    const prov = loadProvisioning(cwd);
    expect(prov.kind === 'valid' && prov.value.profile).toBe('backend');
    // v1 name-only records never became evidence: the recorded contribution is the FRESH one the
    // reconciler just created and journaled (the physical fragment was re-observed absent, then
    // written) — not a carried-over v1 mcpServers list.
    expect(prov.kind === 'valid' && Object.keys(prov.value.contributions)).toEqual(['fake-a']);
    expect(a.state.applied[0]?.kind).toBe('write');
  });

  it('a declined conversion writes NOTHING and exits 0', async () => {
    writeV1Identity();
    const before = readFileSync(join(cwd, '.musterd', 'workspace.json'), 'utf8');
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: ['fake-a'],
      confirm: false,
    });
    expect(code).toBe(0);
    expect(out).toContain('no changes made');
    expect(readFileSync(join(cwd, '.musterd', 'workspace.json'), 'utf8')).toBe(before);
    expect(a.state.applied).toEqual([]);
  });

  it('a selected but unavailable harness reconciles as pending and still exits 0', async () => {
    writeV2Identity();
    const a = fakeAdapter('fake-a', { available: false });
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: ['fake-a'],
    });
    expect(code).toBe(0);
    expect(out).toContain('pending');
    expect(a.state.applied).toEqual([]);
  });

  it('refuses a folder with no musterd identity at all', async () => {
    await expect(
      run(['configure'], { ctx: ctxOf(), registry: [fakeAdapter('fake-a')], select: [] }),
    ).rejects.toThrow(/musterd init/);
  });
});

describe('musterd harness status', () => {
  it('reports missing selection with the configure repair and exits 1', async () => {
    writeV2Identity();
    const { code, out } = await run(['status'], {
      ctx: ctxOf(),
      registry: [fakeAdapter('fake-a')],
    });
    expect(code).toBe(1);
    expect(out).toContain('no harness selection here');
    expect(out).toContain('musterd harness configure');
  });

  it('reports a version-1 worktree as legacy with the configure repair', async () => {
    writeV1Identity();
    const { code, out } = await run(['status'], {
      ctx: ctxOf(),
      registry: [fakeAdapter('fake-a')],
    });
    expect(code).toBe(1);
    expect(out).toContain('pre-ADR-281');
  });

  it('exit 0 only when every desired fragment is usable — a needed create exits 1', async () => {
    writeV2Identity();
    writeV2Provisioning(['fake-a']);
    const a = fakeAdapter('fake-a'); // fragment absent → needs wire
    const first = await run(['status'], { ctx: ctxOf(), registry: [a] });
    expect(first.code).toBe(1);
    expect(first.out).toContain('→ needs wire');

    // Configure it into place, then status is healthy.
    await run(['configure'], { ctx: ctxOf(), registry: [a], select: ['fake-a'] });
    const second = await run(['status'], { ctx: ctxOf(), registry: [a] });
    expect(second.code).toBe(0);
    expect(second.out).toContain('✓ in place');
    expect(second.out).toContain('selected · available');
  });

  it('pending unavailability exits zero — the selection survives the harness not being installed', async () => {
    writeV2Identity();
    writeV2Provisioning(['fake-a']);
    const a = fakeAdapter('fake-a', { available: false });
    const { code, out } = await run(['status'], { ctx: ctxOf(), registry: [a] });
    expect(code).toBe(0);
    expect(out).toContain('pending (not installed here)');
  });

  it('a legacy launch marker reports its repair and exits 1', async () => {
    writeV2Identity();
    writeV2Provisioning(['fake-a']);
    const a = fakeAdapter('fake-a', {
      observed: { state: 'legacy-launch-marker', fingerprint: 'l'.repeat(64) },
    });
    const { code, out } = await run(['status'], { ctx: ctxOf(), registry: [a] });
    expect(code).toBe(1);
    expect(out).toContain('legacy launch marker — run musterd harness configure');
  });

  it('an undesired owned contribution that is not yet released exits 1', async () => {
    writeV2Identity();
    // fake-a was configured, then deselected — the ledger still names this worktree.
    const a = fakeAdapter('fake-a');
    await run(['configure'], { ctx: ctxOf(), registry: [a], select: ['fake-a'] });
    writeV2Provisioning([], JSON.parse(readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8')).contributions);
    const { code, out } = await run(['status'], { ctx: ctxOf(), registry: [a] });
    expect(code).toBe(1);
    expect(out).toContain('not selected');
  });

  it('--json exposes the same stable fields', async () => {
    writeV2Identity();
    writeV2Provisioning(['fake-a']);
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['status', '--json'], {
      ctx: ctxOf(),
      registry: [a],
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.desired).toEqual(['fake-a']);
    const fakeA = parsed.harnesses.find((h: { harness: string }) => h.harness === 'fake-a');
    expect(fakeA.fragments[0]).toMatchObject({
      fragmentKey: 'entry',
      scope: 'folder',
      desired: true,
      observation: 'absent',
      plan: 'create',
      journal: 'none',
      lock: 'free',
    });
  });
});
