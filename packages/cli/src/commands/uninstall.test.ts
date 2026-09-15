import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uninstallCommand } from './uninstall.js';

let cwd: string;
let origCwd: string;
let cfgPath: string;

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-uninstall-'));
  process.chdir(cwd);
  cwd = process.cwd();
  cfgPath = join(cwd, 'config.json');
  process.env['MUSTERD_CONFIG'] = cfgPath;
});
afterEach(() => {
  process.chdir(origCwd);
  delete process.env['MUSTERD_CONFIG'];
});

function parsed(flags: Record<string, string | boolean> = {}) {
  return { positionals: [], flags, metaPairs: [] };
}

describe('uninstallCommand', () => {
  it('reports nothing to do in a clean folder', async () => {
    expect(await uninstallCommand(parsed({ force: true }))).toBe(0);
  });

  it('refuses without --force when not a TTY', async () => {
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(
      join(cwd, '.musterd', 'provisioned.json'),
      JSON.stringify({
        version: 1,
        role: 'frontend',
        harness: 'cursor',
        mcpServers: ['figma'],
        permissions: { allow: [], ask: [], deny: [] },
        provisionedAt: '2026-06-23T00:00:00.000Z',
      }),
    );
    expect(await uninstallCommand(parsed())).toBe(2); // stdin is not a TTY in vitest
  });

  it('removes provisioned + musterd servers, strips the primer, and clears local state', async () => {
    // a cursor-provisioned folder: musterd + figma + a user server, a manifest, a binding, a primer
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(
      join(cwd, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          musterd: { command: 'node', args: [] },
          figma: { command: 'npx', args: [] },
          mine: { command: 'x', args: [] },
        },
      }),
    );
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(
      join(cwd, '.musterd', 'provisioned.json'),
      JSON.stringify({
        version: 1,
        role: 'frontend',
        harness: 'cursor',
        mcpServers: ['figma'],
        permissions: { allow: [], ask: [], deny: [] },
        provisionedAt: '2026-06-23T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(cwd, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://localhost:4849',
        team: 'dawn',
        agent_key: 'mskey_x',
        claim: { mode: 'seat', name: 'Ada' },
      }),
    );
    writeFileSync(
      join(cwd, 'AGENTS.md'),
      '# My project\n\nhello\n\n<!-- musterd:start (managed) -->\nprimer\n<!-- musterd:end -->\n',
    );

    expect(await uninstallCommand(parsed({ force: true }))).toBe(0);

    const cursorCfg = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorCfg.mcpServers.figma).toBeUndefined(); // provisioned → removed
    expect(cursorCfg.mcpServers.musterd).toBeUndefined(); // musterd server → removed
    expect(cursorCfg.mcpServers.mine).toBeTruthy(); // user's own → kept

    const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# My project'); // user prose kept
    expect(agents).not.toContain('musterd:start'); // primer block stripped

    expect(existsSync(join(cwd, '.musterd', 'provisioned.json'))).toBe(false);
    expect(existsSync(join(cwd, '.musterd', 'binding.json'))).toBe(false);
  });

  it('resolves the harness by the captured session when there is no manifest', async () => {
    // a configure-only folder (no role provisioned): just the musterd server + a binding whose
    // hook-captured session names the harness (identity declares no surface since ADR 281)
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(
      join(cwd, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { musterd: { command: 'node', args: [] } } }),
    );
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(
      join(cwd, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://localhost:4849',
        team: 'dawn',
        agent_key: 'mskey_x',
        claim: { mode: 'seat', name: 'Ada' },
        session: { harness: 'cursor', id: 'sid-1', started_at: 1 },
      }),
    );

    expect(await uninstallCommand(parsed({ force: true }))).toBe(0);
    const cursorCfg = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorCfg.mcpServers.musterd).toBeUndefined();
  });
});

