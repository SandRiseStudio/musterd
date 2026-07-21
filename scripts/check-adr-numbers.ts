/*
 * Check that every ADR under docs/decisions/ owns a UNIQUE number, and that its `# NNN — …` H1 agrees
 * with its filename number.
 *
 *   pnpm adr-numbers:check   — fail (exit 1) on any duplicate number, or a heading/filename mismatch
 *
 * Why this gate exists: ADR numbers are picked by hand on a branch, so two branches developed in
 * parallel can each claim the same next number (`152`, `153`, …) and the collision only surfaces at
 * merge — or silently clobbers one ADR with the other. This gate turns that into a build failure the
 * moment both files coexist in a tree, so a number clash is caught in CI, not discovered after the fact.
 * (It does NOT require a contiguous sequence — gaps from abandoned/renumbered ADRs are fine; only
 * *collisions* and *self-inconsistent* files are errors.)
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const ADR_DIR = join(repoRoot, 'docs', 'decisions');

/** Every `NNN-<slug>.md` ADR file paired with its filename number. */
function findAdrs(): { file: string; num: number }[] {
  const out: { file: string; num: number }[] = [];
  for (const entry of readdirSync(ADR_DIR)) {
    const m = /^(\d{3})-.*\.md$/.exec(entry);
    if (m) out.push({ file: join(ADR_DIR, entry), num: Number(m[1]) });
  }
  return out.sort((a, b) => a.num - b.num);
}

/** The number in the first `# NNN — …` H1, or null if the H1 doesn't lead with a number. */
function headingNumber(text: string): number | null {
  for (const line of text.split('\n')) {
    const m = /^#\s+(?:ADR\s+)?(\d{1,3})\b/.exec(line);
    if (m) return Number(m[1]);
    if (/^#\s+/.test(line)) return null; // first H1 is not number-led — don't guess
  }
  return null;
}

/**
 * Escape hatch for a pre-existing collision that a clean renumber can't yet resolve (the same
 * pragmatic carve-out as `check-obs-evals` / `check-vocab`). Currently EMPTY: the one historical
 * collision this gate first caught — two ADR 137s — was resolved by renumbering the unified-logo ADR
 * to 154 (the superseded roster-chip ADR keeps 137, so ADR 138's "supersedes 137" stays intact).
 * Add a number here only for a genuinely un-renumberable historical dup, never to wave a new one
 * through — a NEW collision (any number not listed) fails the build, which is the whole point.
 */
const ALLOWED_DUPLICATE_NUMBERS = new Set<number>([]);

const adrs = findAdrs();
let failed = false;

// 1) Uniqueness — group files by number, report every number owned by more than one file.
const byNum = new Map<number, string[]>();
for (const { file, num } of adrs) {
  const list = byNum.get(num) ?? [];
  list.push(relative(repoRoot, file));
  byNum.set(num, list);
}
for (const [num, files] of [...byNum].sort((a, b) => a[0] - b[0])) {
  if (files.length <= 1) continue;
  const nnn = String(num).padStart(3, '0');
  const bodies = files.map((f) => `    ${f}\n`).join('');
  if (ALLOWED_DUPLICATE_NUMBERS.has(num)) {
    process.stdout.write(
      `⚠ ADR number ${nnn} is a grandfathered pre-existing collision (${files.length} files) — ` +
        `pending a deliberate renumber:\n${bodies}`,
    );
    continue;
  }
  failed = true;
  process.stderr.write(`✗ ADR number ${nnn} is claimed by ${files.length} files:\n${bodies}`);
}

// 2) Heading agreement — the H1's number must match the filename number.
for (const { file, num } of adrs) {
  const rel = relative(repoRoot, file);
  const hn = headingNumber(readFileSync(file, 'utf8'));
  if (hn !== null && hn !== num) {
    failed = true;
    process.stderr.write(
      `✗ ${rel} — filename is ADR ${String(num).padStart(3, '0')} but its H1 says ` +
        `ADR ${String(hn).padStart(3, '0')} (rename the file or fix the heading so they agree)\n`,
    );
  }
}

if (failed) {
  process.stderr.write(
    `\nADR numbers must be unique and match their heading. Pick the next free number ` +
      `(check origin/main first — a parallel branch may have taken it), and keep the ` +
      `\`# NNN — …\` H1 in step with the filename.\n`,
  );
  process.exit(1);
}
process.stdout.write(`All ${adrs.length} ADR(s) have a unique number matching their heading.\n`);
