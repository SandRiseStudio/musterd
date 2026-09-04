import { describe, expect, it } from 'vitest';
import {
  bucketByWeek,
  isoWeek,
  ratio,
  render,
  summarize,
  type Summary,
} from './adr-250-asks-per-pr.js';

/**
 * The instrument for ADR 250's headline Eval read — "asks-to-founder per merged PR".
 *
 * WHAT THIS FILE IS FOR. The instrument's own acceptance criterion is that it CAN COME OUT FALSE:
 * ADR 250 predicts the ratio falls as the merge loop and acceptance absorption land, and a counter
 * that cannot return a low number would report success for loops that never absorbed anything. So
 * the first tests are the both-directions pair — a window with no asks reads 0, a window of asks
 * over PRs reads the right ratio — and the rest guard the ways the number could quietly flatter
 * the loops.
 */
const DAY = 86_400_000;
// A fixed reference inside one ISO week so tests do not drift with the calendar:
// 2026-08-05 is a Wednesday of 2026-W32.
const WED = Date.UTC(2026, 7, 5, 12);

describe('the criterion can come out false in both directions', () => {
  it('reads zero on a window with PRs but no asks to humans', () => {
    const s = summarize([], [{ ts: WED }, { ts: WED + DAY }], new Map(), 7);
    expect(s.asks).toBe(0);
    expect(s.prs).toBe(2);
    expect(s.ratio).toBe(0);
  });

  it('reads the ratio when asks and PRs share a window', () => {
    // The ADR's 2026-08-05 shape, scaled down: 6 asks over 3 merged PRs is 2.0, not 6 and not 3.
    const asks = Array.from({ length: 6 }, (_, i) => ({
      ts: WED + i * 60_000,
      to_member: 'H1',
    }));
    const prs = [{ ts: WED }, { ts: WED + DAY }, { ts: WED + 2 * DAY }];
    const s = summarize(asks, prs, new Map([['H1', 'nick']]), 7);
    expect(s.ratio).toBe(2);
    expect(s.byRecipient).toEqual([{ name: 'nick', asks: 6 }]);
  });
});

describe('the denominator', () => {
  it('reports null — not NaN, not 0 — when no PR merged in the window', () => {
    // A week with asks and no merged PR is unbounded judgment per PR; printing 0 would flatter the
    // loops and NaN is the thing a reader rounds to "fine".
    const s = summarize([{ ts: WED, to_member: 'H1' }], [], new Map(), 7);
    expect(s.ratio).toBeNull();
    expect(render('/tmp/x.db', s)).toContain('no merged PRs');
  });

  it('prints a dash for a zero-PR week in the series', () => {
    const weeks = bucketByWeek([{ ts: WED, to_member: 'H1' }], []);
    expect(weeks).toHaveLength(1);
    expect(ratio(weeks[0]!)).toBeNull();
  });
});

describe('isoWeek', () => {
  it('labels the ADR baseline week as 2026-W32', () => {
    expect(isoWeek(WED)).toBe('2026-W32');
  });

  it('assigns a Sunday to the week its Thursday belongs to', () => {
    // 2026-08-09 is the Sunday of the week whose Thursday is 2026-08-06 — still W32.
    expect(isoWeek(Date.UTC(2026, 7, 9, 23))).toBe('2026-W32');
    // Monday 2026-08-10 opens W33.
    expect(isoWeek(Date.UTC(2026, 7, 10, 0, 1))).toBe('2026-W33');
  });
});

describe('bucketByWeek', () => {
  it('keeps weeks separate so a quiet week cannot hide inside a busy one', () => {
    const asks = [
      { ts: WED, to_member: 'H1' },
      { ts: WED + 7 * DAY, to_member: 'H1' },
      { ts: WED + 7 * DAY + 60_000, to_member: 'H1' },
    ];
    const prs = [{ ts: WED }, { ts: WED + 7 * DAY }];
    const weeks = bucketByWeek(asks, prs);
    expect(weeks.map((w) => [w.week, w.asks, w.prs])).toEqual([
      ['2026-W32', 1, 1],
      ['2026-W33', 2, 1],
    ]);
  });
});

describe('the recipient breakdown', () => {
  it('names recipients from the members map and never invents a founder', () => {
    // The roster carries several human rows; the founder is a measured row, not a hardcoded name.
    const asks = [
      { ts: WED, to_member: 'H1' },
      { ts: WED, to_member: 'H1' },
      { ts: WED, to_member: 'H2' },
      { ts: WED, to_member: 'GONE' },
    ];
    const s = summarize(asks, [], new Map([['H1', 'nick'], ['H2', 'driver']]), 7);
    expect(s.byRecipient).toEqual([
      { name: 'nick', asks: 2 },
      { name: 'driver', asks: 1 },
      { name: '(unknown)', asks: 1 },
    ]);
  });
});

describe('an empty window', () => {
  it('renders without NaN', () => {
    const s: Summary = summarize([], [], new Map(), 7);
    const text = render('/tmp/x.db', s);
    expect(text).not.toContain('NaN');
    expect(s.ratio).toBeNull();
  });
});