describe('uninstallCommand — v2 reconcile-to-empty (ADR 282)', () => {
  const writeV2 = (desired: string[], contributions: Record<string, string[]> = {}) => {
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(
      join(cwd, '.musterd', 'workspace.json'),
      JSON.stringify({ version: 2, server: 'http://localhost:4849', team: 'dawn' }),
    );
    writeFileSync(
      join(cwd, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://localhost:4849',
        team: 'dawn',
        agent_key: 'mskey_x',
        claim: { mode: 'seat', name: 'Ada' },
      }),
    );
    writeFileSync(
      join(cwd, '.musterd', 'provisioned.json'),
      JSON.stringify({
        version: 3,
        toolkit: '',
        desired,
        contributions,
        provisionedAt: '2026-08-19T00:00:00.000Z',
      }),
    );
  };

  it('reconciles to an empty set, then deletes workspace, binding, and manifest', async () => {
    const machineRoot = mkdtempSync(join(tmpdir(), 'musterd-uninstall-machine-'));
    const { nodeFs } = await import('../onboard/reconcile/context.js');
    const { canonicalFingerprint, folderResourceKey } =
      await import('../onboard/reconcile/fragments.js');
    const { reconcileHarnesses } = await import('../onboard/reconcile/engine.js');
    const payload = { entry: 'fake-a' };
    let observed: { state: 'absent' } | { state: 'present'; fingerprint: string } = {
      state: 'absent',
    };
    const adapter = {
      id: 'fake-a',
      surface: 'other' as const,
      adapterVersion: 1,
      availability: async () => ({ available: true }),
      target: async () => ({
        containers: [
          { containerKey: `folder ${cwd} fake-a`, scope: 'folder' as const, handle: null },
        ],
      }),
      desiredFragments: async () => [
        {
          harness: 'fake-a',
          resourceKey: folderResourceKey(cwd, 'fake-a', 'entry'),
          containerKey: `folder ${cwd} fake-a`,
          fragmentKey: 'entry',
          scope: 'folder' as const,
          fingerprint: canonicalFingerprint(payload),
          payload,
        },
      ],
      observe: async () => observed,
      apply: async (_ctx: unknown, mutation: { kind: string; intent: { fingerprint: string } }) => {
        observed =
          mutation.kind === 'remove'
            ? { state: 'absent' }
            : { state: 'present', fingerprint: mutation.intent.fingerprint };
      },
    };
    const ctx = {
      worktreeRoot: cwd,
      machineConfigRoot: machineRoot,
      env: {},
      fs: nodeFs,
      proc: { pid: process.pid, startedAt: () => 's-test', liveness: () => false },
      clock: { now: () => Date.now() },
    };
    writeV2(['fake-a']);
    // Configure the fragment into place first, so uninstall has something owned to release.
    await reconcileHarnesses(ctx, ['fake-a'], { legacyRepair: false, registry: [adapter] });
    expect(observed.state).toBe('present');

    expect(await uninstallCommand(parsed({ force: true }), { ctx, registry: [adapter] })).toBe(0);
    expect(observed.state).toBe('absent'); // the owned fragment was removed
    expect(existsSync(join(cwd, '.musterd', 'workspace.json'))).toBe(false);
    expect(existsSync(join(cwd, '.musterd', 'binding.json'))).toBe(false);
    expect(existsSync(join(cwd, '.musterd', 'provisioned.json'))).toBe(false);
  });

  it('a blocked release returns nonzero and retains identity + manifest + evidence', async () => {
    const machineRoot = mkdtempSync(join(tmpdir(), 'musterd-uninstall-machine2-'));
    const { nodeFs } = await import('../onboard/reconcile/context.js');
    const { canonicalFingerprint, folderResourceKey } =
      await import('../onboard/reconcile/fragments.js');
    const { saveLedger } = await import('../onboard/reconcile/store.js');
    const resource = folderResourceKey(cwd, 'fake-a', 'entry');
    const ctx = {
      worktreeRoot: cwd,
      machineConfigRoot: machineRoot,
      env: {},
      fs: nodeFs,
      proc: { pid: process.pid, startedAt: () => 's-test', liveness: () => false },
      clock: { now: () => Date.now() },
    };
    // Owned in the ledger, but physically DRIFTED — release must block.
    saveLedger(nodeFs, machineRoot, {
      version: 1,
      fragments: {
        [resource]: {
          harness: 'fake-a',
          scope: 'folder',
          containerKey: `folder ${cwd} fake-a`,
          fragmentKey: 'entry',
          fingerprint: canonicalFingerprint({ entry: 'fake-a' }),
          owners: [cwd],
          adapterVersion: 1,
        },
      },
    });
    const adapter = {
      id: 'fake-a',
      surface: 'other' as const,
      adapterVersion: 1,
      availability: async () => ({ available: true }),
      target: async () => ({ containers: [] }),
      desiredFragments: async () => [],
      observe: async () => ({ state: 'present' as const, fingerprint: 'd'.repeat(64) }),
      apply: async () => {},
    };
    writeV2([], { 'fake-a': [resource] });

    expect(await uninstallCommand(parsed({ force: true }), { ctx, registry: [adapter] })).toBe(1);
    expect(existsSync(join(cwd, '.musterd', 'workspace.json'))).toBe(true);
    expect(existsSync(join(cwd, '.musterd', 'binding.json'))).toBe(true);
    expect(existsSync(join(cwd, '.musterd', 'provisioned.json'))).toBe(true);
  });
});
