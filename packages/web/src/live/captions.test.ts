import { describe, expect, it } from 'vitest';
import type { Envelope } from '@musterd/protocol';
import { captionFor, captionForPresence, pushCaption, tickCaption, type CaptionRail } from './captions';

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
  it('narrates a directed handoff with names first', () => {
    expect(captionFor(env({ act: 'handoff', to: { kind: 'member', name: 'dolly' } }))).toBe(
      'ryder is handing work to dolly',
    );
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
    ).toBe('ryder is handing work to dolly');
  });

  it('narrates a directed accept as the work being done', () => {
    expect(captionFor(env({ act: 'accept', from: 'dolly', to: { kind: 'member', name: 'izzo' } }))).toBe(
      "dolly accepted izzo's work — it's done",
    );
  });

  it('narrates a steer, at the team when undirected', () => {
    expect(captionFor(env({ act: 'steer', to: { kind: 'member', name: 'izzo' } }))).toBe(
      'ryder is redirecting izzo',
    );
    expect(captionFor(env({ act: 'steer' }))).toBe('ryder is redirecting the team');
  });

  it('narrates a directed help request, urgently when urgent', () => {
    expect(captionFor(env({ act: 'request_help', to: { kind: 'member', name: 'stanley' } }))).toBe(
      'ryder is asking stanley for help',
    );
    expect(
      captionFor(
        env({ act: 'request_help', to: { kind: 'member', name: 'stanley' }, meta: { urgent: true } }),
      ),
    ).toBe('ryder urgently needs stanley');
  });

  it('narrates an ask to a human', () => {
    expect(
      captionFor(
        env({ act: 'ask', to: { kind: 'member', name: 'nick' }, meta: { species: 'approve' } }),
      ),
    ).toBe('ryder is asking nick to approve something');
    expect(captionFor(env({ act: 'ask', to: { kind: 'member', name: 'nick' } }))).toBe(
      'ryder is asking nick to weigh in',
    );
  });

  it('status chatter never captions', () => {
    expect(captionFor(env({ act: 'status_update', body: 'grinding away' }))).toBeNull();
    expect(captionFor(env({ act: 'message', body: 'hello team' }))).toBeNull();
    expect(captionFor(env({ act: 'wait' }))).toBeNull();
  });
});

describe('captionForPresence — arrivals and departures', () => {
  it('narrates a join and a leave from the online-name diff', () => {
    expect(captionForPresence(new Set(['a']), new Set(['a', 'sloane']))).toBe(
      'sloane just walked in',
    );
    expect(captionForPresence(new Set(['a', 'sloane']), new Set(['a']))).toBe(
      'sloane just stepped out',
    );
    expect(captionForPresence(new Set(['a']), new Set(['a']))).toBeNull();
  });
});

describe('pushCaption — one at a time, short queue, drop the past', () => {
  const empty: CaptionRail = { current: null, shownAt: 0, queue: [] };

  it('shows immediately when idle', () => {
    const s = pushCaption(empty, 'hello', 1000);
    expect(s.current).toBe('hello');
  });

  it('queues up to 2 while one is on screen, then drops', () => {
    let s = pushCaption(empty, 'a', 0);
    s = pushCaption(s, 'b', 100);
    s = pushCaption(s, 'c', 200);
    s = pushCaption(s, 'd', 300); // past the 2-deep queue: dropped, not narrated late
    expect(s.current).toBe('a');
    expect(s.queue).toEqual(['b', 'c']);
  });

  it('advances after the ~6s hold', () => {
    let s = pushCaption(empty, 'a', 0);
    s = pushCaption(s, 'b', 100);
    s = tickCaption(s, 6500);
    expect(s.current).toBe('b');
    s = tickCaption(s, 13500);
    expect(s.current).toBeNull();
  });
});
