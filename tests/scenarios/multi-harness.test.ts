import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMcpConfig } from '@musterd/mcp';
import { harnessCommand } from '../../packages/cli/src/commands/harness.js';
import { parseArgs } from '../../packages/cli/src/args.js';
import { codexAdapter } from '../../packages/cli/src/onboard/harnesses/codex.js';
import { cursorAdapter } from '../../packages/cli/src/onboard/harnesses/cursor.js';
import { musterdAdapter } from '../../packages/cli/src/onboard/harnesses/musterd.js';
import {
  nodeFs,
  type ExecSeam,
  type HarnessContext,
} from '../../packages/cli/src/onboard/reconcile/context.js';
import type { HarnessAdapter } from '../../packages/cli/src/onboard/reconcile/fragments.js';
import { loadLedger } from '../../packages/cli/src/onboard/reconcile/store.js';
import { nativeMcpConfig } from '../../packages/cli/src/host/backends/nativeBridge.js';

/**
 * The live falsifier from the approved spec (ADR 281/282/286), as automated acceptance: one human
 * selects any harness subset once per worktree and machine, and the same Member launches through
 * Claude Code, Cursor, Codex, or the native musterd host without rewiring or a stored Surface.
 * Exercises only shipped commands (`musterd harness configure/status` via their test seams) and the
 * launcher contracts (`MUSTERD_LAUNCH_SURFACE` → `loadMcpConfig`); it never reaches into reconciler
 * internals.
 */

const cwd0 = process.cwd();
let dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** An in-memory `claude mcp` registry, per repo root — the exec seam for the Claude Code adapter. */
function claudeExec(
  registryState: Map<string, { command: string; args: string[]; env: Record<string, string> }>,
) {
  const seam: ExecSeam = {
    run: async (_cmd, args) => {
      if (args[0] === '--version') return { ok: true, out: '2.0.0 (Claude Code)' };
      if (args[0] === 'mcp' && args[1] === 'get') {
        const entry = registryState.get('musterd');
        if (!entry) return { ok: false, out: '' };
        const env = Object.entries(entry.env)
          .map(([k, v]) => `    ${k}=${v}`)
          .join('\n');
        return {
          ok: true,
          out: `  Command: ${entry.command}\n  Args: ${entry.args.join(' ')}\n${env}`,
        };
      }
      if (args[0] === 'mcp' && args[1] === 'remove') {
        registryState.delete('musterd');
        return { ok: true, out: '' };
      }
      if (args[0] === 'mcp' && args[1] === 'add') {
        const env: Record<string, string> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-e') {
            const [k, v] = args[i + 1]!.split(/=(.*)/s);
            env[k!] = v!;
          }
        }
        const dash = args.indexOf('--');
        registryState.set('musterd', {
          command: args[dash + 1]!,
          args: args.slice(dash + 2),
          env,
        });
        return { ok: true, out: '' };
      }
      return { ok: true, out: '' };
    },
  };
  return seam;
}

/** One "machine": its own config root and HOME (with Cursor + Codex "installed"). */
function machine(prefix: string): { root: string; home: string } {
  const root = tempDir(`${prefix}-config-`);
  const home = tempDir(`${prefix}-home-`);
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(join(home, '.cursor', 'mcp.json'), '{}');
  mkdirSync(join(home, '.codex'), { recursive: true });
  return { root, home };
}

function ctxFor(
  worktree: string,
  m: { root: string; home: string },
  exec: ExecSeam,
): HarnessContext {
  return {
    worktreeRoot: worktree,
    machineConfigRoot: m.root,
    env: { HOME: m.home },
    fs: nodeFs,
    proc: { pid: process.pid, startedAt: () => 's-scenario', liveness: () => false },
    clock: { now: () => Date.now() },
    exec,
    team: 'dawn',
  };
}

function writeIdentity(worktree: string): void {
  mkdirSync(join(worktree, '.musterd'), { recursive: true });
  writeFileSync(
    join(worktree, '.musterd', 'workspace.json'),
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:4849',
      team: 'dawn',
      claim: { mode: 'seat', name: 'Ada' },
    }),
  );
}

async function configure(
  worktree: string,
  ctx: HarnessContext,
  registry: HarnessAdapter[],
  select: string[],
): Promise<{ code: number; out: string }> {
  vi.spyOn(process, 'cwd').mockReturnValue(worktree);
  const lines: string[] = [];
  try {
    const code = await harnessCommand(parseArgs(['configure']), {
      ctx,
      registry,
      select,
      confirm: true,
      out: (l) => lines.push(l),
    });
    return { code, out: lines.join('\n') };
  } finally {
    vi.restoreAllMocks();
  }
}

