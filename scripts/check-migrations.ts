/*
 * Check that the migration ladder is STRICTLY ASCENDING in array order.
 *
 *   pnpm migrations:check   — fail (exit 1) on a duplicate or out-of-order `version:`
 *
 * Why this gate exists, stated precisely rather than as folklore. `runMigrations` walks MIGRATIONS in
 * ARRAY order and skips anything it has already passed:
 *
 *     for (const m of MIGRATIONS) { if (m.version <= applied) continue; …; applied = m.version; }
 *
 * So a version that is not strictly greater than the one before it is **never applied — on a fresh
 * database, silently, forever**, while `schema_meta` still records a perfectly plausible number. The
 * damage is not "the schema depends on merge order"; it is a column or table that simply does not
 * exist, on every machine that initialises after the collision, with nothing raised anywhere. That is
 * the single worst failure shape in this repo's schema layer, and until now nothing checked for it.
 *
 * It has been live twice. izzo (ADR 232) and stanley (ADR 234) both wrote v32 in the same week and
 * only a merge conflict caught it; stanley then nearly shipped a botched conflict resolution while
 * rebasing ADR 244, which is exactly how two entries end up sharing one number without git noticing.
 *
 * **This gate is the BACKSTOP, not the fix** — the same posture as `check-adr-numbers`. It is offline
 * and deterministic, so it can only see versions that already coexist in one tree, by which point
 * someone has burned a red CI run or a rebase. Prevention is asking before you pick: coordinate
 * in-band, the way the v34/v35/v36 sequence was settled on 2026-08-06 at a cost of nothing.
 *
 * GAPS ARE FINE and are deliberately not an error — the runner applies whatever it finds with
 * `version > applied`, so a skipped number costs nothing, and a renumbered branch can legitimately
 * leave one. Only *collisions* and *descending* steps break the ladder. Same carve-out reasoning as
 * `check-adr-numbers`, which likewise tolerates gaps and fails only on duplicates.
 *
 * Deliberately parses the SOURCE rather than importing it: `migrations.ts` pulls in the protocol
 * package and the schema DDL, so importing would make a format-chain gate depend on a build. An
 * offline regex over one well-known file keeps this runnable on a broken tree — which is when you
 * most want it.
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const MIGRATIONS_FILE = join(repoRoot, 'packages', 'server', 'src', 'db', 'migrations.ts');

export interface ParsedMigration {
  version: number;
  /** 1-indexed source line, so a failure points at the entry rather than at the file. */
  line: number;
}

/**
 * Every `version: N` object KEY in source order.
 *
 * The key must open its position — preceded by a `{` or by nothing but indentation — which is what
 * separates a migration entry from the word "version" in a comment or inside a SQL string. Both
 * layouts count: the multi-line form the file uses today, and a one-line `{ version: 4, … }`.
 *
 * Accepting BOTH is the load-bearing part, and it was a real defect on the first draft: anchoring
 * only to line-start made an inline entry invisible, so adding one would have silently shrunk what
 * the gate could see while it still reported success. A gate that misses is worse than no gate,
 * because the team stops looking — the same class of defect miley's `tokens:check` shipped twice in
 * one build, where the check was lying about the lie before it was right about it once.
 */
export function parseMigrationVersions(source: string): ParsedMigration[] {
  const out: ParsedMigration[] = [];
  source.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(/(?:^|\{)\s*version:\s*(\d+)\s*[,}]/g)) {
      out.push({ version: Number(m[1]), line: i + 1 });
    }
  });
  return out;
}

/** Every place the ladder fails to step strictly upward, in source order. */
export function findLadderBreaks(
  migrations: readonly ParsedMigration[],
): { previous: ParsedMigration; offending: ParsedMigration; kind: 'duplicate' | 'descending' }[] {
  const breaks: {
    previous: ParsedMigration;
    offending: ParsedMigration;
    kind: 'duplicate' | 'descending';
  }[] = [];
  for (let i = 1; i < migrations.length; i++) {
    const previous = migrations[i - 1]!;
    const offending = migrations[i]!;
    if (offending.version > previous.version) continue;
    breaks.push({
      previous,
      offending,
      kind: offending.version === previous.version ? 'duplicate' : 'descending',
    });
  }
  return breaks;
}

// A gate that finds nothing must say so loudly rather than pass: if this file is ever restructured so
// the regex stops matching, a silent green is indistinguishable from a healthy ladder — and this gate
// would then be worse than absent, because the team would trust it.
const source = readFileSync(MIGRATIONS_FILE, 'utf8');
const migrations = parseMigrationVersions(source);
const rel = relative(repoRoot, MIGRATIONS_FILE);

if (migrations.length === 0) {
  process.stderr.write(
    `✗ ${rel} — no \`version: N,\` entries found. Either the file moved or its shape changed; this ` +
      `gate cannot see the ladder and is therefore not checking anything. Fix the parser before ` +
      `trusting a green run.\n`,
  );
  process.exit(1);
}

const breaks = findLadderBreaks(migrations);
for (const { previous, offending, kind } of breaks) {
  if (kind === 'duplicate') {
    process.stderr.write(
      `✗ ${rel}:${offending.line} — migration version ${offending.version} is claimed twice ` +
        `(also at line ${previous.line}).\n` +
        `  runMigrations skips anything \`<= applied\`, so THE SECOND ONE NEVER RUNS — on a fresh\n` +
        `  database, silently, while schema_meta still reports ${offending.version}. Renumber it to\n` +
        `  ${migrations[migrations.length - 1]!.version + 1} or higher.\n`,
    );
  } else {
    process.stderr.write(
      `✗ ${rel}:${offending.line} — migration version ${offending.version} follows ` +
        `${previous.version} (line ${previous.line}), so the ladder steps DOWN.\n` +
        `  runMigrations applies in array order and skips anything \`<= applied\`, so this entry\n` +
        `  never runs on a fresh database. Move it after ${previous.version} or renumber it.\n`,
    );
  }
}

if (breaks.length > 0) {
  process.stderr.write(
    `\nMigration versions must increase strictly, in array order. Gaps are fine — only collisions\n` +
      `and downward steps break the ladder. Coordinate the number in-band before you write it; this\n` +
      `gate is the backstop, not the fix.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `✓ ${migrations.length} migration(s), v${migrations[0]!.version}…v${migrations[migrations.length - 1]!.version}, strictly ascending\n`,
);
