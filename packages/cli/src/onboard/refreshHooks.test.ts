import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRefreshHooks } from './init.js';

/**
 * `musterd init --refresh-hooks` (ADR 168) against the REAL Claude Code adapter.
 *
 * Deliberately a separate file from `init.test.ts`, which mocks `HARNESSES` with a stub that has no
 * `refreshHooks` — these assertions would pass there without executing a line of the thing they
 * claim to test. Only `config.js` is mocked here, so the hook writer round-trips to disk.
 */
const h = vi.hoisted(() => ({ folderBinding: null as { team: string } | null }));

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findBinding: vi.fn(() => h.folderBinding),
  findWorkspaceSpec: vi.fn(() => null),
}));

let cwd: string;
let globalDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'musterd-refresh-hooks-'));
  globalDir = mkdtempSync(join(tmpdir(), 'musterd-refresh-global-'));
  process.env['CLAUDE_CONFIG_DIR'] = globalDir; // never touch the real ~/.claude
  h.folderBinding = null;
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CLAUDE_CONFIG_DIR'];
  rmSync(cwd, { recursive: true, force: true });
  rmSync(globalDir, { recursive: true, force: true });
});

const localSettings = () => join(cwd, '.claude', 'settings.local.json');
const globalSettings = () => join(globalDir, 'settings.json');
const readLocal = () =>
  JSON.parse(readFileSync(localSettings(), 'utf8')) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
const allCommands = () =>
  Object.values(readLocal().hooks)
    .flat()
    .flatMap((m) => m.hooks.map((x) => x.command))
    .join('\n');

/** A folder already provisioned for Claude Code, carrying `hooks` and nothing more. */
const seedProvisioned = (hooks: unknown = {}) => {
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(localSettings(), JSON.stringify({ hooks }), 'utf8');
};

describe('runRefreshHooks — hooks only, never identity (ADR 168)', () => {
  it('refuses in an unbound folder rather than guessing a team', () => {
    expect(runRefreshHooks(cwd)).toBe(1);
  });

  it('writes NOTHING where the harness was never provisioned — a refresh is not a first install', () => {
    h.folderBinding = { team: 'revive' };
    expect(runRefreshHooks(cwd)).toBe(0);
    expect(existsSync(localSettings())).toBe(false);
  });

  it('delivers a hook added AFTER this seat was provisioned — the gap that left the gate dark', () => {
    // The state measured across the 13 dogfood worktrees on 2026-07-27: a seat provisioned before
    // ADR 150/167 carries the older hooks and silently lacks the newer ones, so a declared
    // enforcement class is a no-op there. Full `init` was the only carrier, and it is interactive,
    // re-mints identity, and re-points the worktree-family MCP entry — so nobody ran it, and the
    // ADR 167 observer sat at 0/13 while the ADR 150 gate sat at 2/13.
    h.folderBinding = { team: 'revive' };
    seedProvisioned({
      Notification: [{ hooks: [{ type: 'command', command: 'x # musterd-notify-hook' }] }],
    });

    expect(runRefreshHooks(cwd)).toBe(0);

    const commands = allCommands();
    expect(commands).toContain('musterd-gate-hook'); // ADR 150 — had been missing in 11 of 13
    expect(commands).toContain('musterd-sessionmsg-hook'); // ADR 167 — had been missing in ALL 13
    expect(commands).toContain('musterd-interrupt-hook');
    expect(commands).toContain('musterd-session-capture-hook');

    // Identity is untouched — the entire reason this verb exists rather than "just run init".
    expect(existsSync(join(cwd, '.musterd', 'binding.json'))).toBe(false);
    expect(existsSync(join(cwd, '.musterd', 'workspace.json'))).toBe(false);
  });

  it('stamps the machine-wide orientation hook, so the next stale writer is refused', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    expect(runRefreshHooks(cwd)).toBe(0);
    expect(readFileSync(globalSettings(), 'utf8')).toContain('musterd-sessionstart-hook e');
  });

  it('is idempotent — a second refresh changes nothing', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    expect(runRefreshHooks(cwd)).toBe(0);
    const local = readFileSync(localSettings(), 'utf8');
    const global = readFileSync(globalSettings(), 'utf8');
    expect(runRefreshHooks(cwd)).toBe(0);
    expect(readFileSync(localSettings(), 'utf8')).toBe(local);
    expect(readFileSync(globalSettings(), 'utf8')).toBe(global);
  });

  it('honors the downgrade refusal and exits NON-ZERO — a refusal is never a silent pass', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    // A NEWER musterd wrote the machine-wide hook; this build must decline to replace it.
    writeFileSync(
      globalSettings(),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo soon # musterd-sessionstart-hook e999' }] },
          ],
        },
      }),
      'utf8',
    );
    const before = readFileSync(globalSettings(), 'utf8');

    expect(runRefreshHooks(cwd)).toBe(1); // refused ⇒ non-zero, so a script can see it
    expect(readFileSync(globalSettings(), 'utf8')).toBe(before); // …and genuinely left alone
    // The local hooks still land: the refusal is scoped to the slot it protects, not the whole run.
    expect(allCommands()).toContain('musterd-gate-hook');
  });

  it('leaves the user’s own hooks alone', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned({
      PostToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
    });
    expect(runRefreshHooks(cwd)).toBe(0);
    expect(allCommands()).toContain('echo mine');
  });
});
