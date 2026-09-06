import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURSOR_END_HOOK_MARKER,
  CURSOR_GATE_HOOK_MARKER,
  CURSOR_OBSERVE_HOOK_MARKER,
  inspectCursorHookDrift,
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

describe('Cursor hooks install (ADR 198 / 369)', () => {
  it('writes preToolUse, sessionStart, postToolUse, afterShellExecution, afterMCPExecution, and sessionEnd with musterd markers', () => {
    const dir = tmpProject();
    const warnings = installMusterdCursorHooks(dir);
    expect(warnings).toEqual([]);
    const raw = readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8');
    const file = JSON.parse(raw) as {
      version: number;
      hooks: Record<string, { command: string; matcher?: string }[]>;
    };
    expect(file.version).toBe(1);
    expect(file.hooks['preToolUse']?.[0]?.command).toContain(CURSOR_GATE_HOOK_MARKER);
    expect(file.hooks['preToolUse']?.[0]?.command).toContain('gate check --stdin 2>/dev/null');
    expect(file.hooks['preToolUse']?.[0]?.matcher).toBe('Shell|Write|Delete|Edit|Task');
    expect(file.hooks['sessionStart']?.[0]?.command).toContain(CURSOR_OBSERVE_HOOK_MARKER);
    expect(file.hooks['sessionStart']?.[0]?.command).toContain(
      'session observe --stdin --orient 2>/dev/null',
    );
    expect(file.hooks['sessionStart']?.[0]?.command).not.toContain(
      'session observe --stdin --orient >/dev/null',
    );
    expect(file.hooks['postToolUse']?.[0]?.command).toContain(CURSOR_OBSERVE_HOOK_MARKER);
    expect(file.hooks['postToolUse']?.[0]?.command).toContain(
      'session observe --stdin --interrupt 2>/dev/null',
    );
    expect(file.hooks['postToolUse']?.[0]?.command).not.toContain(
      'session observe --stdin --interrupt >/dev/null',
    );
    expect(file.hooks['afterShellExecution']?.[0]?.command).toContain(CURSOR_OBSERVE_HOOK_MARKER);
    expect(file.hooks['afterMCPExecution']?.[0]?.command).toContain(CURSOR_OBSERVE_HOOK_MARKER);
    expect(file.hooks['sessionEnd']?.[0]?.command).toContain(CURSOR_END_HOOK_MARKER);
    expect(file.hooks['sessionEnd']?.[0]?.command).toContain('session end --stdin');
  });

  // ADR 168, applied to Cursor (lane 01M1T42CDP). Measured 2026-09-05 in schmidt's worktree: every
  // marker present, the postToolUse command a pre-ADR-369 build — `session observe --stdin` with
  // stdout discarded and no `--interrupt` — so the probe existed in the CLI and nothing ran it, the
  // seat heard no bell at any boundary, and the doctor said nothing because Cursor populated no
  // hookDrift at all. Presence was never the question; the text is.
  describe('inspectCursorHookDrift (ADR 168 for .cursor/hooks.json)', () => {
    it('reads clean right after install, and reports nothing for a folder with no hooks file', () => {
      const bare = tmpProject();
      expect(inspectCursorHookDrift(bare)).toEqual([]); // no file — the bare-folder drift covers it
      installMusterdCursorHooks(bare);
      expect(inspectCursorHookDrift(bare)).toEqual([]);
    });

    it("names a STALE postToolUse hook — schmidt's exact shape — and prescribes the refresh", () => {
      const dir = tmpProject();
      installMusterdCursorHooks(dir);
      const path = join(dir, '.cursor', 'hooks.json');
      const file = JSON.parse(readFileSync(path, 'utf8')) as {
        hooks: Record<string, { command: string }[]>;
      };
      // The command an older build wrote: marker intact, `--interrupt` absent, stdout to /dev/null.
      file.hooks['postToolUse']![0]!.command =
        'cd "${CURSOR_PROJECT_DIR:-.}" 2>/dev/null; command -v musterd >/dev/null 2>&1 && ' +
        `musterd session observe --stdin >/dev/null 2>&1 || true # ${CURSOR_OBSERVE_HOOK_MARKER}`;
      writeFileSync(path, JSON.stringify(file), 'utf8');
      const drift = inspectCursorHookDrift(dir);
      expect(drift).toHaveLength(1);
      expect(drift[0]).toContain('postToolUse');
      expect(drift[0]).toContain('interrupt line');
      expect(drift[0]).toContain('STALE');
      expect(drift[0]).toContain('musterd init --refresh-hooks');
      // …and the refresh is exactly the repair: the marker-owned entry is rewritten in place.
      installMusterdCursorHooks(dir);
      expect(inspectCursorHookDrift(dir)).toEqual([]);
    });

    it('names a MISSING hook by event and purpose', () => {
      const dir = tmpProject();
      installMusterdCursorHooks(dir);
      const path = join(dir, '.cursor', 'hooks.json');
      const file = JSON.parse(readFileSync(path, 'utf8')) as {
        hooks: Record<string, { command: string }[]>;
      };
      delete file.hooks['sessionEnd'];
      writeFileSync(path, JSON.stringify(file), 'utf8');
      const drift = inspectCursorHookDrift(dir);
      expect(drift).toHaveLength(1);
      expect(drift[0]).toContain('sessionEnd');
      expect(drift[0]).toContain('missing');
    });

    it('never invents drift from a file it cannot parse', () => {
      const dir = tmpProject();
      writeFileSync(join(dir, '.cursor', 'hooks.json'), '{ not json', 'utf8');
      expect(inspectCursorHookDrift(dir)).toEqual([]);
    });
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
    expect(file.hooks['preToolUse']).toBeUndefined();
    expect(file.hooks['sessionStart']).toBeUndefined();
    expect(existsSync(join(dir, '.cursor', 'hooks.json'))).toBe(true);
  });
});
