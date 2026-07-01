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

/** The Claude Code settings shape the hooks land in. */
interface Settings {
  hooks?: Record<string, { hooks: { type: string; command: string }[] }[]>;
  permissions?: unknown;
  model?: string;
}

/**
 * Notification is project-local (`.claude/settings.local.json` in cwd); SessionStart is global
 * (`settings.json` under CLAUDE_CONFIG_DIR — set to a temp dir so the real ~/.claude is never touched).
 */
describe('musterd Claude Code hooks (local Notification + global SessionStart)', () => {
  let cwd: string;
  let globalDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-hooks-cwd-'));
    globalDir = mkdtempSync(join(tmpdir(), 'musterd-hooks-global-'));
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    process.env['CLAUDE_CONFIG_DIR'] = globalDir;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['CLAUDE_CONFIG_DIR'];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  const localPath = () => join(cwd, '.claude', 'settings.local.json');
  const globalPath = () => join(globalDir, 'settings.json');
  const read = (p: string): Settings => JSON.parse(readFileSync(p, 'utf8'));
  const cmdFor = (s: Settings, event: string) => s.hooks?.[event]?.[0]?.hooks?.[0]?.command ?? '';

  it('installs Notification locally and SessionStart globally, marker-tagged', () => {
    installMusterdHooks();
    const local = read(localPath());
    const global = read(globalPath());
    expect(cmdFor(local, 'Notification')).toContain(NOTIFICATION_HOOK_MARKER);
    expect(cmdFor(local, 'Notification')).toContain('musterd nudge');
    expect(local.hooks?.['SessionStart']).toBeUndefined(); // SessionStart is NOT local

    // The global SessionStart is self-gating (grep musterd:start) and verifies before orienting.
    const ss = cmdFor(global, 'SessionStart');
    expect(ss).toContain(SESSIONSTART_HOOK_MARKER);
    expect(ss).toContain('grep -q musterd:start');
    expect(ss).toContain('claude mcp get musterd');
    expect(ss).toContain('team_inbox_check');
    expect(global.hooks?.['Notification']).toBeUndefined(); // Notification is NOT global
  });

  it('is idempotent — re-installing replaces in place, never stacks', () => {
    installMusterdHooks();
    installMusterdHooks();
    expect(read(localPath()).hooks?.['Notification']).toHaveLength(1);
    expect(read(globalPath()).hooks?.['SessionStart']).toHaveLength(1);
  });

  it('absorbs a hand-pasted global recipe instead of duplicating it', () => {
    // Simulate the manual recipe already in the user's global settings (no marker, but the signature).
    writeFileSync(
      globalPath(),
      JSON.stringify({
        model: 'opus',
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'grep -q musterd:start AGENTS.md && echo "... team_inbox_check ..." || exit 0',
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    installMusterdHooks();
    const global = read(globalPath());
    // The recipe was absorbed → exactly one SessionStart entry, now marker-tagged.
    expect(global.hooks?.['SessionStart']).toHaveLength(1);
    expect(cmdFor(global, 'SessionStart')).toContain(SESSIONSTART_HOOK_MARKER);
    // Unrelated global settings are preserved.
    expect(global.model).toBe('opus');
  });

  it('never clobbers an unparseable global settings file', () => {
    writeFileSync(globalPath(), '{ this is not valid json', 'utf8');
    installMusterdHooks(); // must not throw, must not overwrite
    expect(readFileSync(globalPath(), 'utf8')).toBe('{ this is not valid json');
    // The local Notification hook still installs fine.
    expect(cmdFor(read(localPath()), 'Notification')).toContain(NOTIFICATION_HOOK_MARKER);
  });

  it('removal reverses the local Notification hook and preserves the user’s own hooks', () => {
    installMusterdHooks();
    // Add a user-owned Notification hook alongside musterd's.
    const local = read(localPath());
    local.hooks!['Notification'].push({ hooks: [{ type: 'command', command: 'echo mine' }] });
    writeFileSync(localPath(), JSON.stringify(local), 'utf8');

    removeMusterdHooks();
    const after = read(localPath());
    const notif = after.hooks?.['Notification'] ?? [];
    expect(notif.some((m) => m.hooks[0]!.command.includes(NOTIFICATION_HOOK_MARKER))).toBe(false);
    expect(notif.some((m) => m.hooks[0]!.command === 'echo mine')).toBe(true);
  });
});
