import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectClaudeStatuslineDrift,
  installMusterdStatusline,
  removeMusterdStatusline,
  STATUSLINE_MARKER,
} from './claudeCode.js';

interface Settings {
  statusLine?: { type?: string; command?: string };
  hooks?: unknown;
}

const settingsPath = (dir: string) => join(dir, '.claude', 'settings.local.json');
const read = (dir: string): Settings =>
  JSON.parse(readFileSync(settingsPath(dir), 'utf8')) as Settings;
const seed = (dir: string, s: Settings) => {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(settingsPath(dir), JSON.stringify(s, null, 2) + '\n', 'utf8');
};

/**
 * The seat statusline chip is PROJECT-LOCAL, unlike the machine-wide SessionStart orientation.
 * That asymmetry is the point: a statusline names one seat, and a machine-wide slot would put the
 * same seat's name on every terminal on the laptop.
 */
describe('musterd Claude Code statusline (project-local seat chip)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-statusline-'));
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('installs a marked command statusline into settings.local.json', () => {
    expect(installMusterdStatusline(cwd)).toBeUndefined();
    const s = read(cwd);
    expect(s.statusLine?.type).toBe('command');
    expect(s.statusLine?.command).toContain(STATUSLINE_MARKER);
    expect(s.statusLine?.command).toContain('musterd session statusline --stdin');
  });

  it('NEVER clobbers a statusline that is not ours — the user owns that slot', () => {
    seed(cwd, { statusLine: { type: 'command', command: 'my-own-prompt.sh' } });
    const warning = installMusterdStatusline(cwd);
    expect(warning).toBeDefined();
    expect(warning).toContain('statusLine');
    // Unchanged on disk: a warning is the whole remedy, because overwriting is unrecoverable.
    expect(read(cwd).statusLine?.command).toBe('my-own-prompt.sh');
  });

  it('rewrites its OWN statusline in place, so a stale build upgrades cleanly', () => {
    seed(cwd, { statusLine: { type: 'command', command: `old-text # ${STATUSLINE_MARKER}` } });
    expect(installMusterdStatusline(cwd)).toBeUndefined();
    expect(read(cwd).statusLine?.command).toContain('musterd session statusline --stdin');
  });

  it('preserves unrelated settings when it writes', () => {
    seed(cwd, { hooks: { SessionStart: [] } });
    installMusterdStatusline(cwd);
    expect(read(cwd).hooks).toEqual({ SessionStart: [] });
  });

  it('removes only its own statusline, and leaves a foreign one alone', () => {
    installMusterdStatusline(cwd);
    removeMusterdStatusline(cwd);
    expect(read(cwd).statusLine).toBeUndefined();

    seed(cwd, { statusLine: { type: 'command', command: 'my-own-prompt.sh' } });
    removeMusterdStatusline(cwd);
    expect(read(cwd).statusLine?.command).toBe('my-own-prompt.sh');
  });

  it('reports drift when its statusline is missing', () => {
    seed(cwd, {});
    expect(inspectClaudeStatuslineDrift(cwd).join(' ')).toContain('statusLine');
  });

  it('reports drift when its statusline is present but STALE (ADR 168: text, not presence)', () => {
    seed(cwd, { statusLine: { type: 'command', command: `old-text # ${STATUSLINE_MARKER}` } });
    expect(inspectClaudeStatuslineDrift(cwd).join(' ')).toContain('STALE');
  });

  it('reports no drift once installed by this build', () => {
    installMusterdStatusline(cwd);
    expect(inspectClaudeStatuslineDrift(cwd)).toEqual([]);
  });

  it('stays silent about a foreign statusline — that is a choice, not drift', () => {
    seed(cwd, { statusLine: { type: 'command', command: 'my-own-prompt.sh' } });
    expect(inspectClaudeStatuslineDrift(cwd)).toEqual([]);
  });

  it('invents no drift from an absent or unparseable settings file', () => {
    expect(inspectClaudeStatuslineDrift(cwd)).toEqual([]);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(settingsPath(cwd), '{ not json', 'utf8');
    expect(inspectClaudeStatuslineDrift(cwd)).toEqual([]);
  });
});
