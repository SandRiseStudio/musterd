import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, WORKSPACE_SPEC_FILE } from '@musterd/protocol';
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
import { harnessWiredFor, wireCommand, wireConfigures } from './wire.js';

let cwd: string;
let machineRoot: string;
let configPath: string;
const cwd0 = process.cwd();

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'musterd-wire-'));
  machineRoot = mkdtempSync(join(tmpdir(), 'musterd-wire-machine-'));
  configPath = join(machineRoot, 'config.json');
  process.env['MUSTERD_CONFIG'] = configPath;
  delete process.env['MUSTERD_AGENT_KEY'];
  delete process.env['MUSTERD_GRANT'];
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd0);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(machineRoot, { recursive: true, force: true });
  delete process.env['MUSTERD_CONFIG'];
  delete process.env['MUSTERD_AGENT_KEY'];
});

function fakeAdapter(
  id: string,
  opts: { observed?: ObservedFragment } = {},
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
    availability: async () => ({ available: true }),
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
    team: 'bravo',
  };
}

function writeSpec(spec: Record<string, unknown>) {
  mkdirSync(join(cwd, BINDING_DIR), { recursive: true });
  writeFileSync(join(cwd, BINDING_DIR, WORKSPACE_SPEC_FILE), JSON.stringify(spec), 'utf8');
}
const SPEC = {
  version: 2,
  server: 'http://localhost:4849',
  team: 'bravo',
  claim: { mode: 'seat', name: 'Sonnet' },
};
function writeProvisioning(desired: string[]) {
  mkdirSync(join(cwd, BINDING_DIR), { recursive: true });
  writeFileSync(
    join(cwd, BINDING_DIR, 'provisioned.json'),
    JSON.stringify({
      version: 2,
      profile: '',
      desired,
      contributions: {},
      provisionedAt: '2026-08-19T00:00:00.000Z',
    }),
    'utf8',
  );
}
function writeConfig(agentKeys: Record<string, string>) {
  writeFileSync(
    configPath,
    JSON.stringify({
      server: 'http://localhost:4849',
      current: 'bravo',
      identities: {},
      knownIdentities: [],
      bindings: {},
      agentKeys,
      rosterHome: {},
    }),
    'utf8',
  );
}
function readBinding() {
  return JSON.parse(readFileSync(join(cwd, BINDING_DIR, BINDING_FILE), 'utf8'));
}
async function run(argv: string[], deps?: Parameters<typeof wireCommand>[1]) {
  const out: string[] = [];
  const errs: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c: never) => (errs.push(String(c)), true));
  try {
    const code = await wireCommand(
      parseArgs(argv),
      deps ?? { ctx: ctxOf(), registry: [fakeAdapter('fake-a')] },
    );
    return { code, out: out.join(''), err: errs.join('') };
  } finally {
    (process.stdout.write as unknown as { mockRestore: () => void }).mockRestore();
    (process.stderr.write as unknown as { mockRestore: () => void }).mockRestore();
  }
}

