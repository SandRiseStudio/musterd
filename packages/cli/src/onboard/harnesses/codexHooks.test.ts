import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_HOOK_MARKER,
  codexCommonDirRoot,
  inspectCodexHookDrift,
  installCodexHooks,
  removeCodexHooks,
} from './codexHooks.js';

describe('Codex project hooks', () => {
  let root: string;
  let hooksPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-codex-hooks-'));
    hooksPath = join(root, '.codex', 'hooks.json');
    mkdirSync(join(root, '.codex'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('adds the marker-owned causal hooks without removing user handlers', () => {
    const source = {
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] }],
      },
    };
    writeFileSync(hooksPath, JSON.stringify(source, null, 2));

    installCodexHooks(root);

    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(hooks.hooks.PostToolUse).toContainEqual(source.hooks.PostToolUse[0]);
    expect(JSON.stringify(hooks)).toContain(CODEX_HOOK_MARKER);
    expect(Object.keys(hooks.hooks)).toEqual(
      expect.arrayContaining(['SessionStart', 'SessionEnd', 'PostToolUse', 'UserPromptSubmit']),
    );
    expect(inspectCodexHookDrift(root)).toEqual([]);
  });

  it('installs a marker-owned UserPromptSubmit orient-nudge (ADR 333)', () => {
    installCodexHooks(root);
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const cmd = hooks.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command ?? '';
    expect(cmd).toContain('session orient-nudge');
    expect(cmd).toContain(CODEX_HOOK_MARKER);
    expect(cmd).not.toContain('codex-hook start');
  });

  it('removes only marker-owned hooks and leaves a user-only file intact', () => {
    const source = {
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] }],
      },
    };
    writeFileSync(hooksPath, JSON.stringify(source, null, 2));
    installCodexHooks(root);

    removeCodexHooks(root);

    expect(JSON.parse(readFileSync(hooksPath, 'utf8'))).toEqual(source);
  });

  it('reports malformed hooks without changing the user file', () => {
    writeFileSync(hooksPath, '{ malformed');

    installCodexHooks(root);
    removeCodexHooks(root);

    expect(readFileSync(hooksPath, 'utf8')).toBe('{ malformed');
    expect(inspectCodexHookDrift(root)[0]).toContain('malformed');
  });

  it('does not create a file when removing an absent install', () => {
    removeCodexHooks(root);
    expect(existsSync(hooksPath)).toBe(false);
  });
});

// codex-cli resolves `.codex/hooks.json` against the git COMMON dir's root, not the directory it
// actually runs in (lane 01M1JBH9CR, measured on seat gptbot, 2026-09-02) — a canary hook in a
// worktree's own `.codex/hooks.json` never fires; the identical file at the main checkout does.
describe('Codex hooks in a git worktree (common-dir resolution)', () => {
  let mainRoot: string;
  let worktreeRoot: string;

  beforeEach(() => {
    mainRoot = mkdtempSync(join(tmpdir(), 'musterd-codex-main-'));
    worktreeRoot = mkdtempSync(join(tmpdir(), 'musterd-codex-worktree-'));
    // The exact shape `git worktree add` writes: a `.git` FILE (not directory) naming the real
    // gitdir under the main checkout's `.git/worktrees/<name>`.
    writeFileSync(
      join(worktreeRoot, '.git'),
      `gitdir: ${join(mainRoot, '.git', 'worktrees', 'seat')}\n`,
    );
  });
  afterEach(() => {
    rmSync(mainRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  });

  it('resolves the main checkout as the common-dir root for a worktree', () => {
    expect(codexCommonDirRoot(worktreeRoot)).toBe(mainRoot);
  });

  it('returns undefined for a plain (non-worktree) checkout', () => {
    mkdirSync(join(mainRoot, '.git'));
    expect(codexCommonDirRoot(mainRoot)).toBeUndefined();
  });

  it('returns undefined when there is no .git at all', () => {
    const bare = mkdtempSync(join(tmpdir(), 'musterd-codex-bare-'));
    expect(codexCommonDirRoot(bare)).toBeUndefined();
    rmSync(bare, { recursive: true, force: true });
  });

  it('installCodexHooks writes both the worktree copy and the common-dir copy', () => {
    installCodexHooks(worktreeRoot);
    const worktreeHooks = JSON.parse(
      readFileSync(join(worktreeRoot, '.codex', 'hooks.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    const commonHooks = JSON.parse(
      readFileSync(join(mainRoot, '.codex', 'hooks.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(JSON.stringify(worktreeHooks)).toContain(CODEX_HOOK_MARKER);
    expect(JSON.stringify(commonHooks)).toContain(CODEX_HOOK_MARKER);
    expect(commonHooks).toEqual(worktreeHooks);
  });

  it('inspectCodexHookDrift reports drift when the common-dir copy is missing, even if the worktree copy looks healthy', () => {
    // Install normally (writes both copies), then delete the common-dir copy to reproduce the
    // exact bug this fixes: a healthy-looking worktree file that codex never actually reads.
    installCodexHooks(worktreeRoot);
    rmSync(join(mainRoot, '.codex'), { recursive: true, force: true });

    const drift = inspectCodexHookDrift(worktreeRoot);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('git common dir');
  });

  it('removeCodexHooks only touches the worktree copy, never the shared common-dir one', () => {
    installCodexHooks(worktreeRoot);
    removeCodexHooks(worktreeRoot);

    const worktreeHooks = JSON.parse(
      readFileSync(join(worktreeRoot, '.codex', 'hooks.json'), 'utf8'),
    ) as { hooks?: Record<string, unknown> };
    expect(worktreeHooks.hooks ?? {}).toEqual({});
    // The common-dir copy is shared by every worktree of this checkout — one seat unprovisioning
    // must not strip hooks another seat's worktree still needs.
    const commonHooks = JSON.parse(
      readFileSync(join(mainRoot, '.codex', 'hooks.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(JSON.stringify(commonHooks)).toContain(CODEX_HOOK_MARKER);
  });
});
