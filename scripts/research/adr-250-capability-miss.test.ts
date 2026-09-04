import { describe, expect, it } from 'vitest';
import {
  GRACE_MS,
  inertLandings,
  render,
  summarize,
  type LeaseRow,
  type Summary,
} from './adr-250-capability-miss.js';

/**
 * The instrument for ADR 250's third Eval read — "capability-miss count".
 *
 * WHAT THIS FILE IS FOR. The instrument's own acceptance criterion is that it CAN COME OUT FALSE:
 * ADR 250 predicts ~zero once backlog item 3 (capability fitness in routing) lands, and a counter
 * that cannot return zero would report success for routing that never improved. So the first tests
 * are the both-directions pair — a landing whose lane moves reads 0, a landing whose lane never
 * moves reads 1 — and the rest guard the ways the count could flatter or invent.
 */
const HOUR = 3_600_000;
const lease = (
  id: string,
  createdAt: number,
  overrides: Partial<LeaseRow> = {},
): LeaseRow => ({
  id,
  member_id: 'M1',
  lane_id: 'L1',
  edge: 'review',
  status: 'reported',
  created_at: createdAt,
  ...overrides,
});
const names = new Map([['M1', 'gptbot']]);

describe('the criterion can come out false in both directions', () => {
  it('reads zero when the landed wake moves its lane inside the grace window', () => {
    const r = inertLandings([lease('A', 1_000)], new Map([['L1', [1_000 + HOUR]]]), names);
    expect(r.landings).toBe(1);
    expect(r.inert).toBe(0);
    expect(summarize(r).share).toBe(0);
  });

  it('counts a landing whose lane never moves', () => {
    // The ADR's named instance: the wake landed, the lane never moved.
    const r = inertLandings([lease('A', 1_000)], new Map(), names);
    expect(r.landings).toBe(1);
    expect(r.inert).toBe(1);
  });
});

describe('what counts as a landing', () => {
  it('ignores leases that never landed', () => {
    // An expired lease is instrument 2's spend-bearing half, not a capability miss — no session
    // ever had the chance to act, so blaming its capability would invent a finding.
    const r = inertLandings([lease('A', 1_000, { status: 'expired' })], new Map(), names);
    expect(r.landings).toBe(0);
    expect(r.inert).toBe(0);
  });

  it('ignores leases that name no lane', () => {
    // An inbox wake carries no lane_id; there is no lane to move, so "inert" has no meaning.
    const r = inertLandings([lease('A', 1_000, { lane_id: null })], new Map(), names);
    expect(r.landings).toBe(0);
  });
});

describe('the grace window', () => {
  it('clears a landing whose lane moves just inside the window, not one just past it', () => {
    const inside = inertLandings(
      [lease('A', 1_000)],
      new Map([['L1', [1_000 + GRACE_MS - 1]]]),
      names,
    );
    const outside = inertLandings(
      [lease('A', 1_000)],
      new Map([['L1', [1_000 + GRACE_MS]]]),
      names,
    );
    expect(inside.inert).toBe(0);
    expect(outside.inert).toBe(1);
  });

  it('does not let a lane event BEFORE the wake clear it', () => {
    // The lane moved an hour before the wake landed; that says nothing about this landing.
    const r = inertLandings([lease('A', 10_000_000)], new Map([['L1', [5_000_000]]]), names);
    expect(r.inert).toBe(1);
  });
});

describe('repeats', () => {
  it('counts attempts-beyond-the-first when the same seat lands inert on the same lane', () => {
    // The ADR's instance, verbatim shape: six wakes, one lane, nothing moved — 5 repeats, not 6.
    const leases = Array.from({ length: 6 }, (_, i) => lease(`L${i}`, 1_000 + i * 30 * 60_000));
    const s = summarize(inertLandings(leases, new Map(), names));
    expect(s.inert).toBe(6);
    expect(s.repeatedGroups).toBe(1);
    expect(s.repeats).toBe(5);
    expect(s.worst[0]).toMatchObject({ n: 6, member: 'gptbot', lane: 'L1', edge: 'review' });
  });

  it('keeps different edges on one lane as different groups', () => {
    // A review wake and a dispatch wake landing inert on the same lane are two findings, not one.
    const leases = [
      lease('A', 1_000, { edge: 'review' }),
      lease('B', 2_000, { edge: 'dispatch_continuation' }),
    ];
    const s = summarize(inertLandings(leases, new Map(), names));
    expect(s.inert).toBe(2);
    expect(s.repeats).toBe(0);
  });

  it('lets a lane moved by ANY seat clear the landing — the conservative direction', () => {
    // The audit read is lane-scoped, not actor-scoped: a teammate moving the lane clears it, so
    // the count understates true capability misses rather than inventing them.
    const r = inertLandings([lease('A', 1_000)], new Map([['L1', [1_500]]]), names);
    expect(r.inert).toBe(0);
  });
});

describe('an empty window', () => {
  it('reports a zero share rather than NaN', () => {
    const s: Summary = summarize({ groups: [], landings: 0, inert: 0 });
    expect(s.share).toBe(0);
    expect(render('/tmp/x.db', 7, s)).not.toContain('NaN');
  });
});
