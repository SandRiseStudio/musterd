import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Real fs here (unlike claudeCode.test.ts, which mocks node:fs) so the hook writer round-trips to disk.
import {
  inspectClaudeHookDrift,
  installMusterdHooks,
  NOTIFICATION_HOOK_MARKER,
  POSTTOOLUSE_HOOK_MARKER,
  PRETOOLUSE_HOOK_MARKER,
  removeMusterdHooks,
  SESSIONMSG_HOOK_MARKER,
  SESSION_CAPTURE_HOOK_MARKER,
  SESSION_END_HOOK_MARKER,
  SESSIONSTART_HOOK_MARKER,
} from './claudeCode.js';

/** The Claude Code settings shape the hooks land in. */
interface Settings {
  hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
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
    // The LOCAL SessionStart is the inc-4 session-capture hook — a different marker and concern
    // from the global orientation hook; exactly one entry, piping stdin, fully silent.
    expect(local.hooks?.['SessionStart']).toHaveLength(1);
    const capture = cmdFor(local, 'SessionStart');
    expect(capture).toContain(SESSION_CAPTURE_HOOK_MARKER);
    expect(capture).toContain('musterd session start --stdin');
    expect(capture).toContain('>/dev/null'); // SessionStart stdout lands in model context
    expect(capture).not.toContain(SESSIONSTART_HOOK_MARKER);
    // The SessionEnd advisory hook (ADR 131 §5), same shape.
    expect(local.hooks?.['SessionEnd']).toHaveLength(1);
    const end = cmdFor(local, 'SessionEnd');
    expect(end).toContain(SESSION_END_HOOK_MARKER);
    expect(end).toContain('musterd session end --stdin');
    expect(end).toContain('>/dev/null');
    expect(global.hooks?.['SessionEnd']).toBeUndefined(); // SessionEnd is NOT global

    // The global SessionStart is self-gating (grep musterd:start) and verifies before orienting.
    const ss = cmdFor(global, 'SessionStart');
    expect(ss).toContain(SESSIONSTART_HOOK_MARKER);
    expect(ss).toContain('grep -q musterd:start');
    expect(ss).toContain('claude mcp get musterd');
    expect(ss).toContain('team_inbox_check');
    // A committed launch spec → point at the headless self-wire; else the interactive init.
    expect(ss).toContain('.musterd/workspace.json');
    expect(ss).toContain('musterd wire');
    expect(ss).toContain('musterd init');
    expect(global.hooks?.['Notification']).toBeUndefined(); // Notification is NOT global

    // The PostToolUse interrupt line (ADR 088) is project-local, marker-tagged, runs the probe.
    const pt = cmdFor(local, 'PostToolUse');
    expect(pt).toContain(POSTTOOLUSE_HOOK_MARKER);
    expect(pt).toContain('musterd inbox --interrupt-check');
    expect(local.hooks?.['PostToolUse']?.[0]?.matcher).toBeUndefined(); // fires on every tool
    expect(global.hooks?.['PostToolUse']).toBeUndefined(); // PostToolUse is NOT global

    // The PreToolUse enforcement gate (ADR 150) is project-local, marker-tagged, matcher-scoped to
    // write-shaped tools, and pipes the tool call into the gate CLI.
    const pre = cmdFor(local, 'PreToolUse');
    expect(pre).toContain(PRETOOLUSE_HOOK_MARKER);
    expect(pre).toContain('musterd gate check --stdin');
    expect(local.hooks?.['PreToolUse']?.[0]?.matcher).toBe(
      'Edit|Write|MultiEdit|NotebookEdit|Bash',
    );
    expect(global.hooks?.['PreToolUse']).toBeUndefined(); // PreToolUse is NOT global

