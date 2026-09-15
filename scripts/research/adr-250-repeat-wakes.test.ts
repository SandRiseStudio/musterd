import { describe, expect, it } from 'vitest';
import {
  groupKey,
  groupRows,
  render,
  summarize,
  type Summary,
  type WakeRow,
} from './adr-250-repeat-wakes.js';

/**
 * The instrument for ADR 250's second Eval read — "repeat wakes with an unchanged failure reason".
 *
 * WHAT THIS FILE IS FOR. The instrument's own acceptance criterion is that it CAN COME OUT FALSE:
 * ADR 250 predicts ~zero repeats once backlog item 1 lands, and a counter that cannot return zero
 * would report success for a rail that never improved. Two of the ADR's own acceptance criteria
 * failed exactly that way in 2026-08 (both were satisfied by every wake shape, so neither could
 * discriminate), and the ADR's amendment says so in public. So the first two tests here are the
 * both-directions pair — a clean ledger reads 0, a churning one does not — and everything after
 * guards a way the count could quietly flatter the rail.
 */
const row = (
  ts: number,
  member: string,
  detail: Record<string, unknown>,
  action = 'residency.wake_deferred',
): WakeRow => ({ ts, action, target: member, detail: JSON.stringify(detail) });

const MIN = 60_000;

describe('the criterion can come out false in both directions', () => {
  it('reads zero on a ledger where every wake outcome is distinct', () => {
    const rows: WakeRow[] = [
      row(1 * MIN, 'gptbot', { lane_id: 'A', edge: 'review', reason: 'local-session-live' }),
      row(2 * MIN, 'gptbot', { lane_id: 'B', edge: 'review', reason: 'local-session-live' }),
      row(3 * MIN, 'ryder', { lane_id: 'A', edge: 'review', reason: 'local-session-live' }),
      row(4 * MIN, 'gptbot', { lane_id: 'A', edge: 'dispatch_continuation', reason: 'x' }),
    ];
    const s = summarize(groupRows(rows).groups, 'deferred');
    expect(s.attempts).toBe(4);
    expect(s.repeats).toBe(0);
    expect(s.share).toBe(0);
    expect(s.worst).toEqual([]);
  });

  it('counts attempts-beyond-the-first, not groups, when one edge re-derives the same answer', () => {
    // The shape ADR 250 measured: one lane waking one seat over and over for a reason still true.
    const rows = Array.from({ length: 23 }, (_, i) =>
      row(i * 14 * MIN, 'gptbot', {
        lane_id: '01M018G954',
        edge: 'dispatch_continuation',
        reason: 'local-session-live',
      }),
    );
    const s = summarize(groupRows(rows).groups, 'deferred');
    expect(s.groups).toBe(1);
    expect(s.repeatedGroups).toBe(1);
    // 23 attempts, one of which is the first — the quantity the ADR asks for is 22, not 1 and not 23.
    expect(s.repeats).toBe(22);
    expect(s.worst[0]!.n).toBe(23);
    expect(s.worst[0]!.spanMinutes).toBe(308);
  });
});

describe('groupKey', () => {
  it('separates a deferral from a failure that otherwise matches', () => {
    const d = { lane_id: 'A', edge: 'review', reason: 'lease_expired' };
    expect(groupKey('gptbot', d, 'deferred')).not.toBe(groupKey('gptbot', d, 'failed'));
  });

  it('does not collide when a reason contains the field separator', () => {
    // A space-joined key makes ('a b', 'c') and ('a', 'b c') the same string. Reasons really do
    // contain spaces — "run exited with code 1" is in the live ledger — so this is not hypothetical.
    const a = groupKey('gptbot', { lane_id: 'A', edge: 'review B', reason: 'C' }, 'deferred');
    const b = groupKey('gptbot', { lane_id: 'A', edge: 'review', reason: 'B C' }, 'deferred');
    expect(a).not.toBe(b);
  });

  it('treats an absent lane, edge or reason as its own bucket rather than dropping the row', () => {
    // Inbox wakes carry no lane_id. Discarding them would silently shrink the denominator, which is
    // the flattering direction — the miley/inbox group is one of the largest in the live ledger.
    const { groups } = groupRows([
      row(1 * MIN, 'miley', { reason: 'local-session-live' }),
      row(2 * MIN, 'miley', { reason: 'local-session-live' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!).toMatchObject({ lane: '-', edge: '-', member: 'miley' });
    expect(groups[0]!.ts).toHaveLength(2);
  });
});

describe('the two halves stay separate', () => {
  it('never lets a free deferral raise the spend-bearing count', () => {
    // Same member, lane, edge and reason — deferred twice, failed once. The spend-bearing half must
    // read one attempt and zero repeats; blending them would report a burned lease that never was.
    const d = { lane_id: 'A', edge: 'review', reason: 'lease_expired' };
    const { groups } = groupRows([
      row(1 * MIN, 'gptbot', d),
      row(2 * MIN, 'gptbot', d),
      row(3 * MIN, 'gptbot', d, 'residency.wake_failed'),
    ]);
    const deferred = summarize(groups, 'deferred');
    const failed = summarize(groups, 'failed');
    expect(deferred.repeats).toBe(1);
    expect(failed.attempts).toBe(1);
    expect(failed.repeats).toBe(0);
  });
});

describe('rows the instrument cannot read', () => {
  it('counts unparseable detail instead of dropping it silently', () => {
    const { groups, unparseable } = groupRows([
      row(1 * MIN, 'gptbot', { lane_id: 'A', edge: 'review', reason: 'r' }),
      { ts: 2 * MIN, action: 'residency.wake_deferred', target: 'gptbot', detail: '{not json' },
    ]);
    expect(unparseable).toBe(1);
    expect(groups).toHaveLength(1);
  });

  it('surfaces the excluded count in the rendered read', () => {
    const empty: Summary = {
      attempts: 0,
      groups: 0,
      repeatedGroups: 0,
      repeats: 0,
      share: 0,
      worst: [],
    };
    expect(render('/tmp/x.db', 7, empty, empty, 3)).toContain('3 audit row(s)');
    expect(render('/tmp/x.db', 7, empty, empty, 0)).not.toContain('audit row(s)');
  });
});

describe('an empty window', () => {
  it('reports a zero share rather than NaN', () => {
    // NaN in a weekly read is the kind of thing a reader rounds to "fine".
    const s = summarize([], 'failed');
    expect(s.share).toBe(0);
    expect(Number.isNaN(s.share)).toBe(false);
  });
});
