/*
 * The DEFECT_RE coverage meter (follow-up to the 2026-08-24 widening): a defined recall number for
 * the wiki defect-claim gate, instead of an anecdote.
 *
 * DEFINITION. The corpus is every non-fenced line in docs/wiki (INDEX.md aside) carrying BOTH a
 * date and a `falsify:` marker — the lines whose authors followed README rule 2, i.e. the wiki's
 * self-labeled claim population. Each corpus line carries its own label in a trailing
 * `<!-- claim: defect -->` / `<!-- claim: other -->` comment, invisible in rendered markdown:
 * `defect` (asserts something is broken/absent/unconsumed — the population DEFECT_RE exists to
 * police) or `other` (measured facts, fine-claims, worked examples — rule 3 territory the gate
 * deliberately does not lint). Coverage = the share of `defect` lines the gate would still catch
 * if the author forgot the date: the dated parenthetical is stripped before matching, so credit
 * never comes from defect vocabulary inside the falsifier text itself.
 *
 * WHY THE LABEL LIVES ON THE LINE (lane 01M2H121AA, 2026-09-15). It used to live in
 * `scripts/wiki-claim-labels.json`, one flat map keyed by the whole prose line. That file was the
 * busiest merge conflict in the repo — 8 conflicts across 4 seats in one afternoon, and on #1417 a
 * conflict left the PR CONFLICTING, so the `pull_request` webhook never fired and the PR sat with
 * NO CI looking merely slow rather than blocked. Every wiki-touching PR appended to the same tail
 * of the same file, and the keys were 300-char sentences, so a textual three-way merge had nothing
 * to align on. On the line, two seats editing different pages cannot collide at all, and the label
 * travels with the claim: re-wording a claim used to orphan its label AND demand a new one, which
 * reported one edit as two failures. The marker is stripped before DEFECT_RE or stripDatedParen
 * ever see the text, so a labeled line scores exactly as the same line unlabeled.
 *
 * Misses split by cause, because a single number conflates two different repairs
 * (docs/wiki/cannot-separate-two-causes.md):
 *   - shape miss:   a body line DEFECT_RE does not match — widen the denylist (with the failing
 *                   example, in wiki.test.ts) to buy this one back;
 *   - heading miss: the claim lives in a heading line, which checkWiki structurally never lints
 *                   (headings return before the DEFECT_RE branch) — no widening reaches it.
 *
 * The meter reports; it does not gate on the number. What DOES gate (via check-wiki main): every
 * corpus line must carry a marker, no marker may sit on a line that is not a corpus line, and no
 * marker may name a label outside the two — the denominator stays complete on touch, or the number
 * silently rots the way the denylist did.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATED_RE, DEFECT_RE, HEADING_RE } from './check-wiki.ts';
import { type ClaimLabel, markerLabel, stripMarker } from './wiki-claim-marker.ts';

export interface Claim {
  file: string;
  /** 1-indexed */
  line: number;
  /** the line, trimmed, with the `<!-- claim: … -->` marker removed */
  text: string;
  heading: boolean;
  /** the label off this line's marker; null when the line carries none (or an unknown one) */
  label: ClaimLabel | null;
}

export type { ClaimLabel };

export interface Coverage {
  /** labeled defect claims — the denominator */
  defects: number;
  /** defect claims the gate would catch undated */
  covered: number;
  shapeMisses: Claim[];
  headingMisses: Claim[];
  unlabeled: Claim[];
}

const FALSIFY_RE = /falsify:/i;

/** A marker that is not doing the one job markers have — junk that nothing else would ever look
 *  at, the way an orphaned JSON key was. Reported per file:line so it can suppress the
 *  "unlabeled" failure for the same line. */
export interface MarkerProblem {
  file: string;
  /** 1-indexed */
  line: number;
  detail: string;
}

/** One pass over the wiki: the rule-2-shaped claim lines (dated AND falsifier-carrying, outside
 *  fences) with their labels, plus every misplaced or unreadable marker found on the way. */
export function scanClaims(dir: string): { claims: Claim[]; markerProblems: MarkerProblem[] } {
  const claims: Claim[] = [];
  const markerProblems: MarkerProblem[] = [];
  const pages = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md');
  for (const name of pages) {
    let fenced = false;
    readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .forEach((raw, i) => {
        if (/^\s*```/.test(raw)) {
          fenced = !fenced;
          return;
        }
        if (fenced) return;
        const line = i + 1;
        const rawLabel = markerLabel(raw);
        const text = stripMarker(raw.trimEnd()).trim();
        const isClaim = FALSIFY_RE.test(text) && DATED_RE.test(text);
        if (rawLabel !== null && !isClaim) {
          markerProblems.push({
            file: name,
            line,
            detail: 'marker on a line that is not a claim line',
          });
          return;
        }
        if (!isClaim) return;
        if (rawLabel !== null && rawLabel !== 'defect' && rawLabel !== 'other') {
          markerProblems.push({ file: name, line, detail: `unknown claim label "${rawLabel}"` });
        }
        claims.push({
          file: name,
          line,
          text,
          heading: HEADING_RE.test(text),
          label: rawLabel === 'defect' || rawLabel === 'other' ? rawLabel : null,
        });
      });
  }
  return { claims, markerProblems };
}

/** Every rule-2-shaped claim line in the wiki: dated AND falsifier-carrying, outside fences. */
export function extractClaims(dir: string): Claim[] {
  return scanClaims(dir).claims;
}

/** The claim as its author would have written it forgetting rule 2: every dated parenthetical
 *  removed, balanced (falsifiers quote code with parens) or truncated to end of line when the
 *  group never closes. */
export function stripDatedParen(text: string): string {
  let out = text;
  for (;;) {
    const open = out.search(/\(20\d\d-\d\d/);
    if (open === -1) return out;
    let depth = 0;
    let close = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')' && --depth === 0) {
        close = i;
        break;
      }
    }
    out = close === -1 ? out.slice(0, open) : out.slice(0, open) + out.slice(close + 1);
  }
}

export function measureCoverage(claims: Claim[]): Coverage {
  const cov: Coverage = {
    defects: 0,
    covered: 0,
    shapeMisses: [],
    headingMisses: [],
    unlabeled: [],
  };
  for (const claim of claims) {
    if (claim.label === null) {
      cov.unlabeled.push(claim);
      continue;
    }
    if (claim.label !== 'defect') continue;
    cov.defects++;
    if (claim.heading) cov.headingMisses.push(claim);
    else if (DEFECT_RE.test(stripDatedParen(claim.text))) cov.covered++;
    else cov.shapeMisses.push(claim);
  }
  return cov;
}

/** The gating half: an unmarked corpus line, or a marker that is misplaced or unreadable, is a
 *  failure; the number never is. A line with a bad marker is reported once, as the bad marker —
 *  telling an author their label is unreadable AND that they forgot one is two repairs for one
 *  edit, which is the failure mode the JSON map had. */
export function coverageFailures(dir: string): string[] {
  const { claims, markerProblems } = scanClaims(dir);
  const problemAt = new Set(markerProblems.map((p) => `${p.file}:${p.line}`));
  const cov = measureCoverage(claims);
  return [
    ...markerProblems.map((p) => `${p.file}:${p.line} — ${p.detail}`),
    ...cov.unlabeled
      .filter((c) => !problemAt.has(`${c.file}:${c.line}`))
      .map(
        (c) =>
          `${c.file}:${c.line} — claim line carries no label — end the line with <!-- claim: defect --> or <!-- claim: other -->: "${c.text.slice(0, 80)}"`,
      ),
  ];
}
