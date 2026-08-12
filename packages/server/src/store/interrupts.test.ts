import { PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { pendingInterrupts } from './messages.js';

/**
 * The pure interrupt-class predicate behind `inbox --interrupt-check` (ADR 088). Interrupt-class =
 * directed-at-me-or-request_help + not-resolved + (urgent OR a `steer`) — ADR 103 makes a `steer`
 * interrupt-class by definition (it raises the line without the urgent flag), while `challenge`/`defer`
 * stay behind the urgent gate. The newest steer supersedes prior steers so a late agent sees one
 * direction. Newest first. Tested in isolation because the whole "scarce by construction" property
 * (and the supersession collapse) lives here.
 */
describe('pendingInterrupts (ADR 088)', () => {
  const env = (
    over: Partial<Envelope> & Pick<Envelope, 'id' | 'from' | 'to' | 'act'>,
  ): Envelope => ({
    v: PROTOCOL_VERSION,
    team: 'dawn',
    body: 'x',
    thread: null,
    meta: null,
    ts: 1,
    ...over,
  });
  const urgent = { urgent: true, urgent_reason: 'prod is down' };
  const toMe = { kind: 'member' as const, name: 'me' };

  it('raises an urgent directed act and an urgent request_help', () => {
    const msgs = [
      env({ id: 'a', from: 'nick', to: toMe, act: 'handoff', meta: urgent }),
      env({ id: 'b', from: 'jo', to: { kind: 'team' }, act: 'request_help', meta: urgent }),
    ];
    expect(
      pendingInterrupts(msgs, 'me')
        .map((m) => m.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('ignores a non-urgent act, a broadcast status_update, my own echo, and an act for someone else', () => {
    const msgs = [
      env({ id: 'plain', from: 'nick', to: toMe, act: 'handoff' }), // directed but not urgent
      env({ id: 'journal', from: 'jo', to: { kind: 'team' }, act: 'status_update', meta: urgent }), // urgent but not action-needed
      env({ id: 'mine', from: 'me', to: toMe, act: 'handoff', meta: urgent }), // my own send
      env({
        id: 'other',
        from: 'nick',
        to: { kind: 'member', name: 'you' },
        act: 'handoff',
        meta: urgent,
      }),
    ];
    expect(pendingInterrupts(msgs, 'me')).toEqual([]);
  });

  it('stops raising once the thread is resolved (a terminal resolve never interrupts)', () => {
    const msgs = [
      env({ id: 'ask', from: 'nick', to: toMe, act: 'request_help', meta: urgent, thread: 'ask' }),
      env({
        id: 'done',
        from: 'me',
        to: { kind: 'team' },
        act: 'resolve',
        thread: 'ask',
        meta: urgent,
      }),
    ];
    expect(pendingInterrupts(msgs, 'me')).toEqual([]);
  });

  it('returns newest first so the caller names the most recent steer', () => {
    const msgs = [
      env({ id: 'old', from: 'nick', to: toMe, act: 'handoff', meta: urgent, ts: 10 }),
      env({ id: 'new', from: 'jo', to: toMe, act: 'handoff', meta: urgent, ts: 20 }),
    ];
    expect(pendingInterrupts(msgs, 'me').map((m) => m.id)).toEqual(['new', 'old']);
  });

  // ADR 103 — the steering acts.
  it('raises a steer even when it is not flagged urgent (steer is interrupt-class by definition)', () => {
    const msgs = [env({ id: 's', from: 'nick', to: toMe, act: 'steer', body: 'use v2' })];
    expect(pendingInterrupts(msgs, 'me').map((m) => m.id)).toEqual(['s']);
  });

  it('does NOT raise a non-urgent challenge or defer (tier-configurable — they ride the urgent gate)', () => {
    const msgs = [
      env({ id: 'c', from: 'nick', to: toMe, act: 'challenge', body: 'why?' }),
      env({ id: 'd', from: 'nick', to: toMe, act: 'defer', meta: { goal_id: 'g1' } }),
    ];
    expect(pendingInterrupts(msgs, 'me')).toEqual([]);
  });

  it('raises a challenge and a defer when their sender flags them urgent', () => {
    const msgs = [
      env({ id: 'c', from: 'nick', to: toMe, act: 'challenge', meta: urgent }),
      env({ id: 'd', from: 'jo', to: toMe, act: 'defer', meta: { ...urgent, goal_id: 'g1' } }),
    ];
    expect(
      pendingInterrupts(msgs, 'me')
        .map((m) => m.id)
        .sort(),
    ).toEqual(['c', 'd']);
  });

  it('supersedes prior steers: only the newest steer survives, a late agent sees one direction', () => {
    const msgs = [
      env({ id: 's1', from: 'nick', to: toMe, act: 'steer', body: 'plan A', ts: 10 }),
      env({ id: 's2', from: 'jo', to: toMe, act: 'steer', body: 'plan B', ts: 20 }),
      env({ id: 's3', from: 'nick', to: toMe, act: 'steer', body: 'plan C', ts: 30 }),
    ];
    expect(pendingInterrupts(msgs, 'me').map((m) => m.id)).toEqual(['s3']);
  });

  it('a superseding steer does not swallow an unrelated urgent handoff still waiting', () => {
    const msgs = [
      env({ id: 'h', from: 'jo', to: toMe, act: 'handoff', meta: urgent, ts: 5 }),
      env({ id: 's1', from: 'nick', to: toMe, act: 'steer', ts: 10 }),
      env({ id: 's2', from: 'nick', to: toMe, act: 'steer', ts: 20 }),
    ];
    expect(pendingInterrupts(msgs, 'me').map((m) => m.id)).toEqual(['s2', 'h']);
  });

  it('a resolve on a steer thread closes it (a steer is not immune to resolution)', () => {
    const msgs = [
      env({ id: 's', from: 'nick', to: toMe, act: 'steer', thread: 's', ts: 10 }),
      env({ id: 'done', from: 'me', to: { kind: 'team' }, act: 'resolve', thread: 's', ts: 20 }),
    ];
    expect(pendingInterrupts(msgs, 'me')).toEqual([]);
  });

  it('resolving the current steer does NOT revive an older superseded steer (Bugbot: revive bug)', () => {
    const msgs = [
      env({ id: 's1', from: 'nick', to: toMe, act: 'steer', thread: 's1', ts: 10 }),
      env({ id: 's2', from: 'jo', to: toMe, act: 'steer', thread: 's2', ts: 20 }),
      env({ id: 'done', from: 'me', to: { kind: 'team' }, act: 'resolve', thread: 's2', ts: 30 }),
    ];
    // s2 (newest) supersedes s1 and is then resolved — nothing should interrupt (s1 stays dead).
    expect(pendingInterrupts(msgs, 'me')).toEqual([]);
  });

  it('two steers with the SAME ts collapse to exactly one (id tiebreak — Bugbot: equal-ts bug)', () => {
    const msgs = [
      env({ id: 'st-aaa', from: 'nick', to: toMe, act: 'steer', ts: 20 }),
      env({ id: 'st-bbb', from: 'jo', to: toMe, act: 'steer', ts: 20 }),
    ];
    const out = pendingInterrupts(msgs, 'me');
    expect(out).toHaveLength(1); // never a contradictory pair
    expect(out[0]!.id).toBe('st-bbb'); // deterministic: greatest id wins the tie
  });

  it('the newest steer still fires when an OLDER steer thread was resolved', () => {
    const msgs = [
      env({ id: 's1', from: 'nick', to: toMe, act: 'steer', thread: 's1', ts: 10 }),
      env({ id: 'done', from: 'me', to: { kind: 'team' }, act: 'resolve', thread: 's1', ts: 15 }),
      env({ id: 's2', from: 'jo', to: toMe, act: 'steer', thread: 's2', ts: 20 }),
    ];
    expect(pendingInterrupts(msgs, 'me').map((m) => m.id)).toEqual(['s2']);
  });

  /**
   * ADR 225 decision 1: a routed acceptance is obligation-class, so it reaches a LIVE acceptor on the
   * free ADR 088 rail instead of resting in an inbox until they volunteer to look. Measured 2026-08-04:
   * five routed acceptances reached a live, heads-down seat only when a human typed "check messages",
   * and two of them produced a crossed handoff — two seats re-assigning one lane twelve minutes apart
   * on unread inboxes. No wake addresses that; both seats were alive throughout.
   */
  describe('obligation class — a routed acceptance (ADR 225)', () => {
    const review = { species: 'approve', tier: 'standard', lane_review: { lane: 'L1' } };

    it('is OFF by default, so the wake rail keeps its ADR 191 policy gate', () => {
      // Regression: claimWakeLeases shares this predicate to pick IMMEDIATE wakes, which cost money
      // and whose review path is gated on loops.review + flow:auto. Admitting obligations by default
      // routed a paid wake around its own gate — caught by residency.test's two negative cases.
      const msgs = [env({ id: 'ask', from: 'miley', to: toMe, act: 'ask', meta: review })];
      expect(pendingInterrupts(msgs, 'me')).toEqual([]);
    });

    it('raises a routed acceptance ask that carries NO urgent flag', () => {
      const msgs = [env({ id: 'ask', from: 'miley', to: toMe, act: 'ask', meta: review })];
      expect(pendingInterrupts(msgs, 'me', { obligations: true }).map((m) => m.id)).toEqual([
        'ask',
      ]);
    });

    it('does NOT raise a plain directed ask — only a lane_review one is obligation-class', () => {
      const msgs = [
        env({ id: 'plain', from: 'miley', to: toMe, act: 'ask', meta: { tier: 'standard' } }),
      ];
      expect(pendingInterrupts(msgs, 'me', { obligations: true })).toEqual([]);
    });

    it('does not raise an acceptance routed to someone else, or my own echo', () => {
      const msgs = [
        env({
          id: 'theirs',
          from: 'miley',
          to: { kind: 'member', name: 'jo' },
          act: 'ask',
          meta: review,
        }),
        env({
          id: 'mine',
          from: 'me',
          to: { kind: 'member', name: 'jo' },
          act: 'ask',
          meta: review,
        }),
      ];
      expect(pendingInterrupts(msgs, 'me', { obligations: true })).toEqual([]);
    });

    it('stops raising once its thread is resolved', () => {
      const msgs = [
        env({ id: 'ask', from: 'miley', to: toMe, act: 'ask', thread: 'r1', meta: review, ts: 10 }),
        env({ id: 'done', from: 'me', to: { kind: 'team' }, act: 'resolve', thread: 'r1', ts: 20 }),
      ];
      expect(pendingInterrupts(msgs, 'me', { obligations: true })).toEqual([]);
    });

    it('does not supersede: two open acceptances are two obligations, unlike steers', () => {
      // A steer is a *direction* (newest wins, ADR 103). An acceptance is an *obligation* against a
      // specific lane — a second one does not discharge the first, so both must stay on the line.
      const msgs = [
        env({ id: 'a1', from: 'miley', to: toMe, act: 'ask', meta: review, ts: 10 }),
        env({
          id: 'a2',
          from: 'izzo',
          to: toMe,
          act: 'ask',
          meta: { ...review, lane_review: { lane: 'L2' } },
          ts: 20,
        }),
      ];
      expect(pendingInterrupts(msgs, 'me', { obligations: true }).map((m) => m.id)).toEqual([
        'a2',
        'a1',
      ]);
    });
  });
});

/**
 * ADR NNN: an eligible set narrows *obligation*. These cases pin the two properties the primitive
 * rests on — the named seats owe it and nobody else does, and the first answer stands the rest down —
 * plus the regressions that prove the default rules are untouched for every act without a set.
 */
describe('pendingInterrupts with an eligible set (ADR NNN)', () => {
  const env = (
    over: Partial<Envelope> & Pick<Envelope, 'id' | 'from' | 'to' | 'act'>,
  ): Envelope => ({
    v: PROTOCOL_VERSION,
    team: 'dawn',
    body: 'x',
    thread: null,
    meta: null,
    ts: 1,
    ...over,
  });
  const urgent = { urgent: true, urgent_reason: 'the daemon is pinned' };
  const toTeam = { kind: 'team' as const };
  const eligible = (extra: Record<string, unknown> = {}) => ({
    eligible: ['me', 'izzo'],
    ...urgent,
    ...extra,
  });
  const ask = env({ id: 'e1', from: 'nick', to: toTeam, act: 'message', meta: eligible() });

  it('a named seat owes it', () => {
    expect(pendingInterrupts([ask], 'me').map((m) => m.id)).toEqual(['e1']);
  });

  it('a seat outside the set owes nothing, though it can still read it', () => {
    expect(pendingInterrupts([ask], 'wanderer')).toEqual([]);
  });

  it('the first accept stands the other named seats down', () => {
    const answer = env({
      id: 'a1',
      from: 'izzo',
      to: { kind: 'member', name: 'nick' },
      act: 'accept',
      meta: { in_reply_to: 'e1' },
      ts: 2,
    });
    expect(pendingInterrupts([ask, answer], 'me')).toEqual([]);
  });

  it('a decline stands them down too — "not me" is an answer', () => {
    const answer = env({
      id: 'd1',
      from: 'izzo',
      to: { kind: 'member', name: 'nick' },
      act: 'decline',
      meta: { in_reply_to: 'e1' },
      ts: 2,
    });
    expect(pendingInterrupts([ask, answer], 'me')).toEqual([]);
  });

  it('an accept naming a DIFFERENT act does not discharge this one', () => {
    const answer = env({
      id: 'a2',
      from: 'izzo',
      to: { kind: 'member', name: 'nick' },
      act: 'accept',
      meta: { in_reply_to: 'something-else' },
      ts: 2,
    });
    expect(pendingInterrupts([ask, answer], 'me').map((m) => m.id)).toEqual(['e1']);
  });

  it('an eligible set NARROWS request_help instead of raising it team-wide', () => {
    const m = env({ id: 'r1', from: 'nick', to: toTeam, act: 'request_help', meta: eligible() });
    expect(pendingInterrupts([m], 'me').map((m) => m.id)).toEqual(['r1']);
    expect(pendingInterrupts([m], 'wanderer')).toEqual([]);
  });

  it('is inbox-class, not interrupt-class, without the urgent flag', () => {
    const quiet = env({
      id: 'q1',
      from: 'nick',
      to: toTeam,
      act: 'message',
      meta: { eligible: ['me', 'izzo'] },
    });
    expect(pendingInterrupts([quiet], 'me')).toEqual([]);
  });

  it('regression: a plain urgent request_help still raises for every seat', () => {
    const m = env({ id: 'r2', from: 'nick', to: toTeam, act: 'request_help', meta: urgent });
    expect(pendingInterrupts([m], 'wanderer').map((m) => m.id)).toEqual(['r2']);
  });

  it('regression: an accept does NOT discharge a plain directed act', () => {
    const direct = env({
      id: 'p1',
      from: 'nick',
      to: { kind: 'member', name: 'me' },
      act: 'handoff',
      meta: urgent,
    });
    const answer = env({
      id: 'a3',
      from: 'izzo',
      to: { kind: 'member', name: 'nick' },
      act: 'accept',
      meta: { in_reply_to: 'p1' },
      ts: 2,
    });
    expect(pendingInterrupts([direct, answer], 'me').map((m) => m.id)).toEqual(['p1']);
  });

  it('my own eligible-set send never raises my own line', () => {
    const mine = env({ id: 'm1', from: 'me', to: toTeam, act: 'message', meta: eligible() });
    expect(pendingInterrupts([mine], 'me')).toEqual([]);
  });
});
