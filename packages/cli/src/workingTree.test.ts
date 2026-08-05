import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  foreignModifiedPaths,
  foreignPathWarning,
  isStageShaped,
  readSessionEdits,
  recordSessionEdit,
} from './workingTree.js';

/** ADR 239 decision 1 — only the commands that stage an *implicit* path set are worth a git status. */
describe('isStageShaped', () => {
  it.each([
    'git add -A',
    'git add .',
    'git add -u',
    'git add --all',
    'git add --update',
    'git commit -a -m wip',
    'git commit -am wip',
    'git commit --all -m wip',
    'git -C ../main add -A', // ADR 153: the sibling-worktree form normalizes to the obvious one
    'GIT_AUTHOR_NAME=x git add -A', // env-prefixed
  ])('matches %j', (cmd) => {
    expect(isStageShaped(cmd)).toBe(true);
  });

  it.each([
    'git add src/one.ts', // an explicit path set is the author's own choice — nothing implicit to warn about
    'git commit -m wip', // stages nothing
    'git status',
    'git checkout -b foo',
    'pnpm build',
    'echo git add -A is a string here',
    '',
  ])('does not match %j', (cmd) => {
    expect(isStageShaped(cmd)).toBe(false);
  });

  /** The "common case pays nothing" consequence needs a falsifier: a non-git call must never reach
   *  the git-status path, and `isStageShaped` is the only thing standing between them. */
  it('rejects every non-git command outright', () => {
    for (const cmd of ['npm add -A', 'sudo add -A', 'not-git commit -a']) {
      expect(isStageShaped(cmd)).toBe(false);
    }
  });
});

/** ADR 239 decision 3 — untracked files are deliberately NOT foreign; the false-positive floor is
 *  too high and staging an untracked file is not the incident. */
describe('foreignModifiedPaths', () => {
  const porcelain = [
    ' M a-work.txt', // another session's edit
    ' M b-work.txt', // this session's edit
    '?? scratch.log', // untracked — never reported
    'A  staged-new.ts', // already staged, tracked
    'MM both.ts',
    'R  old.ts -> new.ts',
    '',
  ].join('\n');

  it('reports tracked modified paths this session never wrote', () => {
    expect(foreignModifiedPaths(porcelain, new Set(['b-work.txt', 'both.ts', 'new.ts']))).toEqual([
      'a-work.txt',
      'staged-new.ts',
    ]);
  });

  it('never reports untracked paths, even when unknown to the session', () => {
    expect(foreignModifiedPaths(' M a.ts\n?? junk.log\n', new Set(['a.ts']))).toEqual([]);
  });

  it('is silent when every modified path is the session’s own', () => {
    expect(foreignModifiedPaths(' M a.ts\n M b.ts\n', new Set(['a.ts', 'b.ts']))).toEqual([]);
  });

  it('takes the destination side of a rename', () => {
    expect(foreignModifiedPaths('R  old.ts -> new.ts\n', new Set())).toEqual(['new.ts']);
    expect(foreignModifiedPaths('R  old.ts -> new.ts\n', new Set(['new.ts']))).toEqual([]);
  });

  it('is silent on an empty tree', () => {
    expect(foreignModifiedPaths('', new Set())).toEqual([]);
  });

  /** The incident, reduced: A edits and does not commit, B runs `git add -A` knowing only its own file. */
  it('names exactly the incident’s foreign file', () => {
    expect(foreignModifiedPaths(' M a-work.txt\n M b-work.txt\n', new Set(['b-work.txt']))).toEqual([
      'a-work.txt',
    ]);
  });
});

describe('the per-session edit index', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'musterd-wt-'));

  it('round-trips the paths a session wrote', () => {
    const d = dir();
    recordSessionEdit(d, 'sess-1', 'packages/cli/src/a.ts');
    recordSessionEdit(d, 'sess-1', 'packages/cli/src/b.ts');
    expect(readSessionEdits(d, 'sess-1')).toEqual(
      new Set(['packages/cli/src/a.ts', 'packages/cli/src/b.ts']),
    );
  });

  it('keeps sessions apart — the whole point of the index', () => {
    const d = dir();
    recordSessionEdit(d, 'sess-A', 'a.ts');
    recordSessionEdit(d, 'sess-B', 'b.ts');
    expect(readSessionEdits(d, 'sess-A')).toEqual(new Set(['a.ts']));
    expect(readSessionEdits(d, 'sess-B')).toEqual(new Set(['b.ts']));
  });

  it('reads an unknown session as empty, never as an error', () => {
    expect(readSessionEdits(dir(), 'never-seen')).toEqual(new Set());
  });

  /** Decision 2: a lost or corrupt index degrades to no warning, never to a false one. Blank and
   *  malformed lines are dropped rather than becoming phantom "own" paths. */
  it('survives a corrupt index', () => {
    const d = dir();
    writeFileSync(join(d, 'session-edits-sess-x.txt'), 'a.ts\n\n   \nb.ts\n');
    expect(readSessionEdits(d, 'sess-x')).toEqual(new Set(['a.ts', 'b.ts']));
  });

  it('does not let a session id escape into a path', () => {
    const d = dir();
    recordSessionEdit(d, '../../etc/passwd', 'a.ts');
    expect(readFileSync(join(d, 'session-edits-......etc.passwd.txt'), 'utf8')).toContain('a.ts');
  });

  it('never fails on an unwritable directory (a hook must not break its tool call)', () => {
    expect(() => recordSessionEdit('/nonexistent/nope', 's', 'a.ts')).not.toThrow();
    expect(readSessionEdits('/nonexistent/nope', 's')).toEqual(new Set());
  });
});

describe('foreignPathWarning', () => {
  it('names the paths and says what the command will do with them', () => {
    const text = foreignPathWarning(['a-work.txt', 'docs/x.md'], 'git add -A');
    expect(text).toContain('a-work.txt');
    expect(text).toContain('docs/x.md');
    expect(text).toContain('git add -A');
  });

  /** Decision 3: worded as an observation to check, never an accusation — a heredoc or `sed -i`
   *  write is invisible to the gate and will look foreign. */
  it('is worded as an observation, not an error', () => {
    const text = foreignPathWarning(['a.txt'], 'git add -A').toLowerCase();
    expect(text).toMatch(/did not (touch|write)|never touched/);
    expect(text).not.toMatch(/\berror\b|\bblocked\b|\bdenied\b|\brefus/);
  });
});