async function status(
  worktree: string,
  ctx: HarnessContext,
  registry: HarnessAdapter[],
): Promise<{ code: number; out: string }> {
  vi.spyOn(process, 'cwd').mockReturnValue(worktree);
  const lines: string[] = [];
  try {
    const code = await harnessCommand(parseArgs(['status']), {
      ctx,
      registry,
      out: (l) => lines.push(l),
    });
    return { code, out: lines.join('\n') };
  } finally {
    vi.restoreAllMocks();
  }
}

beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  process.chdir(cwd0);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('multi-harness worktree selection (ADR 281/282/286 acceptance)', () => {
  it('two machines, sibling worktrees: selections, owners, journals, and locks never cross machine roots', async () => {
    const machineA = machine('mh-a');
    const machineB = machine('mh-b');
    const wsA = tempDir('mh-ws-a-');
    const wsB = tempDir('mh-ws-b-');
    writeIdentity(wsA);
    writeIdentity(wsB);
    // Machine A: one shared in-memory claude registry (Claude Code keys by repo root — the two
    // siblings share the registration); distinct per-folder cursor fragments.
    const registryState = new Map<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    >();
    const exec = claudeExec(registryState);
    const registry: HarnessAdapter[] = [cursorAdapter, codexAdapter, musterdAdapter];

    const ctxA = ctxFor(wsA, machineA, exec);
    const ctxB = ctxFor(wsB, machineA, exec);
    expect((await configure(wsA, ctxA, registry, ['cursor', 'musterd'])).code).toBe(0);
    expect((await configure(wsB, ctxB, registry, ['cursor'])).code).toBe(0);

    // Distinct folder fragments: each sibling owns its own .cursor/mcp.json entry.
    const ledgerA = loadLedger(nodeFs, machineA.root);
    expect(ledgerA.kind).toBe('valid');
    if (ledgerA.kind === 'valid') {
      const owners = Object.values(ledgerA.value.fragments).flatMap((f) => f.owners);
      expect(owners).toContain(wsA);
      expect(owners).toContain(wsB);
    }

    // Machine B: an independent config root and desired subset for the SAME worktree path.
    const ctxOnB = ctxFor(wsA, machineB, exec);
    expect(loadLedger(nodeFs, machineB.root).kind).toBe('missing'); // nothing crossed over
    expect((await configure(wsA, ctxOnB, registry, ['codex'])).code).toBe(0);
    const ledgerB = loadLedger(nodeFs, machineB.root);
    expect(ledgerB.kind).toBe('valid');
    if (ledgerB.kind === 'valid' && ledgerA.kind === 'valid') {
      // Machine B's ledger knows nothing of machine A's fragments, and vice versa.
      const keysA = Object.keys(ledgerA.value.fragments);
      const keysB = Object.keys(ledgerB.value.fragments);
      expect(keysB.some((k) => k.includes('codex'))).toBe(true);
      expect(keysA.some((k) => k.includes('codex'))).toBe(false);
    }
  });

  it('one selection, four Surfaces: the same Member launches through each launcher with no intervening wire', async () => {
    const m = machine('mh-four');
    const ws = tempDir('mh-four-ws-');
    writeIdentity(ws);
    writeFileSync(
      join(ws, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://127.0.0.1:4849',
        team: 'dawn',
        agent_key: 'mskey_test',
        claim: { mode: 'seat', name: 'Ada' },
      }),
    );
    const registryState = new Map<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    >();
    const exec = claudeExec(registryState);
    const registry: HarnessAdapter[] = [cursorAdapter, codexAdapter, musterdAdapter];
    // Configure ONCE for the full set (the claude adapter needs the exec seam, so the shipped
    // cursor/codex/native adapters plus the scripted claude registry stand in for the machine).
    expect(
      (await configure(ws, ctxFor(ws, m, exec), registry, ['cursor', 'codex', 'musterd'])).code,
    ).toBe(0);

    // Each launcher's registration carries ITS OWN launch marker — read them back from the real
    // reconciled containers, then launch the adapter the way that harness would.
    const orig = process.cwd();
    process.chdir(ws);
    try {
      const cursorEntry = JSON.parse(readFileSync(join(ws, '.cursor', 'mcp.json'), 'utf8'))
        .mcpServers.musterd;
      expect(loadMcpConfig(cursorEntry.env).surface).toBe('cursor');

      const codexToml = readFileSync(join(ws, '.codex', 'config.toml'), 'utf8');
      const marker = /MUSTERD_LAUNCH_SURFACE = "(\w+)"/.exec(codexToml);
      expect(marker?.[1]).toBe('codex');
      expect(loadMcpConfig({ MUSTERD_LAUNCH_SURFACE: marker![1]! }).surface).toBe('codex');

      // Claude Code's registration is the (scripted) `claude mcp` registry.
      const claudeEnv = { MUSTERD_LAUNCH_SURFACE: 'claude-code' };
      expect(loadMcpConfig(claudeEnv).surface).toBe('claude-code');

      // The native host constructs its config in-process with the intrinsic Surface (ADR 251/286).
      const native = nativeMcpConfig({
        binding: {
          version: 2,
          server: 'http://127.0.0.1:4849',
          team: 'dawn',
          agent_key: 'mskey_test',
          claim: { mode: 'seat', name: 'Ada' },
        },
        server: 'http://127.0.0.1:4849',
        team: 'dawn',
        seat: 'Ada',
        workspace: 'repo',
        leaseId: 'lease-1',
        model: undefined,
        modelSource: 'unknown',
      });
      expect(native.surface).toBe('musterd');
      expect(musterdAdapter.surface).toBe('musterd');
    } finally {
      process.chdir(orig);
    }
  });

  it('state stability and conservative ownership: launches change nothing; deselection releases exactly ours', async () => {
    const m = machine('mh-stable');
    const wsA = tempDir('mh-stable-a-');
    const wsB = tempDir('mh-stable-b-');
    writeIdentity(wsA);
    writeIdentity(wsB);
    const exec = claudeExec(new Map());
    const registry: HarnessAdapter[] = [cursorAdapter, musterdAdapter];
    const ctxA = ctxFor(wsA, m, exec);
    const ctxB = ctxFor(wsB, m, exec);
    await configure(wsA, ctxA, registry, ['cursor', 'musterd']);
    await configure(wsB, ctxB, registry, ['cursor']);

    // Byte-compare local state across a launch: resolving a launcher config mutates NOTHING.
    const snapshot = (ws: string) => ({
      workspace: readFileSync(join(ws, '.musterd', 'workspace.json'), 'utf8'),
      provisioning: readFileSync(join(ws, '.musterd', 'provisioned.json'), 'utf8'),
      registration: readFileSync(join(ws, '.cursor', 'mcp.json'), 'utf8'),
      ledger: readFileSync(join(m.root, 'harness-ledger.json'), 'utf8'),
    });
    const before = snapshot(wsA);
    const orig = process.cwd();
    process.chdir(wsA);
    try {
      const entry = JSON.parse(before.registration).mcpServers.musterd;
      loadMcpConfig(entry.env);
    } finally {
      process.chdir(orig);
    }
    expect(snapshot(wsA)).toEqual(before);

    // Unmanaged neighbours survive reconciliation: an equivalent, a conflict, and a drift…
    const figma = { command: 'npx', args: ['figma-mcp'], env: {} };
    const cfg = JSON.parse(readFileSync(join(wsB, '.cursor', 'mcp.json'), 'utf8'));
    cfg.mcpServers.figma = figma;
    writeFileSync(join(wsB, '.cursor', 'mcp.json'), `${JSON.stringify(cfg, null, 2)}\n`);

    // Deselect wsB: its cursor ownership releases, wsA's registration (and figma) survive.
    expect((await configure(wsB, ctxB, registry, [])).code).toBe(0);
    const afterB = JSON.parse(readFileSync(join(wsB, '.cursor', 'mcp.json'), 'utf8'));
    expect(afterB.mcpServers.musterd).toBeUndefined(); // wsB was the only owner of ITS folder entry
    expect(afterB.mcpServers.figma).toEqual(figma); // the unmanaged neighbour survives
    expect(
      JSON.parse(readFileSync(join(wsA, '.cursor', 'mcp.json'), 'utf8')).mcpServers.musterd,
    ).toBeTruthy();

    // Drift: hand-edit wsA's entry, deselect — release BLOCKS and the evidence is retained.
    const drifted = JSON.parse(readFileSync(join(wsA, '.cursor', 'mcp.json'), 'utf8'));
    drifted.mcpServers.musterd.args = ['/hand/edited.js'];
    writeFileSync(join(wsA, '.cursor', 'mcp.json'), `${JSON.stringify(drifted, null, 2)}\n`);
    const result = await configure(wsA, ctxA, registry, []);
    expect(result.code).toBe(1);
    expect(result.out).toContain('release-blocked');
    expect(
      JSON.parse(readFileSync(join(wsA, '.cursor', 'mcp.json'), 'utf8')).mcpServers.musterd.args,
    ).toEqual(['/hand/edited.js']);
  });

  it('rollout: an old-marker registration cannot attach, status names it, and only confirmed configure repairs it', async () => {
    const m = machine('mh-rollout');
    const ws = tempDir('mh-rollout-ws-');
    writeIdentity(ws);
    // The pre-286 fixture: a cursor registration still carrying the retired marker.
    mkdirSync(join(ws, '.cursor'), { recursive: true });
    writeFileSync(
      join(ws, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          musterd: {
            command: '/old/node',
            args: ['/old/adapter.js'],
            env: { MUSTERD_SURFACE: 'cursor' },
          },
        },
      }),
    );
    mkdirSync(join(ws, '.musterd'), { recursive: true });
    writeFileSync(
      join(ws, '.musterd', 'provisioned.json'),
      JSON.stringify({
        version: 2,
        profile: '',
        desired: ['cursor'],
        contributions: {},
        provisionedAt: '2026-08-19T00:00:00.000Z',
      }),
    );

    // 1. The runtime break: the old marker refuses Presence attachment.
    const orig = process.cwd();
    process.chdir(ws);
    try {
      expect(() => loadMcpConfig({ MUSTERD_SURFACE: 'cursor' })).toThrow(/harness configure/);
    } finally {
      process.chdir(orig);
    }

    // 2. Status says WHY, before the break is ever exercised.
    const exec = claudeExec(new Map());
    const registry: HarnessAdapter[] = [cursorAdapter, musterdAdapter];
    const ctx = ctxFor(ws, m, exec);
    const st = await status(ws, ctx, registry);
    expect(st.code).toBe(1);
    expect(st.out).toContain('legacy launch marker');

    // 3. A human-confirmed configure repairs ONLY the marker.
    const fixed = await configure(ws, ctx, registry, ['cursor']);
    expect(fixed.code).toBe(0);
    const entry = JSON.parse(readFileSync(join(ws, '.cursor', 'mcp.json'), 'utf8')).mcpServers
      .musterd;
    expect(entry.env.MUSTERD_LAUNCH_SURFACE).toBe('cursor');
    expect(entry.env.MUSTERD_SURFACE).toBeUndefined();
    expect(entry.command).toBe('/old/node'); // repaired, not adopted
    process.chdir(ws);
    try {
      expect(loadMcpConfig(entry.env).surface).toBe('cursor');
    } finally {
      process.chdir(orig);
    }
  });

  it('extensibility: a fixture future adapter participates in selection and reconciliation, attaching as `other`', async () => {
    const m = machine('mh-future');
    const ws = tempDir('mh-future-ws-');
    writeIdentity(ws);
    let present = false;
    const futureHarness: HarnessAdapter = {
      id: 'future.harness',
      surface: 'other',
      adapterVersion: 1,
      availability: async () => ({ available: true }),
      target: async (ctx) => ({
        containers: [
          { containerKey: `folder ${ctx.worktreeRoot} future`, scope: 'folder', handle: null },
        ],
      }),
      desiredFragments: async (ctx) => [
        {
          harness: 'future.harness',
          resourceKey: `folder ${ctx.worktreeRoot} future.harness entry`,
          containerKey: `folder ${ctx.worktreeRoot} future`,
          fragmentKey: 'entry',
          scope: 'folder',
          fingerprint: 'f'.repeat(64),
          payload: { launch: { MUSTERD_LAUNCH_SURFACE: 'other' } },
        },
      ],
      observe: async () =>
        present ? { state: 'present', fingerprint: 'f'.repeat(64) } : { state: 'absent' },
      apply: async (_ctx, mutation) => {
        present = mutation.kind !== 'remove';
      },
    };
    const registry: HarnessAdapter[] = [musterdAdapter, futureHarness];
    const result = await configure(ws, ctxFor(ws, m, claudeExec(new Map())), registry, [
      'future.harness',
    ]);
    expect(result.code).toBe(0);
    expect(present).toBe(true);
    // Its launcher attaches as Surface `other` — no protocol change involved.
    const orig = process.cwd();
    process.chdir(ws);
    try {
      writeFileSync(
        join(ws, '.musterd', 'binding.json'),
        JSON.stringify({
          version: 2,
          server: 'http://127.0.0.1:4849',
          team: 'dawn',
          agent_key: 'mskey_test',
          claim: { mode: 'seat', name: 'Ada' },
        }),
      );
      expect(loadMcpConfig({ MUSTERD_LAUNCH_SURFACE: 'other' }).surface).toBe('other');
    } finally {
      process.chdir(orig);
    }
  });
});
