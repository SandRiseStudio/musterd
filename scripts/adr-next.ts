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

/**
 * ADR numbers a PR claims in PROSE — its title and branch name (ADR 223 amendment, 2026-08-05).
 *
 * The file-path read below cannot see a compliant reservation. ADR 223's ritual is "push the draft
 * PR **before** writing it", and its Decision puts the number in the TITLE (`ADR 223: <slug>`) with
 * a body that "may be empty" — so a seat that follows the instruction exactly pushes a branch with
 * no `docs/decisions/` file, and the claim is invisible to the very scan the ritual exists to feed.
 * Verified on ryder's PR #703: commit c9ca4e1b, zero files under docs/decisions, number visible only
 * in the title and branch name. Three seats allocated 241 inside an hour that evening, each having
 * run this command and each correct at the moment they looked.
 *
 * So this reads the field the ritual already designates. It is deliberately a WIDENING rung: a title
 * that merely cites an ADR ("fix: the ADR 131 wake path") reserves that number too. That is the
 * cheap direction — under {@link nextAdrNumber} a number below the maximum costs nothing at all, and
 * a spurious high one costs a single skipped integer, which ADR 220 already rules is preferable to
 * reuse. An under-reservation costs a collision and a rewrite of every cross-reference.
 */
export function adrNumbersInPrText(title?: string, branch?: string): number[] {
  const found = new Set<number>();
  // `ADR 241`, `ADR-241`, `adr241` — the title shape ADR 223 specifies, case-insensitively, with the
  // separator optional. `\d{3}` with boundaries on both sides so `ADR 1234` and a bare `241` miss.
  for (const m of (title ?? '').matchAll(/\badr[\s-]?(\d{3})\b/gi)) found.add(Number(m[1]));
  // Branch names: `ryder/adr-241-wake-lease`, `feat/adr241-…`. Same shape, but `/` and `-` are the
  // separators rather than spaces, so the leading boundary is anything that is not a word character.
  for (const m of (branch ?? '').matchAll(/(?:^|[^a-z0-9])adr-?(\d{3})(?:[^0-9]|$)/gi))
    found.add(Number(m[1]));
  return [...found];
}

/** One open PR as the number-scan sees it — the shape `gh pr list --json` returns. */
export interface PrForScan {
  number: number;
  files?: { path: string }[];
  title?: string;
  headRefName?: string;
}

/**
 * Every ADR number one open PR claims, and how (ADR 223 amendment).
 *
 * `reserved: true` means the claim came from prose ALONE — a draft PR that named its number before
 * writing the ADR, exactly as the ritual instructs. That distinction is reported rather than
 * flattened: a reader who sees a number skipped needs to tell a written ADR from a reservation
 * without opening the PR, or the widened rung just turns into someone wondering where 243 went.
 *
 * Extracted as a pure function so the WIRING is testable, not merely the two matchers. The first
 * version of this change had unit tests for {@link adrNumbersInPrText} that all passed while the
 * scan ignored it — proven by mutation: emptying the prose read killed nothing.
 */
export function prClaims(pr: PrForScan): { number: number; reserved: boolean }[] {
  const fromFiles = new Set(adrNumbersInPaths((pr.files ?? []).map((f) => f.path)));
  const fromText = adrNumbersInPrText(pr.title, pr.headRefName);
  return [...new Set([...fromFiles, ...fromText])].map((n) => ({
    number: n,
    reserved: !fromFiles.has(n),
  }));
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
    const raw = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'open', '--json', 'number,files,title,headRefName'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const prs = JSON.parse(raw) as {
      number: number;
      files?: { path: string }[];
      title?: string;
      headRefName?: string;
    }[];
    const numbers: number[] = [];
    for (const pr of prs) {
      for (const claim of prClaims(pr)) {
        numbers.push(claim.number);
        byPr.push(
          `PR #${pr.number} claims ADR ${String(claim.number).padStart(3, '0')}` +
            (claim.reserved ? ' (reserved — title/branch only, no ADR file yet)' : ''),
        );
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
    //
    // The stub is the 2026-08-05 amendment. This line used to stop at "push the draft PR now,
    // before writing it" — and a seat obeying it pushed nothing the scan could see, because the
    // scan matched file paths. Naming the file in the reservation push makes the claim exact for
    // the detector AND legible to a human scanning the PR list, which is the other half of what
    // ADR 223 was for.
    process.stdout.write(
      `Push the branch as a draft PR now, before writing it, so ${padded} is visible to the next\n` +
        `seat (ADR 223) — and include a one-line stub at that path in the reservation push:\n` +
        `  git commit --allow-empty-message -m "reserve ADR ${padded}" docs/decisions/${padded}-<slug>.md\n` +
        `The title should name it too (\`ADR ${padded}: <slug>\`); both are read.\n`,
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
