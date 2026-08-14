/*
 * Detect ADR 259 measure-4 events: a seat re-deriving a fact the wiki already had.
 *
 * WHY THIS IS A CHECK AND NOT A QUESTION. Measure 4 gates increment 4 (the retrieval index), and
 * until now nothing instrumented it. The obvious instrument — ask a seat at wrap-up "did you
 * re-derive anything that had a page?" — cannot work: a seat that re-derived a fact did so
 * BECAUSE it did not know the page existed, so at wrap-up it has nothing to recall. That is the
 * instrument-silence defect class the whole memory arc is about (ADR 259 finding 4), reproduced
 * inside the measurement of it.
 *
 * So the seat supplies only what it does know — the facts it learned this session, one per line —
 * and the machine does the remembering. A hit means the wiki already covered it: a measure-4
 * event, recorded whether or not the seat noticed.
 *
 *   pnpm wiki:probe "fact one" "fact two"     — facts as arguments
 *   pnpm wiki:probe < facts.txt               — or one per line on stdin
 *
 * Always exits 0. This measures; it does not gate. A seat that learns nothing new is not failing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIKI_DIR } from './wiki-index.ts';

const EXCLUDED = new Set(['README.md', 'INDEX.md']);

/** Words too common in this corpus to carry evidence of a topic match. Deliberately short — the
 *  idf weighting below demotes corpus-common terms on its own; this list only removes the
 *  grammatical filler that would otherwise dominate a short fact's term count. */
const STOPWORDS = new Set(
  `a an and are as at be been but by can cannot did do does for from get got had has have how i if
   in into is it its me my no not of on or our so than that the their them then there they this to
   too up was we were what when where which who why will with without you your`.split(/\s+/),
);

export interface PageMatch {
  page: string;
  /** Share of the fact's evidence-bearing weight that the page contains, 0..1. */
  score: number;
  /** The fact terms this page did NOT contain — what makes a near-miss legible. */
  missing: string[];
}

export type Verdict = 'hit' | 'review' | 'miss';

export interface Probe {
  fact: string;
  verdict: Verdict;
  best: PageMatch | null;
}

/** HIT: the page carries this fact; the seat re-derived it. REVIEW: enough overlap that a human
 *  must look — counted separately and never silently folded into either side, because a measure
 *  that rounds its own ambiguity toward the answer it wants is not a measure. */
export const HIT_AT = 0.6;
export const REVIEW_AT = 0.35;

export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.:/-]+/)
    .map((t) => t.replace(/^[.:/-]+|[.:/-]+$/g, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function loadPages(dir: string): Map<string, string> {
  const pages = new Map<string, string>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md') && !EXCLUDED.has(f)))
    pages.set(name, readFileSync(join(dir, name), 'utf8'));
  return pages;
}

/**
 * Score a fact against every page by idf-weighted term coverage.
 *
 * Coverage, not tf-idf cosine: the question is "does this page contain what the fact is about",
 * which is asymmetric — a 6 KB page covering a one-line fact must score high, and a cosine over
 * length-normalised vectors would bury it. Weighting by idf is what keeps `worktree` (in 3 pages)
 * worth more than `the` (in all of them), so a fact matches the page that is actually about it
 * rather than the longest page in the corpus.
 */
export function probe(fact: string, pages: Map<string, string>): Probe {
  const pageTerms = new Map([...pages].map(([name, body]) => [name, new Set(terms(body))]));
  const factTerms = [...new Set(terms(fact))];
  const n = pages.size;
  const idf = (t: string) => {
    const df = [...pageTerms.values()].filter((s) => s.has(t)).length;
    return Math.log((n + 1) / (df + 1));
  };
  const weights = new Map(factTerms.map((t) => [t, idf(t)]));
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { fact, verdict: 'miss', best: null };

  let best: PageMatch | null = null;
  for (const [name, set] of pageTerms) {
    const present = factTerms.filter((t) => set.has(t));
    const score = present.reduce((a, t) => a + weights.get(t)!, 0) / total;
    if (!best || score > best.score)
      best = { page: name, score, missing: factTerms.filter((t) => !set.has(t)) };
  }
  const score = best?.score ?? 0;
  return {
    fact,
    verdict: score >= HIT_AT ? 'hit' : score >= REVIEW_AT ? 'review' : 'miss',
    best,
  };
}

export function render(probes: Probe[]): string {
  const mark = { hit: 'HIT   ', review: 'REVIEW', miss: 'MISS  ' } as const;
  const lines = probes.map((p) => {
    const where = p.best ? `${p.best.page} ${(p.best.score * 100).toFixed(0)}%` : '—';
    return `${mark[p.verdict]}  ${where}  ${p.fact}`;
  });
  const hits = probes.filter((p) => p.verdict === 'hit').length;
  const review = probes.filter((p) => p.verdict === 'review').length;
  lines.push(
    '',
    `${hits} measure-4 event(s), ${review} to review, ${probes.length - hits - review} genuinely new.`,
    hits + review > 0
      ? 'Report the HITs (and your call on each REVIEW) with `team_send {act:"status_update"}` — the message log is the ledger for measure 4 (ADR 259).'
      : 'Nothing the wiki already knew. Pages for the new facts, per docs/wiki/README.md.',
  );
  return lines.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const facts = (
    args.length > 0
      ? args
      : readFileSync(0, 'utf8')
          .split('\n')
          .map((l) => l.trim())
  ).filter((f) => f !== '');
  if (facts.length === 0) {
    process.stderr.write('wiki:probe: give one fact per argument, or one per line on stdin\n');
    process.exit(0);
  }
  const pages = loadPages(WIKI_DIR);
  process.stdout.write(render(facts.map((f) => probe(f, pages))));
}
