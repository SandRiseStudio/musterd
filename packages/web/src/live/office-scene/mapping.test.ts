import type { Act, Envelope, Recipient } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { actToEvent, helpWalks, speechEventFor } from './mapping';

function env(act: Act, over: Partial<Envelope> = {}): Envelope {
  return {
    id: 'e1',
    v: 'musterd/0.3',
    team: 'ritual',
    from: 'ada',
    to: { kind: 'member', name: 'ben' } as Recipient,
    act,
    body: '',
    thread: null,
    meta: null,
    ts: 0,
    ...over,
  } as Envelope;
}

describe('actToEvent', () => {
  it('maps status_update to an ambient screen pulse at the sender', () => {
    expect(actToEvent(env('status_update'))).toEqual({
      kind: 'screen-pulse',
      who: 'ada',
      tone: 'status',
    });
  });

  it('maps a direct message to a note, a team message to a megaphone', () => {
    expect(actToEvent(env('message'))).toMatchObject({ kind: 'note', from: 'ada', to: ['ben'] });
    expect(actToEvent(env('message', { to: { kind: 'team' } }))).toEqual({
      kind: 'megaphone',
      from: 'ada',
    });
  });

  it('maps request_help to a walk-over, escalating to urgent on meta.urgent', () => {
    expect(actToEvent(env('request_help'))).toMatchObject({ kind: 'walk-help', tier: 'needs-attn' });
    expect(
      actToEvent(env('request_help', { meta: { urgent: true, urgent_reason: 'prod down' } })),
    ).toMatchObject({ kind: 'walk-help', tier: 'urgent' });
    expect(actToEvent(env('request_help', { to: { kind: 'broadcast' } }))).toMatchObject({
      kind: 'megaphone',
    });
  });

  it('maps handoff to a carry-box with a truncated label', () => {
    const e = actToEvent(env('handoff', { body: 'the auth refactor branch is ready to take over now' }));
    expect(e).toMatchObject({ kind: 'walk-handoff', from: 'ada', to: 'ben' });
    if (e && e.kind === 'walk-handoff') expect(e.label.length).toBeLessThanOrEqual(24);
  });

  it('maps accept/decline/wait/resolve to sender-anchored cues', () => {
    // A directed accept also carries the celebrant — the recipient whose work was accepted.
    expect(actToEvent(env('accept', { meta: { in_reply_to: 'x' } }))).toEqual({
      kind: 'accept',
      who: 'ada',
      of: 'ben',
    });
    // Team-addressed: nobody in particular was accepted, so there is no celebrant.
    expect(actToEvent(env('accept', { to: { kind: 'team' }, meta: { in_reply_to: 'x' } }))).toEqual({
      kind: 'accept',
      who: 'ada',
      of: null,
    });
    expect(actToEvent(env('decline', { meta: { in_reply_to: 'x' } }))).toEqual({ kind: 'decline', who: 'ada' });
    expect(actToEvent(env('wait'))).toEqual({ kind: 'wait', who: 'ada' });
    expect(actToEvent(env('resolve', { thread: 't1' }))).toEqual({ kind: 'resolve', who: 'ada' });
  });

  it('maps steer to an interrupt-class redirect, directed or team-wide, escalating on urgent', () => {
    // Directed steer carries its target so the office runs a redirect over to them.
    expect(actToEvent(env('steer'))).toEqual({ kind: 'steer', from: 'ada', to: 'ben', urgent: false });
    expect(actToEvent(env('steer', { meta: { urgent: true } }))).toEqual({
      kind: 'steer',
      from: 'ada',
      to: 'ben',
      urgent: true,
    });
    // A team steer has no member target — the room-wide sweep carries it.
    expect(actToEvent(env('steer', { to: { kind: 'team' } }))).toEqual({
      kind: 'steer',
      from: 'ada',
      to: null,
      urgent: false,
    });
  });

  it('maps challenge to a question at the challenger (and the challenged, when directed)', () => {
    expect(actToEvent(env('challenge'))).toEqual({
      kind: 'challenge',
      from: 'ada',
      to: ['ben'],
      urgent: false,
    });
    expect(actToEvent(env('challenge', { to: { kind: 'team' }, meta: { urgent: true } }))).toEqual({
      kind: 'challenge',
      from: 'ada',
      to: [],
      urgent: true,
    });
  });

  /**
   * ADR 254 eligible sets, on the three acts that may carry one. Every name is treated as a full
   * recipient — the sender walks to each desk in turn, exactly the trip a single recipient gets
   * (nick, 2026-09-02). Before this these fell through to `megaphone`: 28 request_help and 7
   * message acts in the live corpus drew nobody at all.
   */
  describe('an eligible set is a list of real recipients, not a team broadcast', () => {
    const set = (act: Act, eligible: string[], extra: Record<string, unknown> = {}) =>
      actToEvent(env(act, { to: { kind: 'team' }, meta: { eligible, ...extra } }));

    it('walks request_help to every seat in the set', () => {
      expect(set('request_help', ['ben', 'cy'])).toMatchObject({
        kind: 'walk-help',
        from: 'ada',
        to: ['ben', 'cy'],
        tier: 'needs-attn',
      });
    });

    it('carries the urgent tier across the whole set, not just the first leg', () => {
      expect(set('request_help', ['ben', 'cy', 'dee'], { urgent: true })).toMatchObject({
        tier: 'urgent',
        to: ['ben', 'cy', 'dee'],
      });
    });

    it('notes a message to every seat, and questions a challenge at every seat', () => {
      expect(set('message', ['ben', 'cy'])).toMatchObject({ kind: 'note', to: ['ben', 'cy'] });
      expect(set('challenge', ['ben', 'cy'])).toMatchObject({ kind: 'challenge', to: ['ben', 'cy'] });
    });

    it('drops the sender out of their own set — nobody walks to their own desk', () => {
      expect(set('request_help', ['ada', 'ben'])).toMatchObject({ to: ['ben'] });
    });

    it('falls back to the megaphone when the set names nobody else', () => {
      expect(set('request_help', ['ada'])).toEqual({ kind: 'megaphone', from: 'ada' });
      expect(actToEvent(env('request_help', { to: { kind: 'team' } }))).toEqual({
        kind: 'megaphone',
        from: 'ada',
      });
    });
  });

  it('maps defer to a sender-anchored plan mutation (its target is a Goal, not a member)', () => {
    expect(actToEvent(env('defer', { meta: { goal_id: 'g1', wave: 3 } }))).toEqual({
      kind: 'defer',
      who: 'ada',
    });
  });

  it('returns null for acts it does not animate', () => {
    expect(actToEvent(env('nope' as Act))).toBeNull();
  });
});