describe('musterd wire (noninteractive, desire-preserving — ADR 282)', () => {
  it('reconciles the SAVED selection and materializes the binding with the resolved key', async () => {
    writeSpec(SPEC);
    writeProvisioning(['fake-a']);
    writeConfig({ bravo: 'mskey_fromconfig' });
    const a = fakeAdapter('fake-a');
    const { code, out } = await run([], { ctx: ctxOf(), registry: [a] });
    expect(code).toBe(0);
    expect(a.state.applied[0]?.kind).toBe('write');
    expect(out).toContain('wired this worktree');
    const binding = readBinding();
    expect(binding.version).toBe(2);
    expect(binding.agent_key).toBe('mskey_fromconfig');
    expect(binding.surface).toBeUndefined();
  });

  it('exits 6 with the configure repair when no selection exists', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_x' });
    await expect(run([])).rejects.toMatchObject({
      exitCode: 6,
      message: expect.stringContaining('musterd harness configure'),
    });
  });

  it('exits 6 and never converts a pre-ADR-281 spec', async () => {
    writeSpec({ server: 'http://localhost:4849', team: 'bravo', surface: 'claude-code' });
    const before = readFileSync(join(cwd, BINDING_DIR, WORKSPACE_SPEC_FILE), 'utf8');
    await expect(run([])).rejects.toMatchObject({
      exitCode: 6,
      message: expect.stringContaining('musterd harness configure'),
    });
    expect(readFileSync(join(cwd, BINDING_DIR, WORKSPACE_SPEC_FILE), 'utf8')).toBe(before);
  });

  it('exits 6 and never converts a version-1 provisioning manifest', async () => {
    writeSpec(SPEC);
    mkdirSync(join(cwd, BINDING_DIR), { recursive: true });
    writeFileSync(
      join(cwd, BINDING_DIR, 'provisioned.json'),
      JSON.stringify({
        version: 1,
        role: 'backend',
        harness: 'claude-code',
        mcpServers: ['musterd'],
        permissions: { allow: [], ask: [], deny: [] },
        provisionedAt: '2026-08-01T00:00:00.000Z',
      }),
    );
    await expect(run([])).rejects.toMatchObject({ exitCode: 6 });
  });

  it('reports a legacy launch marker instead of repairing it (repair-needed, exit 1)', async () => {
    writeSpec(SPEC);
    writeProvisioning(['fake-a']);
    writeConfig({ bravo: 'mskey_x' });
    const a = fakeAdapter('fake-a', {
      observed: { state: 'legacy-launch-marker', fingerprint: 'l'.repeat(64) },
    });
    const { code, out } = await run([], { ctx: ctxOf(), registry: [a] });
    expect(code).toBe(1);
    expect(out).toContain('repair-needed');
    expect(a.state.applied).toEqual([]); // wire never repairs the marker
  });

  it('key precedence: --key beats env beats config; keyless registers with a note', async () => {
    writeSpec(SPEC);
    writeProvisioning(['fake-a']);
    writeConfig({ bravo: 'mskey_config' });
    process.env['MUSTERD_AGENT_KEY'] = 'mskey_env';
    await run(['--key', 'mskey_flag']);
    expect(readBinding().agent_key).toBe('mskey_flag');
    await run([]);
    expect(readBinding().agent_key).toBe('mskey_env');
    delete process.env['MUSTERD_AGENT_KEY'];
    await run([]);
    expect(readBinding().agent_key).toBe('mskey_config');
    writeConfig({});
    const r = await run([]);
    expect(readBinding().agent_key).toBeUndefined();
    expect(r.err).toContain('no team agent key');
  });

  it('--autojoin opts in via the binding; a re-wire without it never flips a seat dormant', async () => {
    writeSpec(SPEC);
    writeProvisioning(['fake-a']);
    writeConfig({ bravo: 'mskey_x' });
    await run(['--autojoin']);
    expect(readBinding().autojoin).toBe(true);
    await run([]);
    expect(readBinding().autojoin).toBe(true); // preserved
  });

  it('preserves an attested model and driver across a re-wire (ADR 101/165)', async () => {
    writeSpec(SPEC);
    writeProvisioning(['fake-a']);
    writeConfig({ bravo: 'mskey_x' });
    await run([]);
    const withRuntime = { ...readBinding(), model: 'claude-fable-5', driver: 'nick' };
    writeFileSync(join(cwd, BINDING_DIR, BINDING_FILE), JSON.stringify(withRuntime, null, 2));
    await run([]);
    expect(readBinding().model).toBe('claude-fable-5');
    expect(readBinding().driver).toBe('nick');
  });

  it('--json exposes the ADR 282 shape: team, member, desired, results, keyResolved, autojoin', async () => {
    writeSpec(SPEC);
    writeProvisioning(['fake-a']);
    writeConfig({ bravo: 'mskey_x' });
    const { code, out } = await run(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      team: 'bravo',
      member: 'Sonnet',
      desired: ['fake-a'],
      keyResolved: true,
      autojoin: false,
    });
    expect(parsed.results[0]).toMatchObject({ harness: 'fake-a', result: 'applied' });
  });

  it('never writes a secret into the committed workspace.json', async () => {
    writeSpec(SPEC);
    writeProvisioning(['fake-a']);
    writeConfig({ bravo: 'mskey_secret' });
    await run([]);
    const specText = readFileSync(join(cwd, BINDING_DIR, WORKSPACE_SPEC_FILE), 'utf8');
    expect(specText).not.toContain('mskey_');
    expect(existsSync(join(cwd, BINDING_DIR, BINDING_FILE))).toBe(true);
  });
});

describe('harnessWiredFor / wireConfigures (doctor prescriptions)', () => {
  it('says which harness it would configure, per folder', () => {
    expect(harnessWiredFor('codex').id).toBe('codex');
    expect(harnessWiredFor('cursor').id).toBe('cursor');
    expect(harnessWiredFor('claude-code').id).toBe('claude-code');
    expect(harnessWiredFor('cli').id).toBe('claude-code');
    expect(harnessWiredFor(undefined).id).toBe('claude-code');
    expect(wireConfigures('codex', 'codex')).toBe(true);
    expect(wireConfigures('claude-code', 'codex')).toBe(false);
    expect(wireConfigures('claude-code', undefined)).toBe(true);
  });
});
