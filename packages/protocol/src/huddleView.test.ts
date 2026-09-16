import { describe, expect, it } from 'vitest';
import type { Envelope } from './envelope.js';
import { deriveHuddles } from './huddleView.js';
import { PROTOCOL_VERSION } from './version.js';

function env(partial: Partial<Envelope>): Envelope {
  return {
    id: 'm',
    v: PROTOCOL_VERSION,
    team: 'dawn',
    from: 'Ada',
    to: { kind: 'team' },
    act: 'message',
    body: '',
    ts: 1000,
    ...partial,
  } as Envelope;
}

// ADR 407 increment 3: a turn keeps who it was said TO. The fold projected turns down to five
// fields, which was enough while a reader could only see turns it was party to (ADR 128); now that
// it reads every turn on the team, a renderer must be able to tell the addressee from a bystander.
describe('a huddle turn carries its addressee (ADR 407 inc 3)', () => {
  const root = env({
    id: 'h1',
    from: 'nick',
    meta: {
      huddle: {
        topic: { kind: 'design', id: 'x' },
        room: 'http://127.0.0.1:4851/b/h1',
        anchor: 'a',
      },
    },
  });

  it('projects `to` on every turn', () => {
    const directed = env({
      id: 't1',
      from: 'Ada',
      to: { kind: 'member', name: 'Lin' },
      thread: 'h1',
      ts: 1001,
    });
    const team = env({ id: 't2', from: 'Lin', to: { kind: 'team' }, thread: 'h1', ts: 1002 });
    const [h] = deriveHuddles([root, directed, team], 'nobody');
    expect(h?.turns.map((t) => t.to)).toEqual([{ kind: 'member', name: 'Lin' }, { kind: 'team' }]);
  });

  it('projects the eligible set when a turn names one, and omits it otherwise', () => {
    const either = env({
      id: 't3',
      from: 'Ada',
      to: { kind: 'team' },
      act: 'request_help',
      thread: 'h1',
      ts: 1003,
      meta: { eligible: ['Lin', 'Cy'] },
    });
    const plain = env({ id: 't4', from: 'Ada', to: { kind: 'team' }, thread: 'h1', ts: 1004 });
    const [h] = deriveHuddles([root, either, plain], 'nobody');
    expect(h?.turns[0]?.eligible).toEqual(['Lin', 'Cy']);
    expect(h?.turns[1]?.eligible).toBeUndefined();
  });
});
