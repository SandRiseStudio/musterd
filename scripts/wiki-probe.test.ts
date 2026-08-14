/*
 * Calibration, not just correctness. A detector whose sensitivity nobody measured would let a
 * silent measure 4 read as "grep suffices" — the exact failure ADR 259 exists to prevent — so the
 * numbers quoted in docs/design/2026-08-13-measure-4-retrieval-sufficiency.md are asserted here.
 *
 * The behavioural tests run against the LIVE corpus rather than a fixture, deliberately. idf is a
 * property of a corpus, not of a page: on a two-page fixture every weight collapses toward zero or
 * noise and a scorer that works on the real 26 pages scores 'review' on the toy one. A fixture
 * small enough to read is too small to be tested against.
 */
import { describe, expect, it } from 'vitest';
import { WIKI_DIR } from './wiki-index.ts';
import { HIT_AT, loadPages, probe, REVIEW_AT, terms } from './wiki-probe.ts';

const live = loadPages(WIKI_DIR);

describe('terms', () => {
  it('drops filler and keeps the evidence-bearing words, dotted names included', () => {
    expect(terms('the PR is in origin/main and format:check')).toEqual([
      'origin/main',
      'format:check',
    ]);
  });

  it('yields nothing for a phrase made entirely of filler', () => {
    expect(terms('and the it is')).toEqual([]);
  });
});

describe('probe', () => {
  it('finds the page a paraphrased fact belongs to', () => {
    // Nothing in this sentence is a verbatim substring of the page; the terms are shared.
    const r = probe('bugbot sometimes fails to register its check-run', live);
    expect(r.verdict).toBe('hit');
    expect(r.best?.page).toBe('shipping-a-pr.md');
  });

  it('calls an unrelated fact a miss rather than forcing it onto the nearest page', () => {
    expect(probe('kubernetes pod autoscaling needs a custom metrics adapter', live).verdict).toBe(
      'miss',
    );
  });

  it('never scores a topical-but-absent fact as a hit', () => {
    // The known limit: a fact sharing a page's subject without being on it scores mid-band. That
    // it lands short of HIT_AT is the load-bearing property — a review is a human's call, whereas
    // a false hit inflates measure 4 and argues for building an index nobody needs.
    const r = probe('the espresso machine on the third floor takes 40 seconds to warm up', live);
    expect(r.verdict).not.toBe('hit');
  });

  it('survives a fact made entirely of filler without dividing by zero', () => {
    expect(probe('and the it is', live)).toMatchObject({ verdict: 'miss', best: null });
  });

  it('orders its bands', () => {
    expect(REVIEW_AT).toBeLessThan(HIT_AT);
  });
});

describe('calibration against the live corpus', () => {
  /* Sensitivity floor: every page's own summary line must resolve to that page. Trivial by
   * construction (the summary is a substring), which is the point — a regression here means the
   * scorer broke, not that the corpus changed. The paraphrase numbers that actually matter are
   * hand-measured and recorded in the design doc; they cannot be asserted from the corpus itself. */
  it('resolves every page summary to its own page', () => {
    const wrong = [...live]
      .map(([name, body]) => ({ name, r: probe(body.split('\n')[2] ?? '', live) }))
      .filter(({ name, r }) => r.best?.page !== name || r.verdict !== 'hit');
    expect(wrong.map((w) => w.name)).toEqual([]);
  });
});
