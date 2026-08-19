import { describe, expect, it } from 'vitest';
import { memoryFs, nodeClock, nodeProc, type HarnessContext } from '../reconcile/context.js';
import {
  MUSTERD_CORE_ID,
  musterdAdapter,
  musterdCoreFragments,
} from './musterd.js';

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

describe('the native musterd adapter (ADR 281)', () => {
  it('is always available, selectable, and Surface musterd', async () => {
    expect(musterdAdapter.id).toBe('musterd');
    expect(musterdAdapter.surface).toBe('musterd');
    expect((await musterdAdapter.availability(ctx())).available).toBe(true);
  });

  it('emits zero external fragments — the native host needs no external registration', async () => {
    const c = ctx();
    const target = await musterdAdapter.target(c);
    expect(target.containers).toEqual([]);
    expect(await musterdAdapter.desiredFragments(c, target)).toEqual([]);
  });
});

describe('the internal musterd-core fragment producer', () => {
  it('is not a selectable adapter id — internal only', () => {
    expect(MUSTERD_CORE_ID).toBe('musterd-core');
  });

  it('is desired whenever the desired set is nonempty, and not for an empty set', () => {
    expect(musterdCoreFragments(ctx(), ['claude-code']).length).toBeGreaterThan(0);
    expect(musterdCoreFragments(ctx(), ['musterd']).length).toBeGreaterThan(0);
    expect(musterdCoreFragments(ctx(), [])).toEqual([]);
  });

  it('produces folder-scoped intents rooted at the normalized worktree — the ledger owner id', () => {
    const intents = musterdCoreFragments(ctx('/w/a'), ['musterd']);
    for (const intent of intents) {
      expect(intent.scope).toBe('folder');
      expect(intent.harness).toBe(MUSTERD_CORE_ID);
      expect(intent.resourceKey).toContain('folder');
      expect(intent.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    // Same worktree, same desired set → identical intents (stable fingerprints).
    const again = musterdCoreFragments(ctx('/w/a'), ['musterd']);
    expect(again).toEqual(intents);
    // A sibling worktree owns DIFFERENT folder resources.
    const sibling = musterdCoreFragments(ctx('/w/b'), ['musterd']);
    expect(sibling.map((i) => i.resourceKey)).not.toEqual(intents.map((i) => i.resourceKey));
  });

  it('covers the canonical skill file', () => {
    const intents = musterdCoreFragments(ctx(), ['claude-code']);
    expect(intents.some((i) => i.fragmentKey.includes('skill'))).toBe(true);
  });
});
