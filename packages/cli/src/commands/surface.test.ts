import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { declineSurface, isDeclined } from '../onboard/declined.js';
import {
  inspectClaudeStatuslineDrift,
  installMusterdStatusline,
  SURFACE_STATUSLINE,
} from '../onboard/harnesses/claudeCode.js';
import { surfaceCommand } from './surface.js';

describe('musterd surface (ADR 332)', () => {
  let cwd: string;
  let out: string;

  const run = (...argv: string[]): number => surfaceCommand(parseArgs(argv));

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-surface-'));
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out += String(c);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
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
