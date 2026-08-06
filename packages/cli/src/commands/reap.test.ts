import { describe, expect, it } from 'vitest';
import { orphanPids, renderReapPlan, renderReapResult } from './reap.js';

const tick = (
  stacks: { classification: string; procs: number; rss_kb: number; pids: string }[],
) => ({
  ts: 1000,
  stacks,
  machine: { ts: 1000, swap_used_mb: 1500, swap_total_mb: 2048, free_mem_mb: 140 },
});

describe('orphanPids', () => {
  it('collects pids from orphaned stacks only', () => {
    const t = tick([
      { classification: 'orphaned', procs: 2, rss_kb: 20_000, pids: '[41,42]' },
      { classification: 'live', procs: 3, rss_kb: 90_000, pids: '[7,8,9]' },
      { classification: 'unattributed', procs: 1, rss_kb: 1000, pids: '[99]' },
    ]);
    expect(orphanPids(t)).toEqual([41, 42]);
  });

  it('tolerates a malformed pids blob (skips it, never throws)', () => {
    const t = tick([{ classification: 'orphaned', procs: 1, rss_kb: 1, pids: 'not-json' }]);
    expect(orphanPids(t)).toEqual([]);
  });
});

describe('renderReapPlan', () => {
  it('names the orphan count, RSS, and the --yes hint', () => {
    const out = renderReapPlan(
      tick([{ classification: 'orphaned', procs: 41, rss_kb: 614_400, pids: '[1,2]' }]),
    );
    expect(out).toContain('41 orphaned MCP sidecar procs');
    expect(out).toContain('~600 MB');
    expect(out).toContain('--yes');
  });

  it('says so plainly when there is nothing to reap', () => {
    const out = renderReapPlan(
      tick([{ classification: 'live', procs: 3, rss_kb: 1, pids: '[7]' }]),
    );
    expect(out).toContain('nothing to reap');
    expect(out).not.toContain('--yes');
  });
});

describe('renderReapResult', () => {
  it('reports killed pids and refused reasons', () => {
    const out = renderReapResult({
      killed: [41, 42],
      refused: [{ pid: 99, reason: 'not_found' }],
    });
    expect(out).toContain('killed 2 procs');
    expect(out).toContain('refused 1');
    expect(out).toContain('99 (not_found)');
  });

  it('an all-refused result reads as a refusal, not a success', () => {
    const out = renderReapResult({ killed: [], refused: [{ pid: 1, reason: 'not_sidecar' }] });
    expect(out).toContain('killed 0 procs');
    expect(out).toContain('not_sidecar');
  });
});
