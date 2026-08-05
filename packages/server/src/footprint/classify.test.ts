import { describe, expect, it } from 'vitest';
import { buildStacks, isSidecar, type ProcSample } from './classify.js';

const harness = (pid: number): ProcSample => ({
  pid,
  ppid: 1,
  rssKb: 100_000,
  command: '/Users/n/.local/bin/claude',
});
const sidecar = (
  pid: number,
  ppid: number,
  command = 'npm exec chrome-devtools-mcp@1.6.0',
): ProcSample => ({ pid, ppid, rssKb: 20_000, command });

describe('isSidecar', () => {
  it('matches the sidecar families measured on 2026-08-05', () => {
    for (const cmd of [
      'node /Users/n/agents/packages/mcp/dist/index.js',
      'npm exec @playwright/mcp@latest',
      'npm exec mcp-remote https://observability.mcp.cloudflare.com/mcp',
      'node /x/node_modules/.bin/mcp-server-supabase --access-token t',
      'chrome-devtools-mcp',
      '/Users/n/.fly/bin/flyctl mcp server',
      'node /x/node_modules/.bin/mcp-pdf-server --stdio',
      '/Users/n/.cache/uv/archive-v0/x/bin/elevenlabs-mcp',
    ])
      expect(isSidecar(cmd), cmd).toBe(true);
  });

  it('does not match the daemon, plain node, harnesses, or shells', () => {
    for (const cmd of [
      'node /Users/n/agents/packages/cli/dist/bin.js serve',
      'node build.js',
      '/bin/zsh',
      '/Users/n/.local/bin/claude',
      'npm exec @modelcontextprotocol/server-pdf --stdio', // launcher wrapper, not the server
    ])
      expect(isSidecar(cmd), cmd).toBe(false);
  });
});

describe('buildStacks', () => {
  it('groups sidecars under a living harness ancestor as one live stack', () => {
    // 13 is nested under sidecar 12 — it must join the launcher's stack, not split.
    const procs = [harness(10), sidecar(11, 10), sidecar(12, 10), sidecar(13, 12)];
    const stacks = buildStacks(procs);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toMatchObject({ classification: 'live', parentPid: 10, procs: 3 });
  });

  it('reparented sidecars (ppid 1) are one orphaned stack even though launchd is everyone’s ancestor', () => {
    const procs = [sidecar(20, 1), sidecar(21, 1, 'npm exec mcp-remote https://x/mcp')];
    const stacks = buildStacks(procs);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toMatchObject({ classification: 'orphaned', parentPid: null, procs: 2 });
  });

  it('a sidecar with no harness ancestor and a living parent is unattributed, never guessed', () => {
    const shell: ProcSample = { pid: 30, ppid: 1, rssKb: 1000, command: '/bin/zsh' };
    const procs = [shell, sidecar(31, 30)];
    const stacks = buildStacks(procs);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.classification).toBe('unattributed');
  });

  it('separate harnesses produce separate live stacks', () => {
    const procs = [harness(10), harness(40), sidecar(11, 10), sidecar(41, 40)];
    const keys = buildStacks(procs)
      .map((s) => s.parentPid)
      .sort();
    expect(keys).toEqual([10, 40]);
  });

  it('sums rss and collects pids per stack', () => {
    const procs = [harness(10), sidecar(11, 10), sidecar(12, 10)];
    const s = buildStacks(procs)[0]!;
    expect(s.rssKb).toBe(40_000);
    expect([...s.pids].sort()).toEqual([11, 12]);
  });
});
