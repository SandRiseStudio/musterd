import { describe, expect, it } from 'vitest';
import { memoryFs, nodeClock, nodeProc, type HarnessContext } from './context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  machineResourceKey,
  registryOrder,
  repoSharedResourceKey,
  resolveAdapter,
  surfaceForAdapter,
  type HarnessAdapter,
} from './fragments.js';
import { harnessAdapters } from '../harnesses/index.js';

function ctx(worktreeRoot = '/w/a'): HarnessContext {
  return {
    worktreeRoot,
    machineConfigRoot: '/machine/.musterd',
    env: {},
    fs: memoryFs(),
    proc: nodeProc,
    clock: nodeClock,
  };
}

/** A fixture future adapter — resolvable with NO protocol change, attaching as Surface `other`. */
const futureHarness: HarnessAdapter = {
  id: 'future.harness',
  surface: 'other',
  adapterVersion: 1,
  availability: async () => ({ available: true }),
  target: async () => ({ containers: [] }),
  desiredFragments: async () => [],
  observe: async () => ({ state: 'absent' }),
  apply: async () => {},
};

describe('adapter registry (ADR 281)', () => {
  it('shipped registry order is exactly claude-code, cursor, codex, musterd', () => {
    expect(harnessAdapters().map((a) => a.id)).toEqual([
      'claude-code',
      'cursor',
      'codex',
      'musterd',
    ]);
  });

  it('registryOrder puts shipped ids in registry order and unknown ids after, alphabetically', () => {
    const shuffled = [futureHarness, ...harnessAdapters()].reverse();
    expect(registryOrder(shuffled).map((a) => a.id)).toEqual([
      'claude-code',
      'cursor',
      'codex',
      'musterd',
      'future.harness',
    ]);
  });

  it('a future adapter resolves by id without protocol changes and maps to Surface other', () => {
    const registry = [...harnessAdapters(), futureHarness];
    const resolved = resolveAdapter('future.harness', registry);
    expect(resolved?.id).toBe('future.harness');
    expect(surfaceForAdapter(resolved!)).toBe('other');
    expect(resolveAdapter('никогда', registry)).toBeUndefined();
  });
});

describe('canonical fingerprints', () => {
  it('payloads with different object key order hash identically', () => {
    const a = canonicalFingerprint({ b: 1, a: { d: [1, { z: 2, y: 3 }], c: 'x' } });
    const b = canonicalFingerprint({ a: { c: 'x', d: [1, { y: 3, z: 2 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different payloads hash differently, and array order matters', () => {
    expect(canonicalFingerprint({ a: 1 })).not.toBe(canonicalFingerprint({ a: 2 }));
    expect(canonicalFingerprint([1, 2])).not.toBe(canonicalFingerprint([2, 1]));
  });
});

describe('resource keys distinguish scope (ADR 282 §3)', () => {
  it('folder keys include the normalized worktree root', () => {
    const a = folderResourceKey('/w/a', 'claude-code', 'hooks.session');
    const b = folderResourceKey('/w/b', 'claude-code', 'hooks.session');
    expect(a).not.toBe(b);
    expect(a).toContain('folder');
  });

  it('repo-shared keys include repository root + registration identity, not the worktree', () => {
    const a = repoSharedResourceKey('/repo', 'musterd', 'claude-code', 'mcp.musterd');
    const b = repoSharedResourceKey('/repo', 'musterd', 'claude-code', 'mcp.musterd');
    expect(a).toBe(b); // two sibling worktrees of one repo share the registration
    expect(repoSharedResourceKey('/other', 'musterd', 'claude-code', 'mcp.musterd')).not.toBe(a);
    expect(repoSharedResourceKey('/repo', 'else', 'claude-code', 'mcp.musterd')).not.toBe(a);
  });

  it('machine keys carry no worktree or repository discriminator', () => {
    const key = machineResourceKey('codex', 'mcp_servers.musterd');
    expect(key).not.toContain('/w/');
    expect(key).not.toContain('/repo');
    expect(key).toContain('machine');
  });

  it('the three scopes never collide for the same fragment key', () => {
    const keys = [
      folderResourceKey('/w/a', 'codex', 'k'),
      repoSharedResourceKey('/w/a', 'r', 'codex', 'k'),
      machineResourceKey('codex', 'k'),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});

describe('the converted external adapters', () => {
  it('every external adapter emits fingerprinted fragments through the injected seams', async () => {
    const c = ctx();
    for (const adapter of harnessAdapters()) {
      if (adapter.id === 'musterd') continue;
      const target = await adapter.target(c);
      expect(target.containers.length).toBeGreaterThan(0);
      const intents = await adapter.desiredFragments(c, target);
      expect(intents.length).toBeGreaterThan(0);
      for (const intent of intents) {
        expect(intent.harness).toBe(adapter.id);
        expect(intent.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});
