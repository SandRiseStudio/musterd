import { deriveHuddles, PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { huddleMarks } from './huddles.js';

/**
 * ADR 378: a huddle is derived from the timeline, never stored — so the roster mark is that same
 * fold, joined to the member list. These build real envelopes and run them through the real
 * `deriveHuddles`, because a mark that disagrees with `musterd huddle list` is the bug.
 */
function env(partial: Partial<Envelope>): Envelope {
  return {
    id: 'm1',
    v: PROTOCOL_VERSION,
    team: 'dawn',
    from: 'Ada',
    to: { kind: 'team' },
    act: 'message',
    body: 'body',
    ts: 1000,
    ...partial,
  } as Envelope;
}

const root = (partial: Partial<Envelope> & { topicId: string }) =>
  env({
    ...partial,
    meta: { huddle: { topic: { kind: 'lane', id: partial.topicId }, room: 'http://r' } },
  });

const marksOf = (messages: Envelope[]) => huddleMarks(deriveHuddles(messages, 'nobody'));

describe('huddleMarks', () => {
  it('marks a seat that has spoken in an open huddle, naming the topic', () => {
    const marks = marksOf([
      root({ id: 'h1', from: 'Ada', topicId: '01KZ', to: { kind: 'member', name: 'Lin' } }),
      env({ id: 't1', from: 'Lin', thread: 'h1', ts: 2000 }),
    ]);

    expect(marks.get('Lin')).toContain('lane:01KZ');
  });

  it('marks the opener, who has spoken by opening', () => {
    const marks = marksOf([root({ id: 'h1', from: 'Ada', topicId: '01KZ' })]);

    expect(marks.get('Ada')).toContain('lane:01KZ');
  });

  it('does not mark a seat that was named but has not spoken', () => {
    const marks = marksOf([
      root({ id: 'h1', from: 'Ada', topicId: '01KZ', to: { kind: 'member', name: 'Lin' } }),
    ]);

    expect(marks.has('Lin')).toBe(false);
  });

  it('drops the mark once the huddle is closed', () => {
    const marks = marksOf([
      root({ id: 'h1', from: 'Ada', topicId: '01KZ' }),
      env({ id: 't1', from: 'Lin', thread: 'h1', ts: 2000 }),
      env({ id: 'r1', from: 'Ada', thread: 'h1', act: 'resolve', ts: 3000 }),
    ]);

    expect(marks.size).toBe(0);
  });

  it('names the newest huddle and counts the rest when a seat is in several', () => {
    const marks = marksOf([
      root({ id: 'h1', from: 'Ada', topicId: '01OLD', ts: 1000 }),
      root({ id: 'h2', from: 'Ada', topicId: '01NEW', ts: 5000 }),
    ]);

    expect(marks.get('Ada')).toContain('lane:01NEW');
    expect(marks.get('Ada')).not.toContain('01OLD');
    expect(marks.get('Ada')).toContain('+1');
  });
});
