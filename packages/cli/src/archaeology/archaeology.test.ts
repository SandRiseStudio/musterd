import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classify,
  dupMatch,
  MIN_DUP_RUN,
  normalize,
  type CommitFacts,
  type RepoFacts,
} from './engine.js';
import { extractFacts, globToRegExp, parseDiff, resolveActor, toRanges } from './git.js';

// ── engine unit tests ────────────────────────────────────────────────────────────────────────

function commit(partial: Partial<CommitFacts> & { sha: string; actor: string }): CommitFacts {
  return {
    order: 0,
    delivered: false,
    patchId: null,
    files: [],
    merge: false,
    ...partial,
  };
}

function facts(commits: CommitFacts[], extra: Partial<RepoFacts> = {}): RepoFacts {
  return { commits, deletions: [], isAncestor: () => false, ...extra };
}

const lines = (texts: string[]): { n: number; text: string }[] =>
  texts.map((text, i) => ({ n: i + 1, text }));

describe('dupMatch', () => {
  it('flags a contiguous run of MIN_DUP_RUN identical lines', () => {
    const run = Array.from({ length: MIN_DUP_RUN }, (_, i) => `line ${i}`);
    const later = ['unique a', ...run, 'unique b'];
    const hit = dupMatch(['x', ...run, 'y'], later);
    expect([...hit].sort((a, b) => a - b)).toEqual(
      run.map((_, i) => i + 1), // run positions in `later`, not the uniques
    );
  });

  it('ignores short runs below the threshold and below the fraction', () => {
    const later = ['a', 'b', 'c', 'shared 1', 'shared 2', 'd', 'e', 'f', 'g', 'h'];
    const hit = dupMatch(['shared 1', 'shared 2', 'q', 'r', 's', 't', 'u', 'v'], later);
    expect(hit.size).toBe(0);
  });

  it('fraction rule: half the smaller side matched, even scattered', () => {
    const earlier = ['s1', 's2', 's3', 's4'];
    const later = ['s1', 'x', 's2', 'y', 's3', 'z'];
    const hit = dupMatch(earlier, later);
    expect(hit.has(0)).toBe(true);
    expect(hit.has(2)).toBe(true);
    expect(hit.has(4)).toBe(true);
    expect(hit.has(1)).toBe(false);
  });
});

