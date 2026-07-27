import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeProjectDir, enumerateClaudeSessions } from './enumerate.js';

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'adr166-'));
}

function seed(
  home: string,
  workspace: string,
  files: { id: string; ageMin: number; bytes?: number }[],
): void {
  const dir = claudeProjectDir(workspace, home);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const p = join(dir, `${f.id}.jsonl`);
    writeFileSync(p, 'x'.repeat(f.bytes ?? 10));
    const t = new Date(Date.now() - f.ageMin * 60_000);
    utimesSync(p, t, t);
  }
}

describe('claudeProjectDir (ADR 166)', () => {
  it('slugifies the absolute workspace path — every slash becomes a dash', () => {
    expect(claudeProjectDir('/Users/nick/agents-miley', '/home')).toBe(
      '/home/.claude/projects/-Users-nick-agents-miley',
    );
  });

  it('resolves a relative workspace before slugifying', () => {
    expect(claudeProjectDir('.', '/home')).toContain('/home/.claude/projects/-');
  });
});

describe('enumerateClaudeSessions (ADR 166)', () => {
  it('returns undefined — "cannot tell" — when the harness keeps no directory here', () => {
    // Load-bearing: a missing directory must never be laundered into "no sessions", because the
    // wake guard's safe answer when unsure is `live` (refuse to spawn).
    expect(enumerateClaudeSessions('/Users/nick/nowhere', fakeHome())).toBeUndefined();
  });

  it('returns [] for a real but empty directory — that is evidence, not ignorance', () => {
    const home = fakeHome();
    seed(home, '/ws', []);
    expect(enumerateClaudeSessions('/ws', home)).toEqual([]);
  });

  it('lists every transcript, newest write first, with id from the basename', () => {
    const home = fakeHome();
    seed(home, '/ws', [
      { id: 'old-session', ageMin: 600 },
      { id: 'live-session', ageMin: 1 },
      { id: 'middle-session', ageMin: 60 },
    ]);
    const out = enumerateClaudeSessions('/ws', home);
    expect(out?.map((f) => f.id)).toEqual(['live-session', 'middle-session', 'old-session']);
    expect(out?.[0]?.bytes).toBe(10);
  });

  it('ignores non-transcript files', () => {
    const home = fakeHome();
    seed(home, '/ws', [{ id: 'a', ageMin: 1 }]);
    writeFileSync(join(claudeProjectDir('/ws', home), 'notes.txt'), 'x');
    expect(enumerateClaudeSessions('/ws', home)?.map((f) => f.id)).toEqual(['a']);
  });
});
