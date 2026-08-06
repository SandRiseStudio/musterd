import { execFileSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  markSessionStart,
  pathsPredatingSession,
  sessionStartedAt,
  stalePathWarning,
} from './workingTree.js';

/**
 * ADR 239's verdict (2026-08-06). The day-one ledger is the fixture: every case below is something
 * that actually happened, and the predicate is judged on all six, not on the ones that flatter it.
 */

const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-predates-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'tracked.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
};

/** Set a path's mtime to an absolute epoch-ms, so "before/after session start" is exact, not slept for. */
const setMtime = (path: string, ms: number): void => {
  utimesSync(path, new Date(ms), new Date(ms));
};

const run = <T>(dir: string, fn: () => T): T => {
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return fn();
  } finally {
    process.chdir(cwd);
  }
};

describe('the session-start marker', () => {
  it('reports no start time before it is marked, and one after', () => {
    const d = mkdtempSync(join(tmpdir(), 'musterd-mark-'));
    expect(sessionStartedAt(d, 'sess-1')).toBeUndefined();
    expect(markSessionStart(d, 'sess-1')).toBe(true); // true = created now
    expect(sessionStartedAt(d, 'sess-1')).toBeTypeOf('number');
  });

  it('does not move once set — a resumed session keeps its original start', () => {
    const d = mkdtempSync(join(tmpdir(), 'musterd-mark-'));
    markSessionStart(d, 'sess-1');
    const first = sessionStartedAt(d, 'sess-1')!;
    setMtime(join(d, 'session-start-sess-1'), first - 60_000);
    const moved = sessionStartedAt(d, 'sess-1')!;
    expect(markSessionStart(d, 'sess-1')).toBe(false); // false = already existed
    expect(sessionStartedAt(d, 'sess-1')).toBe(moved); // re-marking must not restamp it
  });

  it('never throws on an unwritable directory (a hook must not break its tool call)', () => {
    expect(() => markSessionStart('/nonexistent/nope', 's')).not.toThrow();
    expect(sessionStartedAt('/nonexistent/nope', 's')).toBeUndefined();
  });
});

describe('pathsPredatingSession — the predicate the verdict turns on', () => {
  /**
   * FALSE POSITIVE ×4 (dolly, izzo): writes through a `python3 - <<EOF ... open(p,'w')` heredoc.
   * Invisible to the old edit-set, so all four were named as foreign. Here the file is modified
   * DURING the session, so it is never certain-foreign — the entire measured FP class disappears,
   * and it disappears by construction rather than by teaching the gate about heredocs.
   */
  it('is silent about a file written during this session, however it was written', () => {
    const dir = repo();
    const start = Date.now() - 60_000;
    writeFileSync(join(dir, 'tracked.txt'), 'written by a heredoc this session\n');
    setMtime(join(dir, 'tracked.txt'), start + 30_000); // after start
    expect(run(dir, () => pathsPredatingSession(start))).toEqual([]);
  });

  /**
   * TRUE POSITIVE (izzo, overridden): a session-edit index left by an EARLIER session, modified
   * before this one began. Certain-foreign — this session did not exist when it was written.
   */
  it('names a tracked file last modified before this session began', () => {
    const dir = repo();
    const start = Date.now() - 60_000;
    writeFileSync(join(dir, 'tracked.txt'), "an earlier session's work\n");
    setMtime(join(dir, 'tracked.txt'), start - 30_000); // before start
    expect(run(dir, () => pathsPredatingSession(start))).toEqual(['tracked.txt']);
  });

  /**
   * THE MISS (ryder): a FOREIGN session's index, UNTRACKED, sitting in his folder before he started.
   * ADR 239 decision 3 excluded untracked paths by construction, so the one file that did real damage
   * was invisible. The mtime predicate is what makes including them safe: a build artifact is
   * rewritten constantly and an ignored file never appears in porcelain at all, so an untracked file
   * older than the session is exactly the leftover case.
   */
  it('names an untracked file that predates the session — the case the old gate could not see', () => {
    const dir = repo();
    const start = Date.now() - 60_000;
    writeFileSync(join(dir, 'session-edits-foreign.txt'), "another session's index\n");
    setMtime(join(dir, 'session-edits-foreign.txt'), start - 30_000);
    expect(run(dir, () => pathsPredatingSession(start))).toEqual(['session-edits-foreign.txt']);
  });

  it('is silent about an untracked file created during this session', () => {
    const dir = repo();
    const start = Date.now() - 60_000;
    writeFileSync(join(dir, 'scratch.log'), 'mine\n');
    setMtime(join(dir, 'scratch.log'), start + 10_000);
    expect(run(dir, () => pathsPredatingSession(start))).toEqual([]);
  });

  it('never reports an ignored file — porcelain omits them, so build output cannot reach the warning', () => {
    const dir = repo();
    const start = Date.now() - 60_000;
    writeFileSync(join(dir, '.gitignore'), 'build/\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'ignore'], { cwd: dir, stdio: 'ignore' });
    execFileSync('mkdir', ['-p', join(dir, 'build')]);
    writeFileSync(join(dir, 'build', 'out.js'), 'stale artifact\n');
    setMtime(join(dir, 'build', 'out.js'), start - 30_000);
    expect(run(dir, () => pathsPredatingSession(start))).toEqual([]);
  });

  it('is silent on a clean tree', () => {
    const dir = repo();
    expect(run(dir, () => pathsPredatingSession(Date.now()))).toEqual([]);
  });

  it('reports nothing when the tree is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-norepo-'));
    expect(run(dir, () => pathsPredatingSession(Date.now()))).toEqual([]);
  });

  /**
   * THE ACCEPTED LOSS, asserted so it cannot be forgotten: a genuinely CONCURRENT writer — the
   * original 2026-08-05 incident — modifies files during this session, so the predicate stays
   * silent. Recall is traded for certainty deliberately; if this test ever "fails" because someone
   * made it warn, they have reintroduced the false-positive class the verdict removed.
   */
  it('does NOT catch a concurrent writer — the original incident is out of scope by design', () => {
    const dir = repo();
    const start = Date.now() - 60_000;
    writeFileSync(join(dir, 'tracked.txt'), "a concurrent session's uncommitted work\n");
    setMtime(join(dir, 'tracked.txt'), start + 30_000);
    expect(run(dir, () => pathsPredatingSession(start))).toEqual([]);
  });
});

describe('stalePathWarning', () => {
  it('names the paths and says why they are certainly not this session’s', () => {
    const text = stalePathWarning(['a.txt', 'b/c.md'], 'git add -A');
    expect(text).toContain('a.txt');
    expect(text).toContain('b/c.md');
    expect(text).toContain('git add -A');
    expect(text.toLowerCase()).toMatch(/before this session (began|started)/);
  });

  /** The credibility lesson: izzo overrode a TRUE warning because three false ones taught him it was
   *  noise. This warning must state its certainty, and must not offer the escape hatch that was
   *  misapplied — there is no "you may have written these" caveat, because now you cannot have. */
  it('offers no heredoc escape hatch — the old caveat is what got a true warning waved through', () => {
    const text = stalePathWarning(['a.txt'], 'git add -A').toLowerCase();
    expect(text).not.toContain('heredoc');
    expect(text).not.toContain('carry on');
    expect(text).not.toMatch(/\berror\b|\bblocked\b|\bdenied\b/);
  });
});
