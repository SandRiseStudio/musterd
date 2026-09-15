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
import { HIT_AT, loadPages, loadPagesAt, probe, REVIEW_AT, render, terms } from './wiki-probe.ts';

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

/*
 * The session-start boundary. The operational definition says "already carried AT THE TIME THE SEAT
 * STARTED": a page a teammate committed mid-session was never available to be found, so scoring
 * against the current tree can only push measure 4 up — toward "build a retrieval index" — off
 * evidence the seat could not have used. gptbot declined the first cut of this probe for exactly
 * that, and these are its tests.
 *
 * The ref used here is real history: 2b968ead is #783, the commit that created docs/wiki/ with four
 * pages. shipping-a-pr.md arrived a day later in #787, which makes "a page that did not exist yet"
 * a fixture git already holds rather than one this test has to fake.
 */
const WIKI_BIRTH = '2b968ead';

describe('the session-start corpus', () => {
  it('reads the pages that existed at a ref, not the ones on disk now', () => {
    const then = loadPagesAt(WIKI_BIRTH);
    expect([...then!.keys()].sort()).toEqual([
      'context-budgets.md',
      'temp-daemon-probe.md',
      'vitest-package-configs.md',
      'wake-leases.md',
    ]);
    expect(then!.size).toBeLessThan(live.size);
  });

  it('cannot credit a fact to a page that did not exist when the seat started', () => {
    // The same fact the live-corpus test above scores as a HIT on shipping-a-pr.md.
    const fact = 'bugbot sometimes fails to register its check-run';
    expect(probe(fact, live).best?.page).toBe('shipping-a-pr.md');

    const bounded = probe(fact, loadPagesAt(WIKI_BIRTH)!);
    expect(bounded.best?.page).not.toBe('shipping-a-pr.md');
    expect(bounded.verdict).not.toBe('hit');
  });

  it('reads each page AS OF the ref, so a section added mid-session cannot be matched', () => {
    // wake-leases.md gained 19 lines after #783. Existence alone is not enough: a section appended
    // to a page a seat already had is just as unavailable to it as a whole new page.
    const then = loadPagesAt(WIKI_BIRTH)!.get('wake-leases.md')!;
    expect(then).not.toBe(live.get('wake-leases.md'));
    expect(then.length).toBeLessThan(live.get('wake-leases.md')!.length);
  });

  it('says so when the ref predates the wiki, rather than reporting a confident zero', () => {
    // A resolvable ref can still carry no pages — mistype --since and you land before #783. Every
    // fact then scores MISS off an empty corpus, which reads as "the wiki knew nothing" when it
    // means "there was no wiki". Same silent zero, one layer further in.
    const before = loadPagesAt('2b968ead~1');
    expect(before?.size).toBe(0);
    expect(
      render([probe('anything at all', before!)], { ref: '2b968ead~1', pages: before!.size }),
    ).toContain('no pages');
  });

  it('refuses an unresolvable ref instead of returning an empty corpus', () => {
    // An empty corpus would score every fact MISS — a silent zero on the measure whose whole
    // purpose is to not be silently zero. Null makes the caller say so out loud.
    expect(loadPagesAt('no-such-ref-deadbeef')).toBeNull();
  });
});

describe('render', () => {
  it('marks an unbounded run as an upper bound, and a bounded one as measured', () => {
    const p = [probe('bugbot sometimes fails to register its check-run', live)];
    expect(render(p)).toContain('UPPER BOUND');
    expect(render(p, { ref: WIKI_BIRTH })).not.toContain('UPPER BOUND');
    expect(render(p, { ref: WIKI_BIRTH })).toContain(WIKI_BIRTH);
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
