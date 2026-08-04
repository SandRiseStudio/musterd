/*
 * Allocate the next free ADR number — across the working tree, `origin/main`, AND every open PR.
 *
 *   pnpm adr:next              — print the next free number and what was consulted
 *   pnpm adr:next --quiet      — print just the number (for scripting)
 *
 * Why this exists (ADR 220). The old convention was "pick the next free number, checking
 * origin/main". That instruction names the wrong source: a number is not free because `main` lacks
 * it — it is free because *nothing in flight* claims it. On 2026-08-04 two ADRs collided on 214 and
 * two more nearly collided on 219, each time because both authors read `main`, both saw the same
 * highest number, and neither could see the other's open PR. `adr-numbers:check` caught it, but only
 * after a red CI run, and the author who did nothing wrong paid for it.
 *
 * So this reads the set that actually matters: local files ∪ origin/main ∪ open PR branches. The
 * GitHub half is best-effort — without `gh`, or offline, it degrades to the old answer and says so
 * LOUDLY, because a silent degrade would reintroduce the exact blind spot it exists to remove.
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const ADR_DIR = join(repoRoot, 'docs', 'decisions');
const ADR_PATH = /(?:^|\/)(\d{3})-[^/]*\.md$/;

/**
 * The next free number: one past the highest claimed, never a gap-filler.
 *
 * Gaps are deliberate and must stay unfilled. `adr-numbers:check` already permits them ("gaps from
 * abandoned/renumbered ADRs are fine"), and a gap usually means a number was *once* referenced —
 * in a superseded ADR, a commit message, a branch that lost a race. Reusing it would silently point
 * an old reference at a new decision, which is worse than a wasted integer.
 */
export function nextAdrNumber(claimed: Iterable<number>): number {
  let max = 0;
  for (const n of claimed) if (Number.isInteger(n) && n > max) max = n;
  return max + 1;
}

/** ADR numbers named by a list of paths (any path shape — repo-relative, bare filename). */
export function adrNumbersInPaths(paths: Iterable<string>): number[] {
  const out: number[] = [];
  for (const p of paths) {
    const m = ADR_PATH.exec(p);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Local working-tree ADRs. */
function localNumbers(): number[] {
  return adrNumbersInPaths(readdirSync(ADR_DIR));
}

/**
 * Refresh the `origin/main` ref before reading it.
 *
 * `origin/main` is a LOCAL ref, and it is only as current as your last fetch. On 2026-08-04 this
 * tool reported 224 free while #637 had already merged holding it — the answer was correct about a
 * `main` that was hours old. ADR 223 made claims visible earlier; that buys nothing if the reader
 * is looking at a stale copy. So the read is preceded by a fetch of exactly one ref.
 *
 * Best-effort, like the `gh` half (ADR 220): offline still answers, and says so.
 */
function refreshMainRef(): boolean {
  try {
    git(['fetch', '--quiet', 'origin', 'main']);
    return true;
  } catch {
    return false;
  }
}

/** ADRs on `origin/main` — the branch everything lands on. */
function mainNumbers(): number[] {
  try {
    return adrNumbersInPaths(
      git(['ls-tree', '-r', '--name-only', 'origin/main', 'docs/decisions/']).split('\n'),
    );
  } catch {
    return [];
  }
}

/** ADRs claimed by an OPEN pull request — the set the old convention could not see. */
function openPrNumbers(): { numbers: number[]; consulted: boolean; byPr: string[] } {
  const byPr: string[] = [];
  try {
    const raw = execFileSync('gh', ['pr', 'list', '--state', 'open', '--json', 'number,files'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const prs = JSON.parse(raw) as { number: number; files?: { path: string }[] }[];
    const numbers: number[] = [];
    for (const pr of prs) {
      const claimed = adrNumbersInPaths((pr.files ?? []).map((f) => f.path));
      for (const n of claimed) {
        numbers.push(n);
        byPr.push(`PR #${pr.number} claims ADR ${String(n).padStart(3, '0')}`);
      }
    }
    return { numbers, consulted: true, byPr };
  } catch {
    return { numbers: [], consulted: false, byPr };
  }
}

function run(): void {
  const quiet = process.argv.includes('--quiet');
  const local = localNumbers();
  const fetched = refreshMainRef();
  const main = mainNumbers();
  const prs = openPrNumbers();
  const next = nextAdrNumber([...local, ...main, ...prs.numbers]);
  const padded = String(next).padStart(3, '0');

  if (quiet) {
    process.stdout.write(`${padded}\n`);
  } else {
    process.stdout.write(`next free ADR number: ${padded}\n\n`);
    process.stdout.write(
      `  working tree   highest ${String(Math.max(0, ...local)).padStart(3, '0')} (${local.length} ADRs)\n`,
    );
    process.stdout.write(
      `  origin/main    highest ${String(Math.max(0, ...main)).padStart(3, '0')} (${main.length} ADRs)${
        fetched ? ' (fetched just now)' : ''
      }\n`,
    );
    if (prs.consulted) {
      process.stdout.write(
        prs.byPr.length > 0
          ? `  open PRs       ${prs.byPr.join(', ')}\n`
          : `  open PRs       none claim an ADR number\n`,
      );
    }
    process.stdout.write(
      `\nName the file docs/decisions/${padded}-<slug>.md with a matching \`# ${padded} — …\` H1.\n`,
    );
    // ADR 223: this answer is only correct until someone else runs the same command. Publishing the
    // claim is what makes it visible to their `open PRs` line — an unpushed branch is invisible to
    // every other seat for the whole authoring session, which is how ADR 221 collided.
    process.stdout.write(
      `Push the branch as a draft PR now, before writing it, so ${padded} is visible to the next seat (ADR 223).\n`,
    );
  }

  if (!fetched) {
    process.stderr.write(
      `\n⚠ could not fetch origin/main — the ref read above is as old as your last fetch.\n` +
        `  On 2026-08-04 that shape reported 224 free while a merged PR already held it. Re-run\n` +
        `  with the network available before you commit to ${padded}.\n`,
    );
  }

  if (!prs.consulted) {
    process.stderr.write(
      `\n⚠ open PRs were NOT consulted (no \`gh\`, not authenticated, or offline).\n` +
        `  ${padded} is the next number free on origin/main, which is exactly the answer that produced\n` +
        `  the ADR 214 collision — a parallel open PR may already hold it. Re-run this with \`gh\`\n` +
        `  available before you push, or expect adr-numbers:check to fail for whoever lands second.\n`,
    );
  }
}

// Only the CLI run touches git/gh/stdout. Importing this module — the tests do — must stay pure:
// the exported helpers above are the unit under test, and fetching is not something a test suite
// should do on anyone's behalf.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
