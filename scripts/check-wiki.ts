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
/** A heading with nothing under it — a section left dangling by a partial edit.
 *
 *  KNOWN LIMIT, measured 2026-08-13 before shipping: this does NOT catch the case that motivated it.
 *  #813 REPLACED the `## Never pnpm format` heading text, so its body ended up appended to the
 *  preceding section — a perfectly well-formed file with no empty heading anywhere, and this check
 *  passes it (reproduced live on the real page: exit 0). Catching that needs a diff-aware check —
 *  a heading line removed while its body survives — which is history-dependent, unlike the rest of
 *  this gate. Do not read a green run as "no section was eaten". */
const HEADING_RE = /^#{1,6}\s/;
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
    /** The last heading seen with no body under it yet — see `orphan` below. */
    let pending: { text: string; line: number } | null = null;
    const orphan = (h: { text: string; line: number }) =>
      failures.push(
        `${name}:${h.line} — heading has no body (section left dangling): "${h.text.trim().slice(0, 80)}"`,
      );

    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        pending = null; // a fence is a body
        return;
      }
      if (fenced) {
        pending = null;
        return;
      }
      if (HEADING_RE.test(line)) {
        if (pending) orphan(pending);
        pending = { text: line, line: i + 1 };
        return;
      }
      if (line.trim() !== '') pending = null;
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
    if (pending) orphan(pending);
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkWiki(WIKI_DIR);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`✗ ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ wiki clean — index in sync, claims dated, links live, sections whole\n`);
}
