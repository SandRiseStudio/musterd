/**
 * The window guard is the only part of this instrument with an opinion, so it is the part that
 * needs a falsifier. The 2026-08-14 run reported a 23% -> 6% move that turned out to be unreadable
 * because routing changed inside the window; these tests exist so the NEXT run cannot do that
 * quietly. A guard that never fires is decoration — every case below asserts a refusal as well as
 * a pass.
 */
import { describe, expect, it } from 'vitest';
import { routingCommitsSince, windowGuard } from './adr-260-acceptance-eval.ts';

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
    expect(v.reasons[0]).toContain('population');
  });

  it('refuses when the routing code changed inside', () => {
    const v = windowGuard([], [commit(inside)], LO, HI);
    expect(v.clean).toBe(false);
    expect(v.reasons[0]).toContain('abcdef12');
    expect(v.reasons[0]).toContain('quiet counterpart');
  });

  it('names every disqualifying event, not just the first — a window can be dirty twice', () => {
    const v = windowGuard([inside, inside + 1000], [commit(inside)], LO, HI);
    expect(v.clean).toBe(false);
    expect(v.reasons).toHaveLength(2); // one pooled policy line + one per commit
    expect(v.reasons[0]).toContain('2 policy.change');
  });

  it('ignores events outside the window on both edges', () => {
    expect(windowGuard([before, after], [commit(before), commit(after)], LO, HI).clean).toBe(true);
  });

  it('treats the window as half-open: lo counts, hi does not', () => {
    expect(windowGuard([LO], [], LO, HI).clean).toBe(false);
    expect(windowGuard([HI], [], LO, HI).clean).toBe(true);
  });
});

describe('routingCommitsSince', () => {
  it('asks git for the three files that decide who is asked, as an argument array', () => {
    let seen: string[] = [];
    routingCommitsSince(LO, HI, (args) => {
      seen = args;
      return '';
    });
    expect(seen[0]).toBe('log');
    expect(seen).toContain('packages/server/src/store/review.ts');
    expect(seen).toContain('packages/server/src/store/orientation.ts');
    expect(seen).toContain('packages/protocol/src/envelope.ts');
    // No shell string anywhere — every element is a discrete argv entry.
    expect(seen.some((a) => a.includes(' -- '))).toBe(false);
  });

  it('parses tab-separated git output into commits with ms timestamps', () => {
    const out = 'sha1\t1786000000\tfix the picker\nsha2\t1786100000\ttidy\n';
    const commits = routingCommitsSince(LO, HI, () => out);
    expect(commits).toEqual([
      { sha: 'sha1', ts: 1786000000000, subject: 'fix the picker' },
      { sha: 'sha2', ts: 1786100000000, subject: 'tidy' },
    ]);
  });

  it('keeps tabs inside a subject rather than truncating it', () => {
    const commits = routingCommitsSince(LO, HI, () => 'sha1\t1786000000\ta\tb\n');
    expect(commits[0]?.subject).toBe('a\tb');
  });

  it('returns nothing for empty git output rather than a phantom commit', () => {
    expect(routingCommitsSince(LO, HI, () => '')).toEqual([]);
  });
});