describe('classify — predicate set v1', () => {
  it('W3 exact: cross-actor patch-id equality wastes the later copy only', () => {
    const f = [{ path: 'a.ts', added: lines(['const x = 1;', 'const y = 2;']) }];
    const r = classify(
      facts([
        commit({ sha: 'A', actor: 'ana', order: 1, patchId: 'p1', files: f, delivered: true }),
        commit({ sha: 'B', actor: 'bob', order: 2, patchId: 'p1', files: f }),
      ]),
    );
    expect(r.wasted.W3).toBe(2);
    expect(r.byActor['bob']!.wasted).toBe(2);
    expect(r.byActor['ana']!.wasted).toBe(0);
    expect(r.totalAuthoredLines).toBe(4);
  });

  it('W3 overlap: a shared run on the same path wastes the later actor; ancestors never match', () => {
    const run = Array.from({ length: 10 }, (_, i) => `shared line ${i};`);
    const early = [{ path: 'm.ts', added: lines([...run, 'ana only']) }];
    const late = [{ path: 'm.ts', added: lines(['bob only', ...run]) }];
    const base = [
      commit({ sha: 'A', actor: 'ana', order: 1, patchId: 'pa', files: early, delivered: true }),
      commit({ sha: 'B', actor: 'bob', order: 2, patchId: 'pb', files: late }),
    ];
    const r = classify(facts(base));
    expect(r.wasted.W3).toBe(10);
    // Same history, but B descends from A → same-branch iteration, no W3 (W1 instead: unmerged).
    const r2 = classify(facts(base, { isAncestor: (a, d) => a === 'A' && d === 'B' }));
    expect(r2.wasted.W3).toBe(0);
    expect(r2.wasted.W1).toBe(11);
  });

  it('W1 abandoned: unmerged lines waste unless a patch-equivalent copy was delivered', () => {
    const dead = [{ path: 'dead.ts', added: lines(['abandoned();']) }];
    const f = [{ path: 'w.ts', added: lines(['work();']) }];
    const r = classify(
      facts([
        commit({ sha: 'DEAD', actor: 'ana', order: 1, patchId: 'pd', files: dead }),
        commit({ sha: 'RB1', actor: 'bob', order: 2, patchId: 'pr', files: f }),
        commit({ sha: 'RB2', actor: 'bob', order: 3, patchId: 'pr', files: f, delivered: true }),
      ]),
    );
    // DEAD is W1; bob's rebase pair dedupes to the delivered copy (counted once, survived).
    expect(r.wasted.W1).toBe(1);
    expect(r.totalAuthoredLines).toBe(2);
    expect(r.byActor['bob']!.wasted).toBe(0);
  });

  it('W2 clobbered: cross-actor deletion wastes the source line; self-rework never does', () => {
    const r = classify(
      facts(
        [
          commit({
            sha: 'SRC',
            actor: 'ana',
            order: 1,
            patchId: 'p1',
            delivered: true,
            files: [{ path: 'c.ts', added: lines(['kept();', 'clobbered();', 'reworked();']) }],
          }),
          commit({ sha: 'DEL', actor: 'bob', order: 2, patchId: 'p2', delivered: true }),
        ],
        {
          deletions: [
            { delSha: 'DEL', srcSha: 'SRC', path: 'c.ts', srcLine: 2 },
            // self-rework: same actor pair is ignored even if reported by the extractor
            { delSha: 'SRC', srcSha: 'SRC', path: 'c.ts', srcLine: 3 },
          ],
        },
      ),
    );
    expect(r.wasted.W2).toBe(1);
    expect(r.lines.find((l) => l.n === 2)?.cls).toBe('W2');
  });

  it('W4: merge-delta lines are churn; squash re-land drift is W4, matched lines count once', () => {
    const branchLines = Array.from({ length: 10 }, (_, i) => `feature ${i};`);
    const r = classify(
      facts([
        commit({
          sha: 'BR',
          actor: 'ana',
          order: 1,
          patchId: 'pb',
          files: [{ path: 'f.ts', added: lines([...branchLines, 'lost in rebase;']) }],
        }),
        commit({
          sha: 'SQ',
          actor: 'ana',
          order: 2,
          patchId: 'ps',
          delivered: true,
          files: [{ path: 'f.ts', added: lines(branchLines) }],
        }),
        commit({
          sha: 'MG',
          actor: 'bob',
          order: 3,
          patchId: null,
          delivered: true,
          merge: true,
          files: [{ path: 'g.ts', added: lines(['manual conflict fix;']) }],
        }),
      ]),
    );
    expect(r.wasted.W4).toBe(2); // 1 re-land drift + 1 merge delta
    expect(r.wasted.W1).toBe(0); // the re-landed branch is not "abandoned"
    // 10 branch lines counted once via SQ + 1 drift + 1 merge churn
    expect(r.totalAuthoredLines).toBe(12);
  });

  it('blank lines are excluded and the report is empty-safe', () => {
    const r = classify(
      facts([
        commit({
          sha: 'A',
          actor: 'ana',
          patchId: 'p',
          delivered: true,
          files: [{ path: 'a.ts', added: lines(['', '   ', 'real();']) }],
        }),
      ]),
    );
    expect(r.totalAuthoredLines).toBe(1);
    expect(classify(facts([])).wastedPct).toBe(0);
  });
});

describe('normalize / globToRegExp / toRanges / resolveActor / parseDiff', () => {
  it('normalize collapses whitespace', () => {
    expect(normalize('  const   x =\t1; ')).toBe('const x = 1;');
  });

  it('globs: ** spans directories, * stays in-segment', () => {
    expect(globToRegExp('**/dist/**').test('packages/cli/dist/bin.js')).toBe(true);
    expect(globToRegExp('**/*.lock').test('sub/dir/x.lock')).toBe(true);
    expect(globToRegExp('*.lock').test('sub/x.lock')).toBe(false);
    expect(globToRegExp('**/pnpm-lock.yaml').test('pnpm-lock.yaml')).toBe(true);
  });

  it('toRanges collapses contiguous line numbers', () => {
    expect(toRanges([5, 1, 2, 3, 9])).toEqual([
      [1, 3],
      [5, 5],
      [9, 9],
    ]);
  });

  it('resolveActor prefers the musterd seat trailer over the author email', () => {
    const body =
      'msg\n\nCo-authored-by: Claude <noreply@anthropic.com>\nCo-authored-by: izzo (musterd seat) <izzo@revive.musterd>\n';
    expect(resolveActor('nick@example.com', body)).toBe('izzo@revive.musterd');
    expect(resolveActor('Nick@Example.com', 'plain message')).toBe('nick@example.com');
  });

  it('parseDiff extracts added and deleted lines with numbers and honors exclusions', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,2 +3,1 @@',
      '-old one',
      '-old two',
      '+new one',
      'diff --git a/x.lock b/x.lock',
      '--- a/x.lock',
      '+++ b/x.lock',
      '@@ -0,0 +1,1 @@',
      '+ignored',
      '',
    ].join('\n');
    const parsed = parseDiff(diff, (p) => p.endsWith('.lock'));
    expect(parsed.files).toEqual([{ path: 'src/a.ts', added: [{ n: 3, text: 'new one' }] }]);
    expect(parsed.deleted.get('src/a.ts')).toEqual([3, 4]);
  });
});

