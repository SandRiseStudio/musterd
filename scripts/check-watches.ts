/*
 * The watch gate — a pre-registered longitudinal question cannot rot into an unread sweep.
 *
 * Three rules, deliberately scoped differently:
 *
 *   A. no watch outlives its `revisit_by`   — TREE check (plus a diff half for immutability)
 *   B. a frequency claim carries a watch    — DIFF check, never a tree check
 *   C. a resolution posts back              — DIFF check
 *
 * RULE A BREAKS THE BUILD ON A DATE ROLLOVER WITH NO CODE CHANGE. That is uncomfortable and it is
 * the design, inherited verbatim from `check-controls.ts`, which already does exactly this from
 * `format:check` today. Its pressure valve is the honest one: resolve the watch, or mark it
 * `void: unattended`. Voiding is not a dodge — it records that nobody looked, which is the datum
 * ADR 294 wants and the thing ADR 166's sweep hid for 25 days. Both leave a record; ignoring it
 * does not.
 *
 * WHY IMMUTABILITY IS A RULE AND NOT A CONVENTION. The failure this primitive exists to prevent is
 * a sweep that renews itself for free — ADR 166's ran 5,679 times over 24.8 days and was never
 * read. Renewal has to cost a decision, so `revisit_by` cannot move: continuing a question means a
 * NEW watch file, with a new question, in a diff someone reviews.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWatch, scalar, validateWatch, type Watch } from './watches.ts';

export interface ChangedWatch {
  readonly path: string;
  readonly head: Watch;
  readonly base: Watch | null;
}

/** A1 — tree check. Any open watch past its date, anywhere in the repo. */
export function ruleA(watches: Watch[], today: string): string[] {
  const errors: string[] = [];
  for (const w of watches) {
    if (scalar(w, 'status') !== 'open') continue;
    const revisitBy = scalar(w, 'revisit_by');
    if (revisitBy === undefined || revisitBy >= today) continue;
    errors.push(
      `${w.path} — open past its \`revisit_by\` (${revisitBy}, today ${today}). ` +
        `Opened by ${scalar(w, 'opened_by') ?? 'an unnamed seat'}. ` +
        'Resolve it with a verdict, or mark it `status: void` with ' +
        '`resolution: "unattended — revisit_by passed with nobody reading the series. No verdict."` ' +
        'Voiding is legitimate: it records that we failed to look. Moving the date is not.',
    );
  }
  return errors;
}

/** A2 — diff check. `revisit_by` is immutable once a watch is on main. */
export function ruleAImmutable(changed: ChangedWatch[]): string[] {
  const errors: string[] = [];
  for (const { path, head, base } of changed) {
    if (base === null) continue;
    const was = scalar(base, 'revisit_by');
    const now = scalar(head, 'revisit_by');
    if (was !== undefined && now !== undefined && was !== now) {
      errors.push(
        `${path} — \`revisit_by\` moved ${was} → ${now}. A watch cannot be renewed in place. ` +
          'Continuing the question means a NEW watch file, with a new question, in a diff someone ' +
          'reviews — that cost is the whole mechanism preventing a sweep that renews itself for free.',
      );
    }
  }
  return errors;
}

export function readWatches(repoRoot: string): Watch[] {
  const dir = join(repoRoot, 'docs/watches');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const watches: Watch[] = [];
  for (const name of names) {
    const path = `docs/watches/${name}`;
    const w = parseWatch(path, readFileSync(join(dir, name), 'utf8'));
    if (w !== null) watches.push(w);
  }
  return watches;
}

function main(): void {
  const repoRoot = process.cwd();
  const today = new Date().toISOString().slice(0, 10);
  const watches = readWatches(repoRoot);

  const errors = [...watches.flatMap((w) => validateWatch(w, { repoRoot })), ...ruleA(watches, today)];

  if (errors.length > 0) {
    process.stderr.write(`✗ watch:check\n\n${errors.map((e) => `  ${e}\n`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ watch:check — ${watches.length} watch(es), none past their revisit_by.\n`);
}

// The robust form, matching check-wiki.ts:164. Not check-controls.ts's `file://` template literal,
// which breaks on any path needing URL encoding.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
