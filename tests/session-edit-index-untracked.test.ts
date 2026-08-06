import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR 239's per-session edit index must never be tracked.
 *
 * `workingTree.ts` writes one index per harness session — the evidence the working-tree gate uses to
 * tell THIS session's edits from a foreign session's. It is local and disposable by design. Three of
 * them reached `main` anyway (`session-edits-1f14cba0`, `-4e182ce6`, `-548fda80`), each via a
 * `git add -A` in a different seat, because nothing ignored them: the gate's own private state
 * became shared, so pulling `main` put a foreign session's index into every seat's state dir. That
 * is precisely the cross-session contamination ADR 239 exists to detect — the instrument
 * manufacturing its own signal.
 *
 * Asserted against the REAL repo rather than a fixture, because the fact under test is a property of
 * this repository's index and `.gitignore`, and a fixture would prove only that git works.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

describe('the ADR 239 session-edit index stays out of git', () => {
  it('tracks no session index at all', () => {
    const tracked = git(['ls-files', '--', '*.musterd/session-edits-*.txt'])
      .split('\n')
      .filter(Boolean);
    expect(tracked).toEqual([]);
  });

  it('is ignored in any folder — root and nested worktrees alike', () => {
    // `check-ignore` exits 1 when a path is NOT ignored, which execFileSync turns into a throw. Both
    // paths are checked in one call so a rule that covers only the repo root fails here.
    const probe = [
      '.musterd/session-edits-00000000-0000-4000-8000-000000000000.txt',
      'packages/web/.musterd/session-edits-00000000-0000-4000-8000-000000000000.txt',
    ];
    const ignored = git(['check-ignore', '--no-index', ...probe])
      .split('\n')
      .filter(Boolean);
    expect(ignored).toHaveLength(2);
  });
});