// ── extractor integration: a synthetic multi-actor repo ─────────────────────────────────────

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sh(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  }).trim();
}

function actorEnv(name: string, email: string, when: number): Record<string, string> {
  const date = `@${when} +0000`;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

describe('extractFacts + classify on a real repo', () => {
  it('measures abandonment, exact duplication, and clobbering end to end', () => {
    const repo = mkdtempSync(join(tmpdir(), 'march-'));
    made.push(repo);
    sh(repo, ['init', '-q', '-b', 'main']);

    // kickoff scaffold
    writeFileSync(join(repo, 'base.txt'), 'scaffold\n');
    sh(repo, ['add', '.'], actorEnv('nick', 'nick@example.com', 1000));
    sh(repo, ['commit', '-q', '-m', 'kickoff'], actorEnv('nick', 'nick@example.com', 1000));
    const start = sh(repo, ['rev-parse', 'HEAD']);

    // ana lands 3 lines on main
    writeFileSync(join(repo, 'ana.txt'), 'ana one\nana two\nana three\n');
    sh(repo, ['add', '.'], actorEnv('ana', 'ana@t.musterd', 2000));
    sh(repo, ['commit', '-q', '-m', 'ana: feature'], actorEnv('ana', 'ana@t.musterd', 2000));

    // bob authors the byte-identical change on his own branch (duplicate-scope trap)
    sh(repo, ['checkout', '-q', '-b', 'bob-dup', start]);
    writeFileSync(join(repo, 'ana.txt'), 'ana one\nana two\nana three\n');
    sh(repo, ['add', '.'], actorEnv('bob', 'bob@t.musterd', 3000));
    sh(repo, ['commit', '-q', '-m', 'bob: same feature'], actorEnv('bob', 'bob@t.musterd', 3000));

    // carol abandons a branch outright
    sh(repo, ['checkout', '-q', '-b', 'carol-dead', start]);
    writeFileSync(join(repo, 'carol.txt'), 'carol dead work\n');
    sh(repo, ['add', '.'], actorEnv('carol', 'carol@t.musterd', 4000));
    sh(repo, ['commit', '-q', '-m', 'carol: wip'], actorEnv('carol', 'carol@t.musterd', 4000));

    // back on main, bob deletes one of ana's delivered lines (clobber)
    sh(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'ana.txt'), 'ana one\nana three\n');
    sh(repo, ['add', '.'], actorEnv('bob', 'bob@t.musterd', 5000));
    sh(repo, ['commit', '-q', '-m', 'bob: prune'], actorEnv('bob', 'bob@t.musterd', 5000));

    const report = classify(extractFacts({ repo, start, delivered: 'main' }));

    expect(report.wasted.W3).toBe(3); // bob's identical copy
    expect(report.wasted.W1).toBe(1); // carol's dead branch
    expect(report.wasted.W2).toBe(1); // ana's clobbered line
    expect(report.byActor['bob@t.musterd']!.wasted).toBe(3);
    expect(report.byActor['ana@t.musterd']!.wasted).toBe(1);
    // ana 3 + bob dup 3 + carol 1 (bob's prune commit adds no lines)
    expect(report.totalAuthoredLines).toBe(7);
    expect(report.wastedPct).toBeCloseTo((5 / 7) * 100, 5);
  });

  it('resolves the seat from the Co-authored-by trailer on a squash-style commit', () => {
    const repo = mkdtempSync(join(tmpdir(), 'march-'));
    made.push(repo);
    sh(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'base.txt'), 'scaffold\n');
    sh(repo, ['add', '.'], actorEnv('nick', 'nick@example.com', 1000));
    sh(repo, ['commit', '-q', '-m', 'kickoff'], actorEnv('nick', 'nick@example.com', 1000));
    const start = sh(repo, ['rev-parse', 'HEAD']);

    writeFileSync(join(repo, 'seat.txt'), 'seat work\n');
    sh(repo, ['add', '.'], actorEnv('Nick Sanders', 'nick@example.com', 2000));
    sh(
      repo,
      [
        'commit',
        '-q',
        '-m',
        'feat: x (#1)\n\nCo-authored-by: izzo (musterd seat) <izzo@revive.musterd>',
      ],
      actorEnv('Nick Sanders', 'nick@example.com', 2000),
    );

    const report = classify(extractFacts({ repo, start }));
    expect(Object.keys(report.byActor)).toEqual(['izzo@revive.musterd']);
  });
});
