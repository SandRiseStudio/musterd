import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_HOOK_MARKER,
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