/** The bubble every act speaks. This is the layer ryder's 01M0GVNBHA acceptance found unpinned:
 * `addressee: null` at the emit site left every suite green, because only the pure rule
 * (speechAddressee) had tests — not the construction that calls it. */
describe('speechEventFor', () => {
  /* The sender is the person under the bubble, so a body that opens with their own name says it
     twice. Pinned at the construction site (this is where `text` is built), and pinned narrowly:
     only the SENDER's name, only at the start, never the recipient chip. */
  it('drops the leading "name: " when the name is the speaker\'s own', () => {
    expect(speechEventFor(env('status_update', { body: 'ada: #12 merged' })).text).toBe('#12 merged');
    expect(speechEventFor(env('status_update', { body: 'Ada:  #12 merged' })).text).toBe('#12 merged');
  });
  it('leaves another name, a mid-line name, and a body that is nothing but the name alone', () => {
    expect(speechEventFor(env('message', { body: 'ben: you were right' })).text).toBe('ben: you were right');
    expect(speechEventFor(env('message', { body: 'so ada: no' })).text).toBe('so ada: no');
    expect(speechEventFor(env('message', { body: 'ada:' })).text).toBe('ada:');
    expect(speechEventFor(env('message', { body: 'adam: hi' })).text).toBe('adam: hi');
  });

  it('a directed act carries its recipient onto the bubble — the wiring, not just the rule', () => {
    expect(speechEventFor(env('message', { body: 'you were right' }))).toEqual({
      kind: 'speech',
      who: 'ada',
      text: 'you were right',
      tone: 'neutral',
      id: 'e1',
      act: 'message',
      addressee: { names: ['ben'], label: 'ben', tether: true },
      // A plain message is the room working: no mark. Held by the exact-match above, not asserted
      // loosely — the whole point of this describe is that the CONSTRUCTION is pinned, and a field
      // that only appears when it is non-null is a field that can silently stop appearing.
      marking: null,
    });
  });

  /* The mark's half of the same wiring, and the same lesson ryder's 01M0GVNBHA acceptance taught:
     `speechMark` has its own suite, and reverting THIS call site to `marking: null` would leave all
     of it green while every bubble on the floor lost its badge. */
  it('carries the act mark onto the bubble — the wiring, not just the rule', () => {
    expect(speechEventFor(env('steer', { body: 'change of plan' })).marking).toEqual({
      mark: 'interrupt',
      holds: false,
    });
    expect(
      speechEventFor(env('ask', { body: 'ok to drop the index?', meta: { species: 'consult', tier: 'blocking' } }))
        .marking,
    ).toEqual({ mark: 'needs-human', holds: true });
  });

  /* A lane transition rides as a plain `message` + meta, so the mark can only be right if this call
     site recovers the lane kind and hands it over. Reverting the third argument to `null` is a
     one-token change that `speechMark`'s own suite cannot see. */
  it('recovers the lane kind for the mark — a blocked lane arrives as a `message`', () => {
    expect(
      speechEventFor(env('message', { meta: { lane_state: { state: 'blocked', title: 'x' } }, body: '[lane] "x" → blocked' }))
        .marking,
    ).toEqual({ mark: 'interrupt', holds: false });
  });

  it('team and broadcast acts name nobody (the team is the default audience)', () => {
    expect(speechEventFor(env('message', { to: { kind: 'team' }, body: 'hi all' })).addressee).toBeNull();
    expect(speechEventFor(env('message', { to: { kind: 'broadcast' }, body: 'hi' })).addressee).toBeNull();
  });

  it('a self-addressed act keeps the chip but drops the tether', () => {
    expect(
      speechEventFor(env('message', { to: { kind: 'member', name: 'ada' }, body: 'note to self' }))
        .addressee,
    ).toEqual({ names: ['ada'], label: 'ada', tether: false });
  });

  /**
   * The eligible-set half of the same wiring. `speechEventFor` must hand `meta.eligible` to
   * `speechAddressee`; dropping that argument leaves the rule's own tests green and puts the
   * megaphone back on every review-routing act — which is the state this lane found.
   */
  it('carries an eligible set onto the bubble — 2-4 named seats, none of them picked', () => {
    expect(
      speechEventFor(
        env('request_help', {
          to: { kind: 'team' },
          body: 'Review please',
          meta: { eligible: ['ben', 'cy'] },
        }),
      ).addressee,
    ).toEqual({ names: ['ben', 'cy'], label: 'ben or cy', tether: true });
  });

  it('a body-less act speaks its act label so nothing passes invisibly', () => {
    const ev = speechEventFor(env('accept'));
    expect(ev.text).toBe('accept');
    expect(ev.tone).toBe('success');
  });

  it('whitespace-only bodies count as body-less', () => {
    expect(speechEventFor(env('status_update', { body: '   ' })).text).toBe('status');
  });
});

