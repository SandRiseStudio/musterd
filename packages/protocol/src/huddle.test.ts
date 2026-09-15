import { describe, expect, it } from 'vitest';
import { EnvelopeSchema, makeEnvelope } from './envelope.js';
import { HuddleMetaSchema, huddleBoardName } from './huddle.js';

const base = {
  id: '01HUDDLE0000000000000000AA',
  team: 'dawn',
  from: 'Ada',
  to: { kind: 'team' } as const,
  ts: 1733760000000,
};

const huddle = {
  topic: { kind: 'lane', id: '01LANE' },
  room: 'http://127.0.0.1:4851/b/huddle-01huddle0000000000000000aa',
  anchor: 'docs/decisions/379-something.md',
  budget: { turns: 15 },
};

describe('meta.huddle (ADR 378)', () => {
  it('opens a huddle on a message with no thread; the envelope id is the huddle id', () => {
    const env = makeEnvelope({
      ...base,
      act: 'message',
      body: 'huddle: the asks rail',
      meta: { huddle },
    });
    expect(env.meta).toMatchObject({ huddle });
    expect(env.thread ?? null).toBeNull();
  });

  it('opens on request_help too, and on no other act', () => {
    expect(() => makeEnvelope({ ...base, act: 'request_help', meta: { huddle } })).not.toThrow();
    expect(() => makeEnvelope({ ...base, act: 'status_update', meta: { huddle } })).toThrow(
      /root act|message/,
    );
  });

  it('refuses meta.huddle on a turn inside a thread — the root carries it once', () => {
    expect(() =>
      makeEnvelope({ ...base, id: 'turn-1', act: 'message', thread: base.id, meta: { huddle } }),
    ).toThrow(/root act only/);
  });

  it('refuses a malformed huddle: missing topic id, non-URL room, empty anchor, unknown field', () => {
    const bad = [
      { ...huddle, topic: { kind: 'lane' } },
      { ...huddle, topic: { kind: 'sprint', id: 'x' } },
      { ...huddle, room: 'not a url' },
      { ...huddle, anchor: '' },
      { ...huddle, extra: true },
      { ...huddle, budget: { turns: 0 } },
      { ...huddle, budget: { ttl: 5 } },
    ];
    for (const h of bad) {
      const r = EnvelopeSchema.safeParse({
        ...base,
        v: 1,
        act: 'message',
        body: '',
        meta: { huddle: h },
      });
      expect(r.success, JSON.stringify(h)).toBe(false);
    }
    expect(HuddleMetaSchema.safeParse(huddle).success).toBe(true);
  });

  it('a turn is an ordinary act in the thread', () => {
    const turn = makeEnvelope({
      ...base,
      id: 'turn-2',
      act: 'challenge',
      thread: base.id,
      body: 'why 15?',
    });
    expect(turn.thread).toBe(base.id);
  });

  it('resolve closes naming meta.anchor_ref; anchor_ref rides resolve only', () => {
    const close = makeEnvelope({
      ...base,
      id: 'close-1',
      act: 'resolve',
      thread: base.id,
      meta: { anchor_ref: 'docs/decisions/379-something.md@abc123' },
    });
    expect(close.meta).toMatchObject({ anchor_ref: 'docs/decisions/379-something.md@abc123' });
    expect(() =>
      makeEnvelope({
        ...base,
        id: 'close-2',
        act: 'resolve',
        thread: base.id,
        meta: { anchor_ref: '' },
      }),
    ).toThrow(/anchor_ref/);
    expect(() =>
      makeEnvelope({
        ...base,
        id: 'm',
        act: 'message',
        thread: base.id,
        meta: { anchor_ref: 'x' },
      }),
    ).toThrow(/resolve/);
  });

  it('names the room board after the huddle id', () => {
    expect(huddleBoardName('01HUDDLE0000000000000000AA')).toBe('huddle-01huddle0000000000000000aa');
  });
});
