import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Real fs here (unlike claudeCode.test.ts, which mocks node:fs) so the hook writer round-trips to disk.
import {
  installMusterdHooks,
  NOTIFICATION_HOOK_MARKER,
  removeMusterdHooks,
  SESSIONSTART_HOOK_MARKER,
} from './claudeCode.js';

/** The Claude Code local-settings shape the hooks land in. */
interface Settings {
  hooks?: Record<string, { hooks: { type: string; command: string }[] }[]>;
  permissions?: unknown;
}

describe('musterd Claude Code hooks (Notification + SessionStart)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-hooks-'));
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  function readSettings(): Settings {
    return JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'));
  }
  const cmdFor = (s: Settings, event: string) => s.hooks?.[event]?.[0]?.hooks?.[0]?.command ?? '';

  it('installs both hooks, marker-tagged, under the right events', () => {
    installMusterdHooks();
    const s = readSettings();
    expect(cmdFor(s, 'Notification')).toContain(NOTIFICATION_HOOK_MARKER);
    expect(cmdFor(s, 'Notification')).toContain('musterd nudge');
    // SessionStart verifies `claude mcp get musterd` before orienting (ADR 060).
    expect(cmdFor(s, 'SessionStart')).toContain(SESSIONSTART_HOOK_MARKER);
    expect(cmdFor(s, 'SessionStart')).toContain('claude mcp get musterd');
    expect(cmdFor(s, 'SessionStart')).toContain('team_inbox_check');
  });

  it('is idempotent — re-installing replaces in place, never stacks', () => {
    installMusterdHooks();
    installMusterdHooks();
    const s = readSettings();
    expect(s.hooks?.['Notification']).toHaveLength(1);
    expect(s.hooks?.['SessionStart']).toHaveLength(1);
  });

  it('preserves the user’s own hooks on install and removal', () => {
    // A pre-existing user SessionStart hook must survive both install and uninstall.
    const path = join(cwd, '.claude', 'settings.local.json');
    installMusterdHooks(); // creates the file + dir
    const s0 = readSettings();
    s0.hooks!['SessionStart'].push({ hooks: [{ type: 'command', command: 'echo mine' }] });
    writeFileSync(path, JSON.stringify(s0), 'utf8');

    removeMusterdHooks();
    const s1 = readSettings();
    // musterd's entries are gone; the user's survives.
    const ss = s1.hooks?.['SessionStart'] ?? [];
    expect(ss.some((m) => m.hooks[0]!.command.includes(SESSIONSTART_HOOK_MARKER))).toBe(false);
    expect(ss.some((m) => m.hooks[0]!.command === 'echo mine')).toBe(true);
    expect(s1.hooks?.['Notification']).toBeUndefined(); // musterd's only Notification entry removed
  });
});
