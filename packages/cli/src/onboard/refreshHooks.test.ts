import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { declineSurface, isDeclined } from './declined.js';
import { SURFACE_STATUSLINE } from './harnesses/claudeCode.js';
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

  // ADR 332: an explicit --refresh-hooks IS the user asking for the surface back, so it clears every
  // tombstone in the folder — but says which, and when it was declined, and how to refuse again. A
  // silent resurrection is how someone finds the chip returned with no idea why.
  it('clears a recorded refusal and names what it resurrected (ADR 332)', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    declineSurface(cwd, SURFACE_STATUSLINE, 'nick');
    const said: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      said.push(String(c));
      return true;
    });

    expect(runRefreshHooks(cwd)).toBe(0);

    expect(isDeclined(cwd, SURFACE_STATUSLINE)).toBe(false);
    const out = said.join('');
    expect(out).toContain(SURFACE_STATUSLINE);
    expect(out).toContain('was declined');
    expect(out).toContain('nick');
    expect(out).toContain('surface decline'); // how to refuse again
  });

  // The two dishonest resurrection lines (#1089's carried-forward finding): "re-installed X" must
  // only be said about a surface a present harness's refresh actually installs, and only when that
  // refresh was not refused. Both paths below used to print the same confident line.
  it('leaves a tombstone nothing in this refresh installs, and says so', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    declineSurface(cwd, 'gone-harness:oldChip', 'nick');
    const said: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      said.push(String(c));
      return true;
    });

    expect(runRefreshHooks(cwd)).toBe(0);

    // The refusal record survives: clearing it would recreate the absence-carries-no-intent state
    // for a surface this refresh cannot bring back.
    expect(isDeclined(cwd, 'gone-harness:oldChip')).toBe(true);
    const out = said.join('');
    expect(out).not.toContain('re-installed gone-harness:oldChip');
    expect(out).toContain('gone-harness:oldChip');
    expect(out).toContain('nothing in this refresh installs it');
    expect(out).toContain('surface accept'); // the honest way to clear the record anyway
  });

  it('does not claim "re-installed" for a harness whose refresh was refused (ADR 168)', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    declineSurface(cwd, SURFACE_STATUSLINE, 'nick');
    // A NEWER build's machine-wide SessionStart hook: the downgrade guard will refuse this run.
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      globalSettings(),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: 'command', command: 'x # musterd-sessionstart-hook e999999' }],
            },
          ],
        },
      }),
      'utf8',
    );
    const said: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      said.push(String(c));
      return true;
    });

    expect(runRefreshHooks(cwd)).toBe(1); // the refusal still exits non-zero

    const out = said.join('');
    // The tombstone was cleared on the user's explicit ask, but part of the refresh did not land —
    // so the line hedges instead of claiming an install it cannot vouch for.
    expect(isDeclined(cwd, SURFACE_STATUSLINE)).toBe(false);
    expect(out).not.toContain('re-installed');
    expect(out).toContain('cleared the refusal of ' + SURFACE_STATUSLINE);
    expect(out).toContain('refused');
  });

  // The mixed case pins the partition and the line ordering: one tombstone resurrects, the other
  // stays, and the resurrection lines print before the left-in-place lines.
  it('partitions a mixed pair — one re-installed, one left declined', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    declineSurface(cwd, SURFACE_STATUSLINE, 'nick');
    declineSurface(cwd, 'gone-harness:oldChip', 'nick');
    const said: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      said.push(String(c));
      return true;
    });

    expect(runRefreshHooks(cwd)).toBe(0);

    expect(isDeclined(cwd, SURFACE_STATUSLINE)).toBe(false);
    expect(isDeclined(cwd, 'gone-harness:oldChip')).toBe(true);
    const out = said.join('');
    expect(out).toContain('re-installed ' + SURFACE_STATUSLINE);
    expect(out).not.toContain('re-installed gone-harness:oldChip');
    expect(out).toContain('nothing in this refresh installs it');
    expect(out.indexOf('re-installed ' + SURFACE_STATUSLINE)).toBeLessThan(
      out.indexOf('gone-harness:oldChip'),
    );
  });

  it('says nothing about refusals when there were none', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    const said: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      said.push(String(c));
      return true;
    });
    expect(runRefreshHooks(cwd)).toBe(0);
    expect(said.join('')).not.toContain('was declined');
  });

  it('stamps the machine-wide orientation hook, so the next stale writer is refused', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    expect(runRefreshHooks(cwd)).toBe(0);
    expect(readFileSync(globalSettings(), 'utf8')).toContain('musterd-sessionstart-hook e');
  });

  it('installs the machine-wide UserPromptSubmit nudge hook, stamped and label-nudge-bearing', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    expect(runRefreshHooks(cwd)).toBe(0);
    const global = readFileSync(globalSettings(), 'utf8');
    expect(global).toContain('musterd-promptsubmit-hook e');
    expect(global).toContain('musterd session label-nudge');
  });

  it('ABSORBS a hand-pasted UserPromptSubmit recipe instead of stacking a second hook beside it', () => {
    h.folderBinding = { team: 'revive' };
    seedProvisioned();
    // The docs/harness-hooks.md recipe as pasted by hand: musterd:start gate + status_update nudge,
    // no marker. Pre-managed installs (2026-07) all carry exactly this.
    writeFileSync(
      globalSettings(),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'f="${CLAUDE_PROJECT_DIR:-.}/AGENTS.md"; test -f "$f" && grep -q musterd:start "$f" && echo \'musterd: ... status_update ...\' || true',
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    expect(runRefreshHooks(cwd)).toBe(0);
    const parsed = JSON.parse(readFileSync(globalSettings(), 'utf8')) as {
      hooks: { UserPromptSubmit: { hooks: { command: string }[] }[] };
    };
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toContain(
      'musterd-promptsubmit-hook',
    );
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
    expect(runRefreshHooks(cwd)).toBe(1); // refused ⇒ non-zero, so a script can see it
    // …and the protected slot genuinely left alone (the file itself may gain OTHER global hooks —
    // the refusal is per-slot, and the UserPromptSubmit nudge still installs beside it).
    const after = JSON.parse(readFileSync(globalSettings(), 'utf8')) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(after.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'echo soon # musterd-sessionstart-hook e999' }] },
    ]);
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