/**
 * The fan-out the scene performs for a `walk-help`. Pinned here because the loop that consumes it
 * lives in the imperative scene module: mutating that loop to `ev.to.slice(0, 1)` — walk only the
 * first seat of an eligible set — left all 890 web tests green before this function existed.
 *
 * What this does NOT hold, stated rather than implied: that the scene calls `actors.walk` once per
 * returned request. That is one line inside `index.ts`, which has no DOM here to mount; the fan-out
 * decision itself is now covered, instead of nothing being covered.
 */
describe('helpWalks — one trip per seat, in the order the sender named them', () => {
  const ev = (to: string[], tier: 'needs-attn' | 'urgent' = 'needs-attn') =>
    ({ kind: 'walk-help', from: 'ada', to, tier }) as const;

  it('makes a trip for every seat of an eligible set, not just the first', () => {
    expect(helpWalks(ev(['ben', 'cy', 'dee']))).toEqual([
      { kind: 'help', to: 'ben', urgent: false },
      { kind: 'help', to: 'cy', urgent: false },
      { kind: 'help', to: 'dee', urgent: false },
    ]);
  });

  it('carries the urgent tier onto every leg — the last desk is not a calmer errand', () => {
    expect(helpWalks(ev(['ben', 'cy'], 'urgent')).every((w) => w.urgent)).toBe(true);
  });

  it('is a single trip for a single recipient, unchanged', () => {
    expect(helpWalks(ev(['ben']))).toEqual([{ kind: 'help', to: 'ben', urgent: false }]);
  });

  it('asks for no trip at all when the act named nobody', () => {
    expect(helpWalks(ev([]))).toEqual([]);
  });
});
