// Stamp dist/build.json with the git SHA this dist was built from (ADR 135).
//
// Runs as the `&& node ../../scripts/stamp-build.mjs` tail of each package's build script, so cwd is
// the package dir (pnpm runs scripts there). The stamp is the truth of *what the code is* — unlike a
// boot-time `git rev-parse` (ADR 130), which reports what the *checkout* is and so reads "fresh" when
// someone checked out main but forgot to rebuild. A dirty worktree gets a `-dirty` suffix: a build cut
// from uncommitted edits must not masquerade as a clean commit.
//
// Dependency-free and never throws: outside a git checkout (published tarball, CI cache) it writes
// `ref: null`, and every consumer degrades to silence — an unknown build is never reported as a lie.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

function git(...args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}

const sha = git('rev-parse', 'HEAD');
const dirty = sha !== null && git('status', '--porcelain') !== '' ? '-dirty' : '';
const ref = sha && /^[0-9a-f]{40}$/.test(sha) ? sha + dirty : null;
try {
  mkdirSync('dist', { recursive: true });
  writeFileSync(
    'dist/build.json',
    JSON.stringify({ ref, builtAt: new Date().toISOString() }) + '\n',
  );
} catch {
  // best-effort: a failed stamp must never fail the build
}
