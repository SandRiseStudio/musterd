/*
 * Gate the wiki (memory reexamination spec): the derived index is in sync, defect-shaped claims
 * carry a date, intra-wiki links resolve. Chained from `format:check` like every doc gate.
 *
 *   pnpm wiki:check   — exit 1 on any failure, one line each on stderr
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Circular with wiki-coverage.ts (it reads this file's regexes) — safe: both sides only touch the
// other's bindings inside functions, never during module evaluation.
import { coverageFailures, extractClaims, measureCoverage } from './wiki-coverage.ts';
import { renderIndex, WIKI_DIR } from './wiki-index.ts';

/** The dangerous shape: an assertion that something is broken/absent. Deliberately narrow — a
 *  looser net lints ordinary prose; widen only with a failing example in hand.
 *
 *  THIS LIST IS A DENYLIST, AND A DENYLIST OF DEFECT VOCABULARY GOES STALE THE WAY A BASELINE DOES:
 *  it polices the defects we used to find, not the one we currently find most. It has gone stale
 *  once already. Measured 2026-08-24 against `checkWiki` itself (falsify: revert this widening and
 *  re-run `defect-shaped claims` in wiki.test.ts — the ten `reaches nobody` cases go green), the
 *  whole "reaches nobody" family passed undated: "read by nothing", "populated by nothing",
 *  "computed and never used", "served to nobody", "has never been read", "stored but never served".
 *  That is the family this team found four instances of in one night — config.modelDrift,
 *  neverExercised, ReconcileResult.errors, OccupiedFrame.charter — and wrote a principle about
 *  (deliver it or delete it). Every one of those pages could have carried an undated claim.
 *
 *  So: widening buys coverage, it does not buy a gate that notices its own blind spots. What the
 *  list cannot see, nothing reports. Rule 2 in README.md now says which subset is enforced rather
 *  than implying the whole rule is, and `wiki.test.ts` pins the corpus of shapes — when the next
 *  family shows up, add it there WITH its failing example, and expect this comment to be wrong
 *  again. */