    // The session-messaging observer (ADR 167) — a SECOND PreToolUse entry, own marker, exact-tool
    // matcher, same gate CLI (which recognizes the tool and emits an attestation, never a deny).
    expect(local.hooks?.['PreToolUse']).toHaveLength(2);
    const smsg = local.hooks?.['PreToolUse']?.[1];
    expect(smsg?.hooks?.[0]?.command).toContain(SESSIONMSG_HOOK_MARKER);
    expect(smsg?.hooks?.[0]?.command).toContain('musterd gate check --stdin');
    expect(smsg?.matcher).toBe('mcp__ccd_session_mgmt__send_message');
  });

  it('is idempotent — re-installing replaces in place, never stacks', () => {
    installMusterdHooks();
    installMusterdHooks();
    expect(read(localPath()).hooks?.['Notification']).toHaveLength(1);
    expect(read(localPath()).hooks?.['PostToolUse']).toHaveLength(1);
    expect(read(localPath()).hooks?.['PreToolUse']).toHaveLength(2); // gate + sessionmsg observer
    expect(read(localPath()).hooks?.['SessionStart']).toHaveLength(1);
    expect(read(localPath()).hooks?.['SessionEnd']).toHaveLength(1);
    expect(read(globalPath()).hooks?.['SessionStart']).toHaveLength(1);
  });

  it('init --check drift: flags each missing hook, clears once installed', () => {
    // A folder with a settings file but no musterd hooks (e.g. hand-deleted, or a renamed flag) —
    // reachability (ADR 088) and resumability (ADR 131 §5) would silently die; the doctor surfaces
    // each one by name.
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(localPath(), JSON.stringify({ hooks: { Notification: [] } }), 'utf8');
    const drift = inspectClaudeHookDrift(cwd);
    expect(drift).toHaveLength(5);
    expect(drift[0]).toContain('PostToolUse interrupt hook is missing');
    expect(drift[1]).toContain('PreToolUse enforcement-gate hook is missing');
    expect(drift[2]).toContain('session-messaging observer hook is missing');
    expect(drift[3]).toContain('session-capture hook is missing');
    expect(drift[4]).toContain('SessionEnd hook is missing');

    // Once init wires them, the drift clears.
    installMusterdHooks();
    expect(inspectClaudeHookDrift(cwd)).toEqual([]);

    // Hand-delete just the capture hook → exactly that drift line comes back.
    const s = read(localPath());
    delete s.hooks!['SessionStart'];
    writeFileSync(localPath(), JSON.stringify(s), 'utf8');
    const captureDrift = inspectClaudeHookDrift(cwd);
    expect(captureDrift).toHaveLength(1);
    expect(captureDrift[0]).toContain('wakes will run fresh-only');

    // No settings file at all → not this check's concern (the "no server registered" drift covers it).
    rmSync(join(cwd, '.claude'), { recursive: true, force: true });
    expect(inspectClaudeHookDrift(cwd)).toEqual([]);
  });

  it('removal reverses the local PostToolUse + capture hooks, leaves the global orientation hook', () => {
    installMusterdHooks();
    expect(cmdFor(read(localPath()), 'PostToolUse')).toContain(POSTTOOLUSE_HOOK_MARKER);
    expect(cmdFor(read(localPath()), 'SessionStart')).toContain(SESSION_CAPTURE_HOOK_MARKER);
    expect(cmdFor(read(localPath()), 'PreToolUse')).toContain(PRETOOLUSE_HOOK_MARKER);
    removeMusterdHooks();
    const after = read(localPath());
    expect(after.hooks?.['PostToolUse']).toBeUndefined();
    expect(after.hooks?.['PreToolUse']).toBeUndefined();
    expect(after.hooks?.['SessionStart']).toBeUndefined();
    expect(after.hooks?.['SessionEnd']).toBeUndefined();
    // The global self-gating orientation hook is machine-shared — uninstalling one folder keeps it.
    expect(cmdFor(read(globalPath()), 'SessionStart')).toContain(SESSIONSTART_HOOK_MARKER);
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

  // ADR 168's three pre-registered arms. The baseline these replace is precise and damning: on a
  // machine provably carrying the stale pre-#421 orientation text, the doctor scored ZERO detections
  // against a known positive, because it only ever asked "is an entry with our marker present?".
  describe('ADR 168 — hook content, not presence', () => {
    /** Rewrite the installed global hook's command, preserving the marker (so it stays "ours"). */
    const setGlobalCommand = (command: string) => {
      const s = read(globalPath());
      s.hooks!['SessionStart']![0]!.hooks[0]!.command = command;
      writeFileSync(globalPath(), JSON.stringify(s), 'utf8');
    };

    it('arm 1 — replays the incident: a stale machine-wide hook is caught, and named as stale', () => {
      installMusterdHooks();
      expect(inspectClaudeHookDrift(cwd)).toEqual([]); // current → silent

      // The exact shape of the #421 regression: same marker, older TEXT. Presence checking called
      // this healthy; that clean result WAS the defect.
      setGlobalCommand(
        `grep -q musterd:start AGENTS.md && echo "old orientation, no label sweep" ` +
          `# ${SESSIONSTART_HOOK_MARKER} e1`,
      );
      const drift = inspectClaudeHookDrift(cwd);
      expect(drift).toHaveLength(1);
      expect(drift[0]).toContain('present but STALE');
      expect(drift[0]).toContain('every folder on this machine');
      expect(drift[0]).toContain('musterd init');
    });

    it('arm 2 — reverses the polarity: a NEWER hook blames the checkout, and forbids init', () => {
      installMusterdHooks();
      setGlobalCommand(`echo 'orientation from the future' # ${SESSIONSTART_HOOK_MARKER} e999`);
      const drift = inspectClaudeHookDrift(cwd);
      expect(drift).toHaveLength(1);
      // The repair must point at the CHECKOUT, not at init — getting this backwards is precisely
      // what re-bakes the shared slot.
      expect(drift[0]).toContain('this checkout is behind');
      expect(drift[0]).toContain('do NOT run');
      expect(drift[0]).not.toContain('present but STALE');
    });

    it('arm 3 — proves the refusal: a lower-epoch build leaves a newer hook byte-identical', () => {
      installMusterdHooks();
      const future = `echo 'orientation from the future' # ${SESSIONSTART_HOOK_MARKER} e999`;
      setGlobalCommand(future);
      const before = readFileSync(globalPath(), 'utf8');

      const warnings = installMusterdHooks(); // this build is epoch 3 — must refuse

      // The only assertion that can prove the mechanism: nothing happened.
      expect(readFileSync(globalPath(), 'utf8')).toBe(before);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('refused');
      expect(warnings[0]).toContain('e999'.slice(1)); // names the newer epoch it protected
      // …and the local hooks still install normally: the refusal is scoped to the shared slot.
      expect(cmdFor(read(localPath()), 'PostToolUse')).toContain(POSTTOOLUSE_HOOK_MARKER);
    });

    it('catches a stale PROJECT-LOCAL hook too, without inventing an absence line', () => {
      installMusterdHooks();
      const s = read(localPath());
      s.hooks!['PostToolUse']![0]!.hooks[0]!.command = `echo stale # ${POSTTOOLUSE_HOOK_MARKER}`;
      writeFileSync(localPath(), JSON.stringify(s), 'utf8');
      const drift = inspectClaudeHookDrift(cwd);
      expect(drift).toHaveLength(1);
      expect(drift[0]).toContain(POSTTOOLUSE_HOOK_MARKER);
      expect(drift[0]).toContain('present but');
      expect(drift[0]).not.toContain('missing'); // it is there — just wrong
    });

    it('guard metric — a freshly installed fleet reports ZERO drift (no incidental-text matching)', () => {
      // The honest failure mode is noise: if the comparison matched whitespace or quoting rather
      // than generation, this would be nonzero on a machine where everything is current.
      installMusterdHooks();
      expect(inspectClaudeHookDrift(cwd)).toEqual([]);
      installMusterdHooks(); // and again — idempotent installs stay silent
      expect(inspectClaudeHookDrift(cwd)).toEqual([]);
    });

    it('an unstamped hook is legal — treated as the oldest generation, never an error', () => {
      installMusterdHooks();
      // A hook written before ADR 168 carries no `eN`. It must read as stale (epoch 0 < ours) and
      // prescribe `init`, NOT be mistaken for a newer build or throw.
      setGlobalCommand(`grep -q musterd:start AGENTS.md # ${SESSIONSTART_HOOK_MARKER}`);
      const drift = inspectClaudeHookDrift(cwd);
      expect(drift).toHaveLength(1);
      expect(drift[0]).toContain('present but STALE');
      expect(drift[0]).toContain('installed epoch 0');
    });
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
