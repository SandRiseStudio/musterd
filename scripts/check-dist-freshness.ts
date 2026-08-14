/*
 * Fail before `tsc` gets to lie: a stale sibling `dist/` makes typecheck blame a file nobody
 * touched.
 *
 *   pnpm dist:check    (and as the pre-step of `pnpm typecheck`)
 *
 * Cross-package imports resolve through each package's `exports`, which point at gitignored
 * `dist/`. Switching refs never refreshes those, so a dist can be older than the source it claims
 * to build — and tsc then reports phantom missing members of `@musterd/protocol` in files the seat
 * never opened. That misdiagnosis fired five times over 2026-08-13/14 across three seats and twice
 * produced a "main is RED on your lane" report that had to be retracted; the history is in
 * docs/wiki/running-the-gates.md.
 *
 * ADR 267 closed the vitest half by aliasing `@musterd/*` to src. The READERS of dist are what is
 * left: `tsc` (build-first by design), node-run scripts that import built output, and the
 * deliberate dist guard in packages/mcp/src/dist-imports.test.ts. This gate covers those.
 *
 * The instrument already existed — ADR 135 stamps `dist/build.json` with `{ ref, builtAt }` — so
 * this reads a fact rather than guessing at one. Three independent staleness signals:
 *
 *   never-built  no dist/build.json at all
 *   src-newer    a src file was modified after the dist was built (also catches an incremental
 *                `tsc` that skipped a package, which is why `pnpm build` alone is not enough)
 *   ref-behind   the dist was built from a different commit AND that package's src changed since
 *                — the ref-switch case, which survives even when mtimes are preserved
 *
 * The second half of `ref-behind` is the point: a dist built two commits ago is perfectly good if
 * nothing under its own src moved. A gate that cries wolf on every `git pull` is a gate people
 * learn to ignore, and this one has to stay believable to be worth having.
 *
 * Runs on Node's native TypeScript (no build step, no deps) — a gate that guards the build must
 * not need the build.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export type StaleReason = 'never-built' | 'src-newer' | 'ref-behind';

export type StaleDist = {
  pkg: string;
  reason: StaleReason;
  /** the commit the dist was built from, `null` outside a git checkout */
  builtFrom: string | null;
  builtAt: string | null;
  /** what gives it away — the newer src file, or the src files that moved since the stamp */
  evidence: string;
};

export type Options = {
  /** the commit the checkout is on; defaults to `git rev-parse HEAD` */
  head?: string;
  /** src paths that changed between a dist's ref and HEAD; defaults to `git diff --name-only` */
  changedSrc?: (ref: string, pkg: string) => string[];
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function git(root: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** Newest mtime under a directory, and the file that carries it. */
function newestUnder(dir: string): { ms: number; file: string } | null {
  let best: { ms: number; file: string } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    const found = st.isDirectory() ? newestUnder(p) : { ms: st.mtimeMs, file: p };
    if (found && (!best || found.ms > best.ms)) best = found;
  }
  return best;
}

/** A package stamps its dist iff its build script ends in the ADR 135 stamper. */
function stampsItsDist(pkgDir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      scripts?: { build?: string };
    };
    return (pkg.scripts?.build ?? '').includes('stamp-build.mjs');
  } catch {
    return false;
  }
}

function readStamp(pkgDir: string): { ref: string | null; builtAt: string } | null {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'dist', 'build.json'), 'utf8')) as {
      ref: string | null;
      builtAt: string;
    };
  } catch {
    return null;
  }
}

export function findStaleDists(root: string, opts: Options = {}): StaleDist[] {
  const head = opts.head ?? git(root, 'rev-parse', 'HEAD') ?? '';
  const changedSrc =
    opts.changedSrc ??
    ((ref: string, pkg: string): string[] =>
      (git(root, 'diff', '--name-only', ref, 'HEAD', '--', `packages/${pkg}/src`) ?? '')
        .split('\n')
        .filter(Boolean));

  const out: StaleDist[] = [];
  let pkgs: string[];
  try {
    pkgs = readdirSync(join(root, 'packages')).sort();
  } catch {
    return out;
  }

  for (const pkg of pkgs) {
    const pkgDir = join(root, 'packages', pkg);
    if (!stampsItsDist(pkgDir)) continue;

    const stamp = readStamp(pkgDir);
    if (!stamp) {
      out.push({
        pkg,
        reason: 'never-built',
        builtFrom: null,
        builtAt: null,
        evidence: `packages/${pkg}/dist/build.json is missing`,
      });
      continue;
    }

    const newest = newestUnder(join(pkgDir, 'src'));
    const builtAtMs = Date.parse(stamp.builtAt);
    if (newest && Number.isFinite(builtAtMs) && newest.ms > builtAtMs) {
      out.push({
        pkg,
        reason: 'src-newer',
        builtFrom: stamp.ref,
        builtAt: stamp.builtAt,
        evidence: relative(root, newest.file),
      });
      continue;
    }

    // A `-dirty` stamp is the same commit, built with uncommitted edits on top — the mtime check
    // above is what judges those, so strip the suffix rather than reading it as a mismatch. A null
    // ref (published tarball, no git) is an unknown build, and an unknown build is never reported
    // as a lie — the same degrade-to-silence the stamper itself promises.
    const ref = stamp.ref?.replace(/-dirty$/, '') ?? null;
    if (ref && head && ref !== head) {
      const changed = changedSrc(ref, pkg);
      if (changed.length > 0) {
        out.push({
          pkg,
          reason: 'ref-behind',
          builtFrom: stamp.ref,
          builtAt: stamp.builtAt,
          evidence: changed.map((c) => relative(`packages/${pkg}/`, c)).join(', '),
        });
      }
    }
  }
  return out;
}

const WHY: Record<StaleReason, string> = {
  'never-built': 'never built',
  'src-newer': 'source is newer than the build',
  'ref-behind': 'built from another commit, and its source moved since',
};

export function renderStaleBanner(stale: StaleDist[]): string {
  const lines: string[] = ['', 'Stale build output — typecheck is about to lie to you.', ''];
  for (const s of stale) {
    lines.push(`  ✗ @musterd/${s.pkg} — ${WHY[s.reason]}`);
    if (s.builtFrom) lines.push(`      built from  ${s.builtFrom.slice(0, 8)}  (${s.builtAt})`);
    lines.push(`      evidence    ${s.evidence}`);
  }
  lines.push(
    '',
    '  tsc resolves @musterd/* to sibling dist/*.d.ts, so it is about to report',
    '  missing members in a file you never touched. Do NOT report main as RED,',
    '  and do NOT blame a teammate’s merged PR, before rebuilding:',
    '',
    '      pnpm -r build',
    '',
    '  Five recurrences, 2026-08-13/14 — docs/wiki/running-the-gates.md',
    '',
  );
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const stale = findStaleDists(repoRoot);
  if (stale.length > 0) {
    console.error(renderStaleBanner(stale));
    process.exit(1);
  }
  console.log('✓ every stamped dist/ is current with its src');
}
