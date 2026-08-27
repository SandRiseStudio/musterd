import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURSOR_END_HOOK_MARKER,
  CURSOR_OBSERVE_HOOK_MARKER,
  installMusterdCursorHooks,
  removeMusterdCursorHooks,
} from './cursor.js';

const dirs: string[] = [];
afterEach(() => {
  // best-effort; tmpdir GC is fine if remove fails
  dirs.length = 0;
});

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-cursor-hooks-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.cursor'), { recursive: true });
  return dir;
}

describe('Cursor hooks install (ADR 198)', () => {
  it('writes sessionStart, postToolUse, afterShellExecution, afterMCPExecution, and sessionEnd with musterd markers', () => {
    const dir = tmpProject();
    const warnings = installMusterdCursorHooks(dir);
    expect(warnings).toEqual([]);
    const raw = readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8');
    const file = JSON.parse(raw) as {
      version: number;
      hooks: Record<string, { command: string }[]>;
    };
    expect(file.version).toBe(1);
    expect(file.hooks['sessionStart']?.[0]?.command).toContain(CURSOR_OBSERVE_HOOK_MARKER);
    expect(file.hooks['sessionStart']?.[0]?.command).toContain(
      'session observe --stdin --orient 2>/dev/null',
    );
    expect(file.hooks['sessionStart']?.[0]?.command).not.toContain(
      'session observe --stdin --orient >/dev/null',
    );
    expect(file.hooks['postToolUse']?.[0]?.command).toContain(CURSOR_OBSERVE_HOOK_MARKER);
    expect(file.hooks['postToolUse']?.[0]?.command).toContain(
      'session observe --stdin >/dev/null 2>&1',
    );
    expect(file.hooks['afterShellExecution']?.[0]?.command).toContain(CURSOR_OBSERVE_HOOK_MARKER);
    expect(file.hooks['afterMCPExecution']?.[0]?.command).toContain(CURSOR_OBSERVE_HOOK_MARKER);
    expect(file.hooks['sessionEnd']?.[0]?.command).toContain(CURSOR_END_HOOK_MARKER);
    expect(file.hooks['sessionEnd']?.[0]?.command).toContain('session end --stdin');
  });

  it('is idempotent — a second install does not stack duplicate musterd hooks', () => {
    const dir = tmpProject();
    installMusterdCursorHooks(dir);
    installMusterdCursorHooks(dir);
    const file = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(file.hooks['postToolUse']).toHaveLength(1);
    expect(file.hooks['sessionStart']).toHaveLength(1);
  });

  it('preserves a user hook beside musterd entries', () => {
    const dir = tmpProject();
    writeFileSync(
      join(dir, '.cursor', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: { postToolUse: [{ command: './mine.sh' }] },
      }) + '\n',
      'utf8',
    );
    installMusterdCursorHooks(dir);
    const file = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(file.hooks['postToolUse']?.map((h) => h.command)).toEqual(
      expect.arrayContaining(['./mine.sh', expect.stringContaining(CURSOR_OBSERVE_HOOK_MARKER)]),
    );
    expect(file.hooks['postToolUse']).toHaveLength(2);
  });

  it('removeMusterdCursorHooks drops only our markers', () => {
    const dir = tmpProject();
    writeFileSync(
      join(dir, '.cursor', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: { postToolUse: [{ command: './mine.sh' }] },
      }) + '\n',
      'utf8',
    );
    installMusterdCursorHooks(dir);
    removeMusterdCursorHooks(dir);
    const file = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(file.hooks['postToolUse']).toEqual([{ command: './mine.sh' }]);
    expect(file.hooks['sessionStart']).toBeUndefined();
    expect(existsSync(join(dir, '.cursor', 'hooks.json'))).toBe(true);
  });
});
