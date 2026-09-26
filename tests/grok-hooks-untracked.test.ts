import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR 454: `.grok/hooks/musterd.json` must never be tracked.
 *
 * `musterd init --refresh-hooks` rewrites the `# musterd-grok-* eN` tag on every FEATURE_EPOCH
 * bump. While the file was committed, that rewrite dirtied every seat workspace and stamped
 * builds `-dirty`. Cursor and Codex hook files were already ignored; this was the exception.
 *
 * Asserted against the real repo, because the fact under test is this repository's index and
 * `.gitignore`. A fixture would prove only that git works.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const HOOK = '.grok/hooks/musterd.json';

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

describe('the Grok hooks file stays out of git (ADR 454)', () => {
  it('tracks no .grok/hooks/musterd.json', () => {
    const tracked = git(['ls-files', '--', HOOK]).split('\n').filter(Boolean);
    expect(tracked).toEqual([]);
  });

  it('is ignored at the repo root', () => {
    // `check-ignore` exits 1 when a path is NOT ignored, which execFileSync turns into a throw.
    const ignored = git(['check-ignore', '--no-index', HOOK]).split('\n').filter(Boolean);
    expect(ignored).toEqual([HOOK]);
  });
});
