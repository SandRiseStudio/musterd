/*
 * Gate the wiki (memory reexamination spec): the derived index is in sync, defect-shaped claims
 * carry a date, intra-wiki links resolve. Chained from `format:check` like every doc gate.
 *
 *   pnpm wiki:check   — exit 1 on any failure, one line each on stderr
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIndex, WIKI_DIR } from './wiki-index.ts';

/** The dangerous shape: an assertion that something is broken/absent. Deliberately narrow — a
 *  looser net lints ordinary prose; widen only with a failing example in hand. */
const DEFECT_RE =
  /\b(?:is broken|is missing|never (?:fires|runs|installs|happens|works|comes)|does not (?:work|exist|fire|run|install)|cannot (?:be|reach|see|tell)|no way to)\b/i;
const DATED_RE = /\(20\d\d-\d\d(?:-\d\d)?/;
const LINK_RE = /\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g;

export function checkWiki(dir: string): string[] {
  const failures: string[] = [];
  const pages = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md');

  const indexPath = join(dir, 'INDEX.md');
  if (!existsSync(indexPath) || readFileSync(indexPath, 'utf8') !== renderIndex(dir)) {
    failures.push('INDEX.md is out of sync with the pages — run `pnpm wiki:index`');
  }

  for (const name of pages) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n');
    let fenced = false;
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      if (DEFECT_RE.test(line) && !DATED_RE.test(line)) {
        failures.push(
          `${name}:${i + 1} — defect-shaped claim needs a date (and a falsifier): "${line.trim().slice(0, 80)}"`,
        );
      }
      for (const m of line.matchAll(LINK_RE)) {
        if (!m[1]!.includes('/') && !existsSync(join(dir, m[1]!))) {
          failures.push(`${name}:${i + 1} — dead wiki link: ${m[1]}`);
        }
      }
    });
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkWiki(WIKI_DIR);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`✗ ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ wiki clean — index in sync, claims dated, links live\n`);
}
