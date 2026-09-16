import type { HuddleView } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { renderRoom, roomStructured } from './huddleRooms.js';

// ADR 407 increment 3, on the surface an AGENT reads a room from. After inc 2 a bystander is
// shown turns it was not sent; the fold must say so, because an agent is the reader most likely
// to act on a turn it only saw.
function view(): HuddleView {
  return {
    id: 'h1',
    topic: 'design:marker',
    room: '',
    anchor: 'docs/x.md',
    opener: 'nick',
    openedAt: 1000,
    body: 'why we are huddling',
    turns: [
      {
        id: 't1',
        from: 'Ada',
        act: 'request_help',
        body: 'Lin, can you take this',
        ts: 1001,
        to: { kind: 'member', name: 'Lin' },
      },
      { id: 't2', from: 'Lin', act: 'message', body: 'on it', ts: 1002, to: { kind: 'team' } },
    ],
    named: ['nick', 'Lin'],
    spoke: ['nick', 'Ada', 'Lin'],
  } as HuddleView;
}

describe('renderRoom marks a turn the reader was not sent (ADR 407 inc 3)', () => {
  it('names the addressee on a directed turn and says it is not addressed to a bystander', () => {
    const out = renderRoom(view(), 'Bo');
    expect(out).toContain('Ada [request_help] → Lin');
    expect(out).toContain('not addressed to you');
  });

  it('is silent for the addressee and for the sender', () => {
    expect(renderRoom(view(), 'Lin')).not.toContain('not addressed');
    expect(renderRoom(view(), 'Ada')).not.toContain('not addressed');
  });

  it('a team-directed turn carries no marker for anyone', () => {
    const out = renderRoom(view(), 'Bo');
    const teamLine = out.split('\n').find((l) => l.includes('Lin [message]')) ?? '';
    expect(teamLine).not.toContain('→');
    expect(out.split('not addressed').length - 1).toBe(1);
  });

  it('the structured shape carries the addressee, so a programmatic reader has the same fact', () => {
    const s = roomStructured(view()) as { turns: { id: string; to?: unknown }[] };
    expect(s.turns.find((t) => t.id === 't1')?.to).toEqual({ kind: 'member', name: 'Lin' });
  });
});