export const DEFECT_RE = new RegExp(
  [
    // Intransitive — unambiguous wherever they appear.
    /\b(?:is broken|is missing|never (?:fires|runs|installs|happens|works|comes))\b/,
    /\b(?:does not (?:work|exist|fire|run|install)|cannot (?:be|reach|see|tell)|no way to)\b/,
    // The "reaches nobody" family: the thing exists, and no reader consumes it.
    /\b(?:by (?:nothing|nobody|none of)|to nobody|reach(?:es|ing) (?:nobody|no one|no reader))\b/,
    /\b(?:nothing (?:counts|reads|consumes|calls)|silently (?:dropped|discarded|deleted|ignored))\b/,
    /\bdiscarded by every\b/,
    // Transitive verbs are ambiguous: "persisted and simply never read." asserts a defect, while
    // "— never read CLI-bounded latency as transport latency" is IMPERATIVE ADVICE. Measured
    // 2026-08-24 on web-performance.md:20, which the first draft of this widening flagged wrongly.
    // The discriminator is what comes BEFORE: the imperative opens its clause, the assertion has a
    // subject in front of it ("is never called", "simply never read"). Requiring a clause end
    // AFTER instead was the first fix and it was worse — it dropped a true positive,
    // instrument-silence.md:21 "is never called no matter how many times". Falsify either half:
    // delete the lookbehind and web-performance.md:20 goes red; swap it for `(?=[.,;:)\]]|$)` and
    // instrument-silence.md:21 goes green.
    /(?<=[\w`)\]]\s)never (?:been )?(?:read|used|called|served|delivered|counted|inspected|consumed)\b/,
  ]
    .map((r) => r.source)
    .join('|'),
  'i',
);
export const DATED_RE = /\(20\d\d-\d\d(?:-\d\d)?/;
/** A heading with nothing under it — a section left dangling by a partial edit.
 *
 *  KNOWN LIMIT, measured 2026-08-13 before shipping: this does NOT catch the case that motivated it.
 *  #813 REPLACED the `## Never pnpm format` heading text, so its body ended up appended to the
 *  preceding section — a perfectly well-formed file with no empty heading anywhere, and this check
 *  passes it (reproduced live on the real page: exit 0). Catching that needs a diff-aware check —
 *  a heading line removed while its body survives — which is history-dependent, unlike the rest of
 *  this gate. Do not read a green run as "no section was eaten". */
export const HEADING_RE = /^#{1,6}\s/;
const LINK_RE = /\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g;

/** Headings of a page paired with the first non-blank line beneath each — fence-aware, so a
 *  `## <Section>` inside the README's template block is text, not structure. */
function sections(content: string): { heading: string; firstBody: string | null }[] {
  const out: { heading: string; firstBody: string | null }[] = [];
  let fenced = false;
  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      if (out.length > 0 && out[out.length - 1]!.firstBody === null)
        out[out.length - 1]!.firstBody = line.trim();
      continue;
    }
    if (fenced) continue;
    if (HEADING_RE.test(line)) {
      out.push({ heading: line.trim(), firstBody: null });
      continue;
    }
    if (line.trim() === '') continue;
    if (out.length > 0 && out[out.length - 1]!.firstBody === null)
      out[out.length - 1]!.firstBody = line.trim();
  }
  return out;
}

/**
 * The half `checkWiki` structurally cannot see: a heading REPLACED rather than deleted.
 *
 * #813 swapped the `## Never pnpm format` heading for a different one, so that section's body was
 * absorbed into the section above — a well-formed file, no empty heading, every tree-pure check
 * green, and a live trap left with no title, date or falsifier. Only the diff knows.
 *
 * A removed heading is reported ONLY when its first body line still exists in the new file AND is
 * no longer the opening line of any section. That third clause is what separates the damage from a
 * legitimate retitle: a renamed heading keeps its body at the top of its own section, whereas an
 * absorbed body sits mid-section under someone else's heading. Deleting a section outright —
 * heading and body together — is deliberate editing and passes.
 */
export function checkEatenSections(
  base: Map<string, string>,
  current: Map<string, string>,
): string[] {
  const failures: string[] = [];
  for (const [name, before] of base) {
    const after = current.get(name);
    if (after === undefined) continue; // page deleted wholesale — not this check's business
    const stillOpens = new Set(
      sections(after)
        .map((s) => s.firstBody)
        .filter((b): b is string => b !== null),
    );
    const headingsAfter = new Set(sections(after).map((s) => s.heading));
    for (const { heading, firstBody } of sections(before)) {
      if (headingsAfter.has(heading) || firstBody === null) continue;
      if (!after.includes(firstBody)) continue; // section removed entirely — deliberate
      if (stillOpens.has(firstBody)) continue; // retitled — body still opens its own section
      failures.push(
        `${name} — a section lost its heading and its body was absorbed into a neighbour: "${heading.slice(0, 70)}"`,
      );
    }
  }
  return failures;
}

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

/** Read every wiki page as of `ref`. Returns null — never an empty map — when the ref does not
 *  resolve, so the caller can say so out loud instead of reporting a vacuous pass. */
function pagesAtRef(ref: string): Map<string, string> | null {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const listed = execFileSync('git', ['ls-tree', '--name-only', ref, 'docs/wiki/'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((p) => p.endsWith('.md') && basename(p) !== 'INDEX.md');
  return new Map(
    listed.map((p) => [
      basename(p),
      execFileSync('git', ['show', `${ref}:${p}`], { encoding: 'utf8', maxBuffer: 8 << 20 }),
    ]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkWiki(WIKI_DIR);

  // The coverage meter (wiki-coverage.ts): labels must stay complete — the NUMBER never gates.
  const labels = JSON.parse(
    readFileSync(new URL('./wiki-claim-labels.json', import.meta.url), 'utf8'),
  );
  failures.push(...coverageFailures(WIKI_DIR, labels));
  const cov = measureCoverage(extractClaims(WIKI_DIR), labels);

  // The diff-aware half. Its base ref must exist or the check is inert — and an instrument that
  // silently never fires is the defect class this whole gate was built against, so a missing base
  // is announced, not swallowed. CI already checks out with fetch-depth: 0.
  const baseRef = process.env['WIKI_BASE_REF'] ?? 'origin/main';
  const base = pagesAtRef(baseRef);
  let diffChecked = false;
  if (base === null) {
    process.stderr.write(
      `⚠ eaten-section check SKIPPED — base ref '${baseRef}' does not resolve (set WIKI_BASE_REF)\n`,
    );
  } else {
    diffChecked = true;
    const current = new Map(
      readdirSync(WIKI_DIR)
        .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
        .map((f) => [f, readFileSync(join(WIKI_DIR, f), 'utf8')]),
    );
    failures.push(...checkEatenSections(base, current));
  }

  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`✗ ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `✓ wiki clean — index in sync, defect claims in known shapes dated, links live, sections whole${diffChecked ? `, none eaten since ${baseRef}` : ''}\n` +
      `  defect-claim coverage ${cov.covered}/${cov.defects}` +
      ` — ${cov.shapeMisses.length} shape misses (widen DEFECT_RE), ${cov.headingMisses.length} heading misses (never linted)\n`,
  );
}
