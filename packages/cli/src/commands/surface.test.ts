import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { declineSurface, isDeclined } from '../onboard/declined.js';
import {
  claudeRefusableSurfaces,
  inspectClaudeStatuslineDrift,
  installMusterdHooks,
  installMusterdStatusline,
  surfaceName,
  SURFACE_MACHINE_PROMPT_SUBMIT,
  SURFACE_MACHINE_SESSION_START,
  SURFACE_STATUSLINE,
} from '../onboard/harnesses/claudeCode.js';
import { surfaceCommand } from './surface.js';

describe('musterd surface (ADR 332)', () => {
  let cwd: string;
  let globalDir: string;
  let out: string;

  const run = (...argv: string[]): number => surfaceCommand(parseArgs(argv));

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-surface-'));
    // `installMusterdHooks` writes the machine-wide settings too, so the global path must be
    // redirected before any test calls it — otherwise a unit test edits the developer's own
    // ~/.claude/settings.json. Same isolation claudeCode.hooks.test.ts uses.
    globalDir = mkdtempSync(join(tmpdir(), 'musterd-surface-global-'));
    process.env['CLAUDE_CONFIG_DIR'] = globalDir;
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out += String(c);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['CLAUDE_CONFIG_DIR'];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('lists the refusable surfaces, marking the ones already declined', () => {
    expect(run('list')).toBe(0);
    expect(out).toContain(SURFACE_STATUSLINE);
    expect(out).not.toContain('declined');

    out = '';
    declineSurface(cwd, SURFACE_STATUSLINE, 'nick');
    run('list');
    expect(out).toContain('declined');
    expect(out).toContain('nick');
  });

  // A refusal for a name this build no longer offers is still the user's record. Hiding it would
  // make `accept` unspellable for a name nothing lists.
  it('lists a refusal this build does not recognise, marked as such', () => {
    declineSurface(cwd, 'codex:someSlot');
    run('list');
    expect(out).toContain('codex:someSlot');
    expect(out).toContain('unknown to this build');
  });

  it('decline removes the surface as well as recording it — one command, one outcome', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}\n', 'utf8');
    installMusterdStatusline(cwd);
    expect(inspectClaudeStatuslineDrift(cwd)).toEqual([]);

    expect(run('decline', SURFACE_STATUSLINE)).toBe(0);
    const settings: unknown = JSON.parse(
      readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'),
    );
    expect((settings as { statusLine?: unknown }).statusLine).toBeUndefined();
    expect(isDeclined(cwd, SURFACE_STATUSLINE)).toBe(true);
    // …and the drift check that would have nagged about it now says nothing at all.
    expect(inspectClaudeStatuslineDrift(cwd)).toEqual([]);
  });

  // ryder's REQUIRED on #1089: `decline` accepted all six hook names and removed only the
  // statusline, so the tombstone claimed a refusal while the hook stayed installed and kept firing
  // every turn — the exact lie the ADR's own sentence forbids. The test above missed it because the
  // statusline is the one surface that DID get removed.
  it('decline removes a declined HOOK too, not just the statusline', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}\n', 'utf8');
    installMusterdHooks(cwd);
    const hooksNow = (): Record<string, unknown[]> =>
      (
        JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8')) as {
          hooks?: Record<string, unknown[]>;
        }
      ).hooks ?? {};
    expect(hooksNow()['PostToolUse']).toHaveLength(1);

    expect(run('decline', surfaceName('PostToolUse'))).toBe(0);
    expect(hooksNow()['PostToolUse']).toBeUndefined();
    expect(isDeclined(cwd, surfaceName('PostToolUse'))).toBe(true);
    // The other slots are untouched — declining one surface is not a de-provisioning.
    expect(hooksNow()['Notification']).toHaveLength(1);
  });

  // A surface is a SLOT, not an entry: two musterd hooks share the PreToolUse event (the ADR 150
  // lane gate and the ADR 167 observer), and one name has to answer for both — otherwise declining
  // `claude-code:PreToolUse` leaves half the slot firing, which is the same lie in miniature.
  it('declining a slot two musterd hooks share removes both, and the slot is listed once', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}\n', 'utf8');
    installMusterdHooks(cwd);
    const preToolUse = (): unknown[] =>
      (
        JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8')) as {
          hooks?: Record<string, unknown[]>;
        }
      ).hooks?.['PreToolUse'] ?? [];
    expect(preToolUse()).toHaveLength(2);

    expect(run('decline', surfaceName('PreToolUse'))).toBe(0);
    expect(preToolUse()).toHaveLength(0);

    const listed = claudeRefusableSurfaces();
    expect(listed).toEqual([...new Set(listed)]);
  });

  // ryder's round-2 REQUIRED on #1089: `claude-code:SessionStart` named TWO surfaces with two
  // lifetimes — the project-local capture hook and the machine-wide orientation hook, in different
  // files. Declining it removed the local half and left the global one firing under a tombstone
  // saying otherwise. The machine-wide hooks have their own names now, and the local name is honest
  // about covering only what it can remove.
  it('declining the local SessionStart name does not claim the machine-wide hook', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}\n', 'utf8');
    installMusterdHooks(cwd);
    const globalSessionStart = (): unknown[] =>
      (
        JSON.parse(readFileSync(join(globalDir, 'settings.json'), 'utf8')) as {
          hooks?: Record<string, unknown[]>;
        }
      ).hooks?.['SessionStart'] ?? [];
    expect(globalSessionStart()).toHaveLength(1);

    expect(run('decline', surfaceName('SessionStart'))).toBe(0);
    // The machine-wide entry is untouched — it serves every other folder on this machine…
    expect(globalSessionStart()).toHaveLength(1);
    // …and it is NOT what this name claimed to refuse: the machine surface has its own tombstone.
    expect(isDeclined(cwd, SURFACE_MACHINE_SESSION_START)).toBe(false);
    expect(claudeRefusableSurfaces()).toContain(SURFACE_MACHINE_SESSION_START);
  });

  // A surface that cannot be removed for one folder is still refusable — the hook reads the
  // tombstone at fire time. What must never happen is a tombstone with no enforcement at all.
  //
  // This case RUNS the installed hook rather than reading it. The assertion it replaced checked
  // that the command string contained `grep -q '"<surface>"'` and `.musterd/declined.json` — both
  // survive any mutation that keeps the grep and drops the exit (`&& exit 0` → `; ` passes it), so
  // it could not tell enforcement from decoration. Silence is the claim; only running produces it.
  it('declining a machine-wide hook actually silences it here, says so, and leaves it installed', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}\n', 'utf8');
    installMusterdHooks(cwd);
    // The hook self-gates on the committed primer: without this it exits before reaching the
    // tombstone clause, and both halves below would be silent for the wrong reason.
    writeFileSync(join(cwd, 'AGENTS.md'), '<!-- musterd:start -->\n', 'utf8');

    const global = JSON.parse(readFileSync(join(globalDir, 'settings.json'), 'utf8')) as {
      hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
    };
    const cmd = global.hooks?.['UserPromptSubmit']?.[0]?.hooks?.[0]?.command ?? '';
    expect(cmd).not.toBe('');

    /** Fire the hook the way Claude Code does: this folder as CLAUDE_PROJECT_DIR, its stdout kept.
     *  PATH is stripped to the system utilities so the `command -v musterd` clause stays false —
     *  a real CLI on PATH would make this test spawn daemon-touching subprocesses. */
    const fire = (): string =>
      execFileSync('sh', ['-c', cmd], {
        env: { PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: cwd },
        encoding: 'utf8',
      });

    // Installed and firing, before any refusal.
    expect(fire()).toContain('musterd:');

    expect(run('decline', SURFACE_MACHINE_PROMPT_SUBMIT)).toBe(0);
    expect(isDeclined(cwd, SURFACE_MACHINE_PROMPT_SUBMIT)).toBe(true);
    expect(out).toContain('machine-wide');

    // The refusal is enforced where it has to be — at fire time, in this folder. Silence, not a
    // string that looks like silence.
    expect(fire()).toBe('');

    // …and the hook is still installed, still serving every other folder: the same command, fired
    // from a folder with no tombstone, still speaks.
    const otherFolder = mkdtempSync(join(tmpdir(), 'musterd-surface-other-'));
    try {
      writeFileSync(join(otherFolder, 'AGENTS.md'), '<!-- musterd:start -->\n', 'utf8');
      const elsewhere = execFileSync('sh', ['-c', cmd], {
        env: { PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: otherFolder },
        encoding: 'utf8',
      });
      expect(elsewhere).toContain('musterd:');
    } finally {
      rmSync(otherFolder, { recursive: true, force: true });
    }
  });

  // The gate FAILS OPEN by construction (a missing/unreadable/malformed declined.json makes grep
  // exit non-zero): never invent a refusal. Asserted by running, for the same reason as above.
  it('a malformed tombstone does not silence the hook — the gate fails open', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{}\n', 'utf8');
    installMusterdHooks(cwd);
    writeFileSync(join(cwd, 'AGENTS.md'), '<!-- musterd:start -->\n', 'utf8');
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(join(cwd, '.musterd', 'declined.json'), '{ this is not json', 'utf8');

    const global = JSON.parse(readFileSync(join(globalDir, 'settings.json'), 'utf8')) as {
      hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
    };
    const cmd = global.hooks?.['UserPromptSubmit']?.[0]?.hooks?.[0]?.command ?? '';
    const fired = execFileSync('sh', ['-c', cmd], {
      env: { PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: cwd },
      encoding: 'utf8',
    });
    expect(fired).toContain('musterd:');
  });

  // Recording a refusal we cannot carry out is the same lie one step removed.
  it('decline refuses a name this build cannot remove, rather than tombstoning it', () => {
    expect(() => run('decline', 'codex:someSlot')).toThrow(/unknown surface/);
    expect(isDeclined(cwd, 'codex:someSlot')).toBe(false);
  });

  it('declining twice is a no-op that says so', () => {
    run('decline', SURFACE_STATUSLINE);
    out = '';
    expect(run('decline', SURFACE_STATUSLINE)).toBe(0);
    expect(out).toContain('already declined');
  });

  it('accept clears the refusal and points at the command that re-installs it', () => {
    run('decline', SURFACE_STATUSLINE);
    out = '';
    expect(run('accept', SURFACE_STATUSLINE)).toBe(0);
    expect(isDeclined(cwd, SURFACE_STATUSLINE)).toBe(false);
    expect(out).toContain('--refresh-hooks');
  });

  it('accept on something never declined is a no-op, not an error', () => {
    expect(run('accept', SURFACE_STATUSLINE)).toBe(0);
    expect(out).toContain('nothing to clear');
  });

  it('a bare `surface` lists, an unknown subcommand and a missing name both fail loudly', () => {
    expect(run()).toBe(0);
    expect(out).toContain(SURFACE_STATUSLINE);
    expect(() => run('sit-on-it')).toThrow(/expected list, decline, or accept/);
    expect(() => run('decline')).toThrow(/usage: musterd surface decline/);
  });
});
