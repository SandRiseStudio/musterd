/**
 * The window guard is the only part of this instrument with an opinion, so it is the part that
 * needs a falsifier. The 2026-08-14 run reported a 23% -> 6% move that turned out to be unreadable
 * because routing changed inside the window; these tests exist so the NEXT run cannot do that
 * quietly. A guard that never fires is decoration — every case below asserts a refusal as well as
 * a pass.
 *
 * The concentration tests guard a different failure: the boundary detector's FIRST draft keyed on
 * the ready row's `review_grade`, which is a property of the PAIR, and duly reported three
 * same-family seats as "cross-family acceptors". Keying on seat family is the fix, and the test
 * that would have caught it is here.
 */
import { describe, expect, it } from 'vitest';
import {
  CONCENTRATION_PREDICTION,
  concentration,
  evaluate,
  familyOf,
  judgeConcentration,
  majorityFamily,
  routingCommitsSince,
  windowGuard,
  WINDOW_PATHS,
} from './adr-260-acceptance-eval.ts';

const LO = Date.parse('2026-08-14T00:00:00Z');
const HI = Date.parse('2026-08-21T00:00:00Z');
const inside = Date.parse('2026-08-17T12:00:00Z');
const before = Date.parse('2026-08-13T12:00:00Z');
const after = Date.parse('2026-08-22T12:00:00Z');
const commit = (ts: number) => ({ sha: 'abcdef1234', ts, subject: 'pick the quiet counterpart' });

describe('windowGuard', () => {
  it('passes a window with nothing in it', () => {
    expect(windowGuard([], [], LO, HI)).toEqual({ clean: true, reasons: [] });
  });

  it('refuses when a policy.change landed inside — arming changes the population', () => {
    const v = windowGuard([inside], [], LO, HI);
    expect(v.clean).toBe(false);
    expect(v.reasons[0]).toContain('policy.change');
  });

  it('refuses when watched code changed inside', () => {
    const v = windowGuard([], [commit(inside)], LO, HI);
    expect(v.clean).toBe(false);
    expect(v.reasons[0]).toContain('abcdef12');
  });

  it('ignores events outside the window on both edges', () => {
    expect(windowGuard([before, after], [commit(before), commit(after)], LO, HI).clean).toBe(true);
  });
});

describe('WINDOW_PATHS', () => {
  it('watches the wake path, not only who-is-asked (the #844 miss)', () => {
    // Item 5 depends on act/lease volume, so a change there invalidates the comparison even
    // though it touches no routing file. This is the assertion that would have caught it.
    expect(WINDOW_PATHS).toContain('packages/protocol/src/residency.ts');
    expect(WINDOW_PATHS).toContain('packages/server/src/store/residency.ts');
    expect(WINDOW_PATHS).toContain('packages/server/src/store/review.ts');
  });

  it('is what routingCommitsSince actually asks git about', () => {
    let seen: string[] = [];
    routingCommitsSince(LO, HI, (args) => {
      seen = args;
      return '';
    });
    for (const p of WINDOW_PATHS) expect(seen).toContain(p);
  });
});

describe('familyOf / majorityFamily', () => {
  it('maps the model ids this team actually attests', () => {
    expect(familyOf('claude-opus-5')).toBe('claude');
    expect(familyOf('grok-4.6')).toBe('grok');
    expect(familyOf('gpt-5.6')).toBe('openai');
    expect(familyOf('codex-mini')).toBe('openai');
    expect(familyOf(undefined)).toBe('unknown');
  });

  it('picks the majority family and ignores unknowns', () => {
    const m = new Map([
      ['a', 'claude'],
      ['b', 'claude'],
      ['c', 'grok'],
      ['d', 'unknown'],
    ]);
    expect(majorityFamily(m)).toBe('claude');
  });
});

