import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { foreignAdapterNote, isInside, primaryCheckoutFor } from './entryGuard.js';

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

  // The zero-sum bug. One MCP entry serves EVERY worktree of the repo (Claude Code keys local scope
  // by repo root, ADR 143), and `musterd init` repoints it into whichever seat runs it. So the old
  // note fired in 11 of 12 dogfood seats and prescribed a repair that merely moved the failure to
  // the other 11 — unsatisfiable by construction for all but one seat.
  const primary = '/Users/x/agents';

  it('is silent when the adapter lives in the repo PRIMARY checkout — the shared install', () => {
    expect(
      foreignAdapterNote(entry(adapterIn(primary)), {
        workspaceDir: ryder,
        siblingDirs: [miley, primary],
        primaryCheckout: primary,
      }),
    ).toBeUndefined();
  });

  it('still reports a peer WORKTREE even when a primary checkout is known', () => {
    const note = foreignAdapterNote(entry(adapterIn(miley)), {
      workspaceDir: ryder,
      siblingDirs: [miley, primary],
      primaryCheckout: primary,
    });
    expect(note).toBeDefined();
    expect(note).toContain('agents-miley');
  });

  it('prescribes a shared install and warns AGAINST `musterd init` (ADR 165 zero-sum)', () => {
    const note = foreignAdapterNote(entry(adapterIn(miley)), {
      workspaceDir: ryder,
      siblingDirs: [miley],
      primaryCheckout: primary,
    });
    expect(note).toContain('shared install');
    // The old text prescribed `musterd init` as the repair. It must now steer away from it, because
    // one entry is shared by the whole worktree family: running it here just moves the drift line.
    expect(note).toContain('Do NOT run `musterd init`');
    expect(note).not.toMatch(/Re-run `musterd init` here/);
  });

  // ADR 173: `primaryCheckout: undefined` means "could not determine", which is NOT the same fact as
  // "there is no primary checkout". It keeps detecting (a note is advisory and harmless) but SAYS it
  // could not tell, rather than silently picking either verdict.
  it('names the abstention when the primary checkout could not be determined', () => {
    const note = foreignAdapterNote(entry(adapterIn(primary)), {
      workspaceDir: ryder,
      siblingDirs: [primary],
    });
    expect(note).toBeDefined();
    expect(note).toContain('could not determine');
  });
});

// The discriminator, on real files. It must answer "the primary checkout of THIS worktree's repo",
// derived from the worktree's own `.git` pointer — never "any neighbour that looks like a primary
// checkout". The first draft scanned siblings for a `.git` directory and picked /Users/nick/MoveTrail,
// an unrelated repo that merely sat beside the seats and carried a binding. These tests pin the
// pointer-following behaviour specifically so that scan can never come back.
describe('primaryCheckoutFor', () => {
  const root = mkdtempSync(join(tmpdir(), 'musterd-primary-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const dir = (name: string) => join(root, name);

  it('follows a worktree .git FILE to the primary checkout, ignoring unrelated repos beside it', () => {
    // Primary checkout with a real .git directory.
    mkdirSync(join(dir('agents'), '.git', 'worktrees', 'agents-ryder'), { recursive: true });
    // The seat worktree, whose .git file points into it.
    mkdirSync(dir('agents-ryder'), { recursive: true });
    writeFileSync(
      join(dir('agents-ryder'), '.git'),
      `gitdir: ${join(dir('agents'), '.git', 'worktrees', 'agents-ryder')}\n`,
    );
    // The trap: an unrelated repo beside them, also with a .git directory. Must not be the answer.
    mkdirSync(join(dir('MoveTrail'), '.git'), { recursive: true });
    expect(primaryCheckoutFor(dir('agents-ryder'))).toBe(dir('agents'));
  });

  it('answers itself for a primary checkout — a .git DIRECTORY', () => {
    expect(primaryCheckoutFor(dir('agents'))).toBe(dir('agents'));
  });

  it('resolves a RELATIVE gitdir pointer against the worktree', () => {
    mkdirSync(dir('agents-rel'), { recursive: true });
    writeFileSync(
      join(dir('agents-rel'), '.git'),
      'gitdir: ../agents/.git/worktrees/agents-rel\n',
    );
    expect(primaryCheckoutFor(dir('agents-rel'))).toBe(dir('agents'));
  });

  it('abstains — undefined — when there is no .git at all', () => {
    mkdirSync(dir('plain-folder'), { recursive: true });
    expect(primaryCheckoutFor(dir('plain-folder'))).toBeUndefined();
    expect(primaryCheckoutFor(dir('does-not-exist'))).toBeUndefined();
  });

  it('abstains on a pointer it cannot interpret rather than guessing', () => {
    mkdirSync(dir('weird'), { recursive: true });
    // A submodule-style pointer with no /worktrees/ segment — some other linking scheme.
    writeFileSync(join(dir('weird'), '.git'), 'gitdir: ../.git/modules/weird\n');
    expect(primaryCheckoutFor(dir('weird'))).toBeUndefined();
    // Not a pointer at all.
    mkdirSync(dir('garbage'), { recursive: true });
    writeFileSync(join(dir('garbage'), '.git'), 'not a gitdir line\n');
    expect(primaryCheckoutFor(dir('garbage'))).toBeUndefined();
  });
});
