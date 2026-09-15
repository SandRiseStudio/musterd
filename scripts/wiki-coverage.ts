/*
 * The DEFECT_RE coverage meter (follow-up to the 2026-08-24 widening): a defined recall number for
 * the wiki defect-claim gate, instead of an anecdote.
 *
 * DEFINITION. The corpus is every non-fenced line in docs/wiki (INDEX.md aside) carrying BOTH a
 * date and a `falsify:` marker — the lines whose authors followed README rule 2, i.e. the wiki's
 * self-labeled claim population. Each corpus line is hand-labeled in wiki-claim-labels.json as
 * `defect` (asserts something is broken/absent/unconsumed — the population DEFECT_RE exists to
 * police) or `other` (measured facts, fine-claims, worked examples — rule 3 territory the gate
 * deliberately does not lint). Coverage = the share of `defect` lines the gate would still catch
 * if the author forgot the date: the dated parenthetical is stripped before matching, so credit
 * never comes from defect vocabulary inside the falsifier text itself.
 *
 * Misses split by cause, because a single number conflates two different repairs
 * (docs/wiki/cannot-separate-two-causes.md):
 *   - shape miss:   a body line DEFECT_RE does not match — widen the denylist (with the failing
 *                   example, in wiki.test.ts) to buy this one back;
 *   - heading miss: the claim lives in a heading line, which checkWiki structurally never lints
 *                   (headings return before the DEFECT_RE branch) — no widening reaches it.
 *
 * The meter reports; it does not gate on the number. What DOES gate (via check-wiki main): every
 * corpus line must be labeled and no label may be stale — the denominator stays complete on touch,
 * or the number silently rots the way the denylist did.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATED_RE, DEFECT_RE, HEADING_RE } from './check-wiki.ts';

export interface Claim {
  file: string;
  /** 1-indexed */
  line: number;
  /** the line, trimmed — also the key into wiki-claim-labels.json */
  text: string;
  heading: boolean;
}

export type ClaimLabel = 'defect' | 'other';

export interface Coverage {
  /** labeled defect claims — the denominator */
  defects: number;
  /** defect claims the gate would catch undated */
  covered: number;
  shapeMisses: Claim[];
  headingMisses: Claim[];
  unlabeled: Claim[];
  staleLabels: string[];
}

const FALSIFY_RE = /falsify:/i;

/** Every rule-2-shaped claim line in the wiki: dated AND falsifier-carrying, outside fences. */
export function extractClaims(dir: string): Claim[] {
  const claims: Claim[] = [];
  const pages = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md');
  for (const name of pages) {
    let fenced = false;
    readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*```/.test(line)) {
          fenced = !fenced;
          return;
        }
        if (fenced) return;
        if (!FALSIFY_RE.test(line) || !DATED_RE.test(line)) return;
        claims.push({ file: name, line: i + 1, text: line.trim(), heading: HEADING_RE.test(line) });
      });
  }
  return claims;
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

export function measureCoverage(claims: Claim[], labels: Record<string, ClaimLabel>): Coverage {
  const cov: Coverage = {
    defects: 0,
    covered: 0,
    shapeMisses: [],
    headingMisses: [],
    unlabeled: [],
    staleLabels: [],
  };
  const seen = new Set<string>();
  for (const claim of claims) {
    seen.add(claim.text);
    const label = labels[claim.text];
    if (label === undefined) {
      cov.unlabeled.push(claim);
      continue;
    }
    if (label !== 'defect') continue;
    cov.defects++;
    if (claim.heading) cov.headingMisses.push(claim);
    else if (DEFECT_RE.test(stripDatedParen(claim.text))) cov.covered++;
    else cov.shapeMisses.push(claim);
  }
  cov.staleLabels = Object.keys(labels).filter((k) => !seen.has(k));
  return cov;
}

/** The gating half: an unlabeled corpus line or a stale label is a failure; the number never is. */
export function coverageFailures(dir: string, labels: Record<string, ClaimLabel>): string[] {
  const cov = measureCoverage(extractClaims(dir), labels);
  return [
    ...cov.unlabeled.map(
      (c) =>
        `${c.file}:${c.line} — claim line not in wiki-claim-labels.json — add it as "defect" or "other": "${c.text.slice(0, 80)}"`,
    ),
    ...cov.staleLabels.map(
      (k) =>
        `wiki-claim-labels.json — stale label (no such claim line any more): "${k.slice(0, 80)}"`,
    ),
  ];
}
