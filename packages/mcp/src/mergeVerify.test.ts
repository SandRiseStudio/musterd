import { describe, expect, it } from 'vitest';
import { verifyMerge, type GitExec } from './mergeVerify.js';

/** Scripted exec: keyed by git subcommand, returns exit codes; 'reject' throws (spawn failure). */
function fake(script: Record<string, number | 'reject'>): GitExec {
  return async (args) => {
    const key = args[0]!;
    const r = script[key];
    if (r === 'reject' || r === undefined) throw new Error(`spawn failed: ${key}`);
    return { code: r };
  };
}
const cwd = '/w';

describe('verifyMerge', () => {
  it('no sha → unattested (no git calls at all)', async () => {
    const exec: GitExec = async () => {
      throw new Error('must not be called');
    };
    expect(await verifyMerge({ cwd }, exec)).toBe('unattested');
  });

  it('fetch ok, object exists, ancestor → ancestor', async () => {
    expect(
      await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 0, 'cat-file': 0, 'merge-base': 0 })),
    ).toBe('ancestor');
  });

  it('fetch ok, object exists, not an ancestor → not_ancestor (positive evidence)', async () => {
    expect(
      await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 0, 'cat-file': 0, 'merge-base': 1 })),
    ).toBe('not_ancestor');
  });

  it('fetch FAILED and not an ancestor → fetch_failed, never not_ancestor on a stale ref', async () => {
    expect(
      await verifyMerge(
        { sha: 'abc123f', cwd },
        fake({ fetch: 128, 'cat-file': 0, 'merge-base': 1 }),
      ),
    ).toBe('fetch_failed');
  });

  it('fetch failed but STILL an ancestor → ancestor (a stale ref cannot fake a landing)', async () => {
    expect(
      await verifyMerge(
        { sha: 'abc123f', cwd },
        fake({ fetch: 128, 'cat-file': 0, 'merge-base': 0 }),
      ),
    ).toBe('ancestor');
  });

  it('fetch ok, sha not in this repo → unknown_object (cross-repo lane)', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 0, 'cat-file': 1 }))).toBe(
      'unknown_object',
    );
  });

  it('fetch failed and sha unknown → fetch_failed (cannot distinguish, abstain)', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 128, 'cat-file': 1 }))).toBe(
      'fetch_failed',
    );
  });

  it('merge-base errors (>1: no origin/main ref) → fetch_failed', async () => {
    expect(
      await verifyMerge(
        { sha: 'abc123f', cwd },
        fake({ fetch: 0, 'cat-file': 0, 'merge-base': 128 }),
      ),
    ).toBe('fetch_failed');
  });

  it('git spawn rejection anywhere → fetch_failed, never a throw', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 'reject' }))).toBe(
      'fetch_failed',
    );
  });
});
