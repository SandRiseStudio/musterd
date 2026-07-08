/*
 * Roadmap truth check — anchor the *declared* roadmap to reality so it can't silently overclaim or drift.
 *
 * `roadmap:check` only verifies ROADMAP.md == render(roadmap.data.ts) — self-consistency. It says nothing
 * about whether the data is TRUE. This check verifies roadmap.data.ts against signals OUTSIDE itself, in
 * the spirit of arch-trees:check / guidance:check (break the build when a claim and reality diverge):
 *
 *   1. shipped-xor-plan   — every item declares exactly one of `shipped` / `plan`. (resolveItem already
 *      enforces this at import; importing the module here re-runs it, so a violation throws before we start.)
 *   2. shipped ⟹ merged   — every `shipped: { prs }` PR is a merged commit in git history (squash subjects
 *      carry "(#N)"). Catches "marked shipped but never landed" — the overclaim risk brand.md §4 names.
 *      `{ legacy: true }` is grandfathered: it shipped before this convention, recorded but not verified.
 *   3. frozenBy agreement — an item's own freezing ADR (`frozenBy`, distinct from the ADRs it builds on)
 *      and its shipped-ness must agree:  shipped ⟹ that ADR is accepted;  NOT shipped ⟹ it is NOT accepted.
 *      The second half is the drift that motivated this: an ADR flips to accepted, nobody marks the item
 *      shipped, and the roadmap silently lies.
 *
 * Portable + offline: git history is read from the local repo (no origin/main, detached-HEAD safe); ADR
 * statuses from docs/decisions; no network. If the clone is shallow (CI without full history), PR-merge
 * verification is skipped with a warning rather than false-failing — CI fetches full history (fetch-depth:0).
 *
 *   pnpm roadmap-truth:check
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROADMAP_RAW } from '../packages/web/src/content/roadmap.data.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const adrDir = join(repoRoot, 'docs', 'decisions');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

const isShallow = (() => {
  try {
    return git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch {
    return true; // no git at all → treat as "can't verify", degrade to skip
  }
})();

/** True iff a PR number appears as a merged commit in local history (squash subject "(#N)"). */
function prMerged(pr: number): boolean {
  try {
    return git(['log', '--grep', `(#${pr})`, '--fixed-strings', '--format=%H']).trim().length > 0;
  } catch {
    return false;
  }
}

/** The first `Status:` word of an ADR by number, lowercased — 'accepted' | 'proposed' | … | null if absent. */
function adrStatusWord(n: number): string | null {
  const prefix = String(n).padStart(3, '0') + '-';
  const file = readdirSync(adrDir).find((f) => f.startsWith(prefix) && f.endsWith('.md'));
  if (!file) return null;
  const m = readFileSync(join(adrDir, file), 'utf8').match(/^-\s*Status:\s*([A-Za-z-]+)/m);
  return m ? m[1]!.toLowerCase() : null;
}

const errors: string[] = [];
const warnings: string[] = [];
let shippedChecked = 0;
let frozenByChecked = 0;

for (const item of ROADMAP_RAW) {
  const shipped = item.shipped !== undefined;

  // (1) shipped-xor-plan — defensive (resolveItem already threw on import if violated).
  if (shipped === (item.plan !== undefined)) {
    errors.push(`"${item.id}": must declare exactly one of \`shipped\` or \`plan\`.`);
    continue;
  }

  // (2) shipped ⟹ the anchoring PR(s) are merged. Legacy is grandfathered; shallow clones skip.
  if (item.shipped && 'prs' in item.shipped) {
    shippedChecked++;
    for (const pr of item.shipped.prs) {
      if (isShallow) {
        warnings.push(
          `"${item.id}": #${pr} not verified (shallow clone — PR-merge check skipped).`,
        );
      } else if (!prMerged(pr)) {
        errors.push(
          `"${item.id}": marked shipped via #${pr}, but no merged commit for #${pr} is in git history. ` +
            `Mark an item shipped in a follow-up PR *after* its feature PR merges, and use the real PR number.`,
        );
      }
    }
  }

  // (3) frozenBy ⟺ shipped agreement — the bidirectional anchor against the ADR's own Status line.
  if (item.frozenBy !== undefined) {
    frozenByChecked++;
    const st = adrStatusWord(item.frozenBy);
    if (st === null) {
      errors.push(
        `"${item.id}": frozenBy names ADR ${item.frozenBy}, but no such file in docs/decisions.`,
      );
    } else if (shipped && st !== 'accepted') {
      errors.push(
        `"${item.id}": shipped, but its freezing ADR ${item.frozenBy} is "${st}", not accepted — ` +
          `flip the ADR status, or the item isn't really done.`,
      );
    } else if (!shipped && st === 'accepted') {
      errors.push(
        `"${item.id}": still "${item.plan}", but its freezing ADR ${item.frozenBy} is accepted — ` +
          `the roadmap looks stale; mark it shipped (with its merged PR) or the ADR is premature.`,
      );
    }
  }
}

for (const w of warnings) process.stdout.write(`⚠ ${w}\n`);
if (errors.length > 0) {
  for (const e of errors) process.stderr.write(`✗ ${e}\n`);
  process.stderr.write(
    `\nThe roadmap's declared status disagrees with reality (git history / ADR statuses). ` +
      `roadmap.data.ts is a curated *declaration*; this check keeps it honest — fix the data or the anchor. ` +
      `See scripts/check-roadmap-truth.ts.\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `✓ roadmap truth: ${ROADMAP_RAW.length} items — ${shippedChecked} shipped anchored to merged PRs` +
    `${isShallow ? ' (skipped: shallow clone)' : ''}, ${frozenByChecked} frozenBy ADRs consistent.\n`,
);