describe('concentration', () => {
  const fam = new Map([
    ['dolly', 'claude'],
    ['stanley', 'claude'],
    ['miley', 'claude'],
    ['wanderer', 'grok'],
    ['gptbot', 'openai'],
  ]);
  const row = (ts: number, reviewer: string, grade = 'cross_family') => ({
    ts,
    d: { lane: `l${ts}`, owner: 'izzo', reviewer, review_grade: grade },
  });

  it('does NOT treat a same-family seat as the intervention, however the pair was graded', () => {
    // The original bug: these rows are all graded cross_family, but stanley and miley are claude.
    const rows = [row(1000, 'stanley'), row(2000, 'miley'), row(3000, 'dolly')];
    expect(concentration(rows as never, fam).boundary).toBeNull();
  });

  it('does not fire on the FIRST minority-family acceptor — one seat is the status quo', () => {
    const rows = [row(1000, 'wanderer'), row(2000, 'wanderer'), row(3000, 'stanley')];
    expect(concentration(rows as never, fam).boundary).toBeNull();
  });

  it('fires on the first ask to a SECOND, differently-familied seat', () => {
    const rows = [row(1000, 'wanderer'), row(2000, 'stanley'), row(3000, 'gptbot')];
    const c = concentration(rows as never, fam);
    expect(c.boundary).toBe(3000);
    expect(c.boundarySeat).toBe('gptbot');
  });

  // A hand-routed acceptance (ADR 260 amendment 2026-09-01, dolly's #1152) is not a pick. The
  // prediction is about what the LADDER does with the asks; a human naming an acceptor is the
  // experimenter reaching into the population, and counting it would let a person move the
  // instrument's primary number by hand.
  const named = (ts: number, reviewer: string) => ({
    ts,
    d: {
      lane: `l${ts}`,
      owner: 'izzo',
      reviewer,
      route: 'named',
      review_grade: 'same_model',
    },
  });

  it('does not let a NAMED route open the boundary — the picker never chose that seat', () => {
    const rows = [row(1000, 'wanderer'), row(2000, 'stanley'), named(3000, 'gptbot')];
    expect(concentration(rows as never, fam).boundary).toBeNull();
  });

  it('keeps a named row out of the after-boundary population entirely', () => {
    const rows = [
      row(1000, 'wanderer'),
      row(2000, 'stanley'),
      row(3000, 'gptbot'),
      named(4000, 'gptbot'),
      named(5000, 'gptbot'),
    ];
    const after = concentration(rows as never, fam).periods.find((p) => p.label === 'AFTER')!;
    // Only the picked row at 3000 survives; the two hand-routed ones would otherwise have tripled
    // gptbot's count and driven topShare to 100% without the picker doing anything.
    expect(after.n).toBe(1);
  });
});

describe('evaluate — the named route stays out of the denominator', () => {
  const picked = (ts: number, reviewer: string, grade: string) => ({
    ts,
    d: { lane: `l${ts}`, owner: 'izzo', reviewer, review_grade: grade },
  });
  const named = (ts: number, reviewer: string) => ({
    ts,
    d: { lane: `l${ts}`, owner: 'izzo', reviewer, route: 'named', review_grade: 'same_model' },
  });

  it('does not dilute crossFamilyShare with hand-routed abstentions', () => {
    // Two picked submits, both cross_family: the picker went two for two.
    const picks = [
      picked(1000, 'wanderer', 'cross_family'),
      picked(2000, 'gptbot', 'cross_family'),
    ];
    expect(evaluate('picked only', picks as never).crossFamilyShare).toBe(1);
    // Adding two hand-routed same_model rows must not restate that as 50%.
    const withNamed = [...picks, named(3000, 'stanley'), named(4000, 'stanley')];
    const r = evaluate('with named', withNamed as never);
    expect(r.liveRouted).toBe(2);
    expect(r.crossFamilyShare).toBe(1);
  });

  it('does not let a hand-routed acceptor become the top reviewer', () => {
    const rows = [
      picked(1000, 'wanderer', 'cross_family'),
      named(2000, 'stanley'),
      named(3000, 'stanley'),
      named(4000, 'stanley'),
    ];
    expect(evaluate('named flood', rows as never).topReviewer).toEqual(['wanderer', 1]);
  });
});

describe('judgeConcentration — the pre-registered prediction', () => {
  const period = (n: number, topShare: number) => ({
    label: 'AFTER',
    n,
    topReviewer: 'wanderer',
    topShare,
    crossFamilyShare: topShare,
    crossFamilySeats: ['wanderer'],
  });

  it('is INCONCLUSIVE below the pre-registered n, however good the number looks', () => {
    expect(judgeConcentration(period(CONCENTRATION_PREDICTION.minN - 1, 0.1))).toBe('INCONCLUSIVE');
  });

  it('PASSES at or below 40% — the ladder split the asks', () => {
    expect(judgeConcentration(period(30, 0.4))).toBe('PASS');
    expect(judgeConcentration(period(30, 0.25))).toBe('PASS');
  });

  it('FAILS at or above 50% — a second seat did not disperse them, so the sort is not the cause', () => {
    expect(judgeConcentration(period(30, 0.5))).toBe('FAIL');
    expect(judgeConcentration(period(30, 0.57))).toBe('FAIL');
  });

  it('leaves the 40-50% band INCONCLUSIVE rather than rounding it to whichever I hoped for', () => {
    expect(judgeConcentration(period(30, 0.45))).toBe('INCONCLUSIVE');
  });
});
