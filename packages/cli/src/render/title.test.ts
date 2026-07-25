import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SEAT_CHIP } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Parsed } from '../args.js';
import { terminalTitleFor } from './title.js';

const parsed = (flags: Record<string, string | boolean> = {}): Parsed => ({
  positionals: [],
  flags,
  metaPairs: [],
});

/** A seat worktree fixture: .musterd/ with the given files. */
function makeWorkspace(files: { binding?: object; spec?: object }): string {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-title-'));
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  if (files.binding) {
    writeFileSync(join(dir, '.musterd', 'binding.json'), JSON.stringify(files.binding));
  }
  if (files.spec) {
    writeFileSync(join(dir, '.musterd', 'workspace.json'), JSON.stringify(files.spec));
  }
  return dir;
}

const seatBinding = (name: string) => ({
  server: 'http://127.0.0.1:4849',
  team: 'revive',
  surface: 'claude-code',
  claim: { mode: 'seat', name },
});

describe('terminalTitleFor', () => {
  let ws: string;
  const dirs: string[] = [];

  beforeEach(() => {
    ws = makeWorkspace({ binding: seatBinding('stanley') });
    dirs.push(ws);
  });

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('labels a seat worktree: chip + seat + folder basename', () => {
    expect(terminalTitleFor('status', parsed(), ws, {}, 'darwin')).toBe(
      `${SEAT_CHIP} stanley · ${basename(ws)}`,
    );
  });

  it('walks up from a nested cwd to the workspace root', () => {
    const nested = join(ws, 'packages', 'cli');
    mkdirSync(nested, { recursive: true });
    expect(terminalTitleFor('inbox', parsed(), nested, {}, 'darwin')).toContain('stanley');
  });

  it('skips hook/daemon/no-identity commands', () => {
    for (const cmd of ['serve', 'service', 'gate', 'session', 'host', 'help']) {
      expect(terminalTitleFor(cmd, parsed(), ws, {}, 'darwin')).toBeNull();
    }
  });

  it('honours --no-title and MUSTERD_NO_TITLE=1', () => {
    expect(terminalTitleFor('status', parsed({ 'no-title': true }), ws, {}, 'darwin')).toBeNull();
    expect(
      terminalTitleFor('status', parsed(), ws, { MUSTERD_NO_TITLE: '1' }, 'darwin'),
    ).toBeNull();
  });

  it('is silent on win32 (no /dev/tty)', () => {
    expect(terminalTitleFor('status', parsed(), ws, {}, 'win32')).toBeNull();
  });

  it('is silent outside a workspace, and in role/chat folders (no fixed seat)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'musterd-title-plain-'));
    dirs.push(plain);
    expect(terminalTitleFor('status', parsed(), plain, {}, 'darwin')).toBeNull();

    const role = makeWorkspace({
      binding: { ...seatBinding('x'), claim: { mode: 'role', role: 'backend' } },
    });
    dirs.push(role);
    expect(terminalTitleFor('status', parsed(), role, {}, 'darwin')).toBeNull();
  });

  it('falls back to the committed workspace spec when binding.json is absent', () => {
    const fresh = makeWorkspace({ spec: seatBinding('miley') });
    dirs.push(fresh);
    // No binding.json — findWorkspaceDir anchors on binding.json, so seed an empty one is wrong;
    // the walk-up must still find the workspace via the spec-only fallback path.
    expect(terminalTitleFor('status', parsed(), fresh, {}, 'darwin')).toBe(
      `${SEAT_CHIP} miley · ${basename(fresh)}`,
    );
  });
});
