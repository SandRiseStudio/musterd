import { describe, expect, it } from 'vitest';
import type { Envelope } from '@musterd/protocol';
import {
  captionFor,
  captionForPresence,
  pushCaption,
  tickCaption,
  type Caption,
  type CaptionRail,
} from './captions';

const env = (over: Partial<Envelope>): Envelope =>
  ({
    id: '01TEST',
    team: 'revive',
    from: 'ryder',
    to: { kind: 'team' },
    act: 'message',
    body: '',
    ts: 0,
    ...over,
  }) as Envelope;

describe('captionFor — plain-language narration of notable moments (first-five-seconds §2)', () => {
  /**
   * ADR 254 eligible sets. These arrive as `to: {kind:'team'}` with the names in `meta.eligible`,
   * so the `if (!to) return null` guard swallowed them entirely — 28 review-routing `request_help`s
   * in the live corpus produced NO caption at all while the CLI printed the names.
   */
  it('narrates a request_help addressed to an eligible set, which used to caption nothing', () => {
    expect(
      captionFor(env({ act: 'request_help', to: { kind: 'team' }, meta: { eligible: ['dolly', 'sloane'] } })),
    ).toEqual({
      text: 'ryder is asking dolly or sloane for help',
      who: 'ryder',
      tone: 'ask',
    });
  });

  it('still says nothing for a plain team request_help — the team is the default audience', () => {
    expect(captionFor(env({ act: 'request_help', to: { kind: 'team' } }))).toBeNull();
    // A one-name "set" is a member act that took the wrong road, not an eligible set.
    expect(
      captionFor(env({ act: 'request_help', to: { kind: 'team' }, meta: { eligible: ['dolly'] } })),
    ).toBeNull();
  });

  it('narrates a directed handoff with names first', () => {
    expect(captionFor(env({ act: 'handoff', to: { kind: 'member', name: 'dolly' } }))).toEqual({
      text: 'ryder is handing work to dolly',
      who: 'ryder',
      tone: 'handoff',
    });
  });

  it('narrates a lane handoff the same way (the envelope form)', () => {
    expect(
      captionFor(
        env({
          act: 'message',
          to: { kind: 'member', name: 'dolly' },
          meta: { lane_handoff: { lane: 'x' } },
        }),
      ),
    ).toEqual({ text: 'ryder is handing work to dolly', who: 'ryder', tone: 'handoff' });
  });

  it('narrates a directed accept as the work being done', () => {
    expect(captionFor(env({ act: 'accept', from: 'dolly', to: { kind: 'member', name: 'izzo' } }))).toEqual({
      text: "dolly accepted izzo's work — it's done",
      who: 'dolly',
      tone: 'accept',
    });
  });

  it('narrates a steer, at the team when undirected', () => {
    expect(captionFor(env({ act: 'steer', to: { kind: 'member', name: 'izzo' } }))).toEqual({
      text: 'ryder is redirecting izzo',
      who: 'ryder',
      tone: 'steer',
    });
    expect(captionFor(env({ act: 'steer' }))?.text).toBe('ryder is redirecting the team');
  });

  it('narrates a directed help request, urgently when urgent', () => {
    expect(captionFor(env({ act: 'request_help', to: { kind: 'member', name: 'stanley' } }))).toEqual({
      text: 'ryder is asking stanley for help',
      who: 'ryder',
      tone: 'ask',
    });
    expect(
      captionFor(
        env({ act: 'request_help', to: { kind: 'member', name: 'stanley' }, meta: { urgent: true } }),
      ),
    ).toEqual({ text: 'ryder urgently needs stanley', who: 'ryder', tone: 'ask' });
  });

  it('narrates an ask to a human', () => {
    expect(
      captionFor(
        env({ act: 'ask', to: { kind: 'member', name: 'nick' }, meta: { species: 'approve' } }),
      ),
    ).toEqual({ text: 'ryder is asking nick to approve something', who: 'ryder', tone: 'ask' });
    expect(captionFor(env({ act: 'ask', to: { kind: 'member', name: 'nick' } }))?.text).toBe(
      'ryder is asking nick to weigh in',
    );
  });

  it('carries the ACTOR and an act family on every line — what the pill colours by', () => {
    // The dot takes the actor's colour, so `who` must be the member the sentence is *about* acting,
    // never the recipient: on an accept that is the acceptor, and on an arrival it is the arriver.
    const accept = captionFor(env({ act: 'accept', from: 'dolly', to: { kind: 'member', name: 'izzo' } }));
    expect(accept?.who).toBe('dolly');
    // Every tone a caption can carry is one the stylesheet has a rule for — a family added here
    // without its `.is-<tone>` rule would fall back to the neutral tint and read as an arrival.
    const tones = [
      captionFor(env({ act: 'handoff', to: { kind: 'member', name: 'd' } }))?.tone,
      accept?.tone,
      captionFor(env({ act: 'steer' }))?.tone,
      captionFor(env({ act: 'ask', to: { kind: 'member', name: 'nick' } }))?.tone,
      captionFor(env({ act: 'request_help', to: { kind: 'member', name: 's' } }))?.tone,
      captionForPresence(new Set(), new Set(['sloane']))?.tone,
    ];
    expect(tones).toEqual(['handoff', 'accept', 'steer', 'ask', 'ask', 'presence']);
  });

  it('status chatter never captions', () => {
    expect(captionFor(env({ act: 'status_update', body: 'grinding away' }))).toBeNull();
    expect(captionFor(env({ act: 'message', body: 'hello team' }))).toBeNull();
    expect(captionFor(env({ act: 'wait' }))).toBeNull();
  });
});

describe('captionForPresence — arrivals and departures', () => {
  it('narrates a join and a leave from the online-name diff', () => {
    expect(captionForPresence(new Set(['a']), new Set(['a', 'sloane']))).toEqual({
      text: 'sloane just walked in',
      who: 'sloane',
      tone: 'presence',
    });
    expect(captionForPresence(new Set(['a', 'sloane']), new Set(['a']))).toEqual({
      text: 'sloane just stepped out',
      who: 'sloane',
      tone: 'presence',
    });
    expect(captionForPresence(new Set(['a']), new Set(['a']))).toBeNull();
  });
});

describe('pushCaption — one at a time, short queue, drop the past', () => {
  const empty: CaptionRail = { current: null, shownAt: 0, queue: [] };

  const cap = (text: string): Caption => ({ text, who: text, tone: 'presence' });

  it('shows immediately when idle', () => {
    const s = pushCaption(empty, cap('hello'), 1000);
    expect(s.current?.text).toBe('hello');
  });

  it('queues up to 2 while one is on screen, then drops', () => {
    let s = pushCaption(empty, cap('a'), 0);
    s = pushCaption(s, cap('b'), 100);
    s = pushCaption(s, cap('c'), 200);
    s = pushCaption(s, cap('d'), 300); // past the 2-deep queue: dropped, not narrated late
    expect(s.current?.text).toBe('a');
    expect(s.queue.map((q) => q.text)).toEqual(['b', 'c']);
  });

  it('advances after the ~6s hold', () => {
    let s = pushCaption(empty, cap('a'), 0);
    s = pushCaption(s, cap('b'), 100);
    s = tickCaption(s, 6500);
    expect(s.current?.text).toBe('b');
    s = tickCaption(s, 13500);
    expect(s.current).toBeNull();
  });
});
