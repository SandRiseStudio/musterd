import { describe, expect, it } from 'vitest';
import { foreignAdapterNote, isInside } from './entryGuard.js';

const entry = (adapterPath: string, env: Record<string, string> = {}) => ({
  command: '/usr/bin/node',
  args: [adapterPath],
  env: { MUSTERD_SERVER: 'http://127.0.0.1:4849', MUSTERD_TEAM: 'revive', ...env },
});

describe('isInside', () => {
  it('is path-segment aware — a name prefix is not containment', () => {
    expect(isInside('/Users/x/agents-ryder/pkg/i.js', '/Users/x/agents-ryder')).toBe(true);
    expect(isInside('/Users/x/agents-ryder', '/Users/x/agents-ryder')).toBe(true);
    // `agents-ryder2` must NOT read as inside `agents-ryder`, or the guard both over- and
    // under-fires on the sibling worktrees this exists to tell apart.
    expect(isInside('/Users/x/agents-ryder2/pkg/i.js', '/Users/x/agents-ryder')).toBe(false);
    expect(isInside('/Users/x/agents-miley/pkg/i.js', '/Users/x/agents-ryder')).toBe(false);
  });
});

describe('foreignAdapterNote', () => {
  const ryder = '/Users/x/agents-ryder';
  const miley = '/Users/x/agents-miley';
  const adapterIn = (ws: string) => `${ws}/packages/mcp/dist/index.js`;

  it('reports an adapter inside a sibling seat worktree (the shape found in the wild)', () => {
    const note = foreignAdapterNote(entry(adapterIn(miley)), {
      workspaceDir: ryder,
      siblingDirs: [miley],
    });
    expect(note).toBeDefined();
    expect(note).toContain('agents-miley');
    expect(note).toContain('agents-ryder');
  });

  it('is silent for an adapter inside the target workspace', () => {
    expect(
      foreignAdapterNote(entry(adapterIn(ryder)), { workspaceDir: ryder, siblingDirs: [miley] }),
    ).toBeUndefined();
  });

  it('is silent for a shared global install — the normal npm/brew layout', () => {
    expect(
      foreignAdapterNote(entry('/opt/homebrew/lib/node_modules/@musterd/mcp/dist/index.js'), {
        workspaceDir: ryder,
        siblingDirs: [miley],
      }),
    ).toBeUndefined();
  });

  it('is silent when the path is outside every known sibling', () => {
    expect(
      foreignAdapterNote(entry('/somewhere/else/dist/index.js'), {
        workspaceDir: ryder,
        siblingDirs: [miley],
      }),
    ).toBeUndefined();
  });
});
