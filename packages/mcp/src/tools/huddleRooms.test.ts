import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { MusterdClient } from '../client.js';
import { registerInboxCheck } from './inboxCheck.js';

/**
 * The lane's falsifier, stated as a test: an agent that has never seen the CLI can, FROM THE TOOL
 * SURFACE ALONE, tell that a turn belongs to a huddle, name its topic, and answer in it.
 *
 * Each of the three is asserted separately, because each failed separately before this change: the
 * turn arrived as a bare message (no topic), the earlier turns were invisible (no room), and the
 * only route back in was a `thread` field nothing named (no way to answer).
 */
type Handler = (args: any) => Promise<{ content: { text: string }[]; structuredContent?: any }>;

function capture(client: Partial<MusterdClient>): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_n: string, _s: unknown, h: Handler) => {
      handler = h;
    },
  };
  registerInboxCheck(server as never, client as never);
  if (!handler) throw new Error('no handler registered');
  return handler;
}

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

function env(over: Partial<Envelope> & { id: string; from: string }): Envelope {
  return {
    v: 1,
    team: 'dawn',
    to: { kind: 'team' },
    act: 'message',
    body: '',
    thread: null,
    meta: null,
    ts: 1,
    ...over,
  } as Envelope;
}

/** The opening act: its own id is the huddle id, and `meta.huddle` is the only row that names it. */
const root = env({
  id: 'H1',
  from: 'izzo',
  body: 'the wake question — do we ring named participants?',
  meta: {
    huddle: {
      topic: { kind: 'design', id: 'wake-on-open' },
      room: 'http://127.0.0.1:4851/b/huddle-h1',
      anchor: 'docs/decisions/378-a-huddle-is-a-thread.md',
      budget: { turns: 8 },
    },
    eligible: ['Ada', 'ryder'],
  },
  ts: 10,
});

/** An earlier turn — already read, so it is NOT in an unread inbox slice at any limit. */
const older = env({
  id: 'H1-t1',
  from: 'ryder',
  act: 'challenge',
  body: 'a wake costs a seat a turn; who pays when nobody answers?',
  thread: 'H1',
  ts: 20,
});

/** The turn that arrives now. It carries no huddle meta of its own (ADR 378 §2). */
const arriving = env({
  id: 'H1-t2',
  from: 'izzo',
  body: 'the opener pays — say so in the ADR?',
  thread: 'H1',
  ts: 30,
});

function client(over: Partial<MusterdClient> = {}): Partial<MusterdClient> {
  return {
    joined: true,
    holdsSeat: true,
    lastJoinError: null,
    member: 'Ada',
    drainBuffer: () => [],
    markRead: (async () => undefined) as any,
    fetchInbox: (async () => ({ messages: [arriving], cursor: null })) as any,
    fetchMessages: (async () => ({ messages: [root, older, arriving] })) as any,
    ...over,
  };
}

describe('a huddle turn on the MCP surface (ADR 378)', () => {
  it('says the turn belongs to a huddle, and names its topic', async () => {
    const r = await capture(client())({ unread_only: true, limit: 50 });
    expect(text(r)).toContain('in huddle design:wake-on-open');
    expect(r.structuredContent.messages[0].huddle_topic).toBe('design:wake-on-open');
  });

  it('shows the room: what it is for, who is in it, and the turn taken before this one', async () => {
    const r = await capture(client())({ unread_only: true, limit: 50 });
    const out = text(r);
    expect(out).toContain('huddle design:wake-on-open — open');
    expect(out).toContain('the wake question');
    expect(out).toContain('in it: izzo, ryder');
    // The already-read turn is the point: the inbox slice cannot carry it, and without the room
    // the arriving turn answers a question the reader never saw.
    expect(out).toContain('who pays when nobody answers');
    expect(r.structuredContent.huddles[0].turn_count).toBe(2);
  });

  it('names the exact call that answers in it', async () => {
    const r = await capture(client())({ unread_only: true, limit: 50 });
    expect(text(r)).toContain('answer in it: team_send {thread: "H1"');
  });

  it('tells a named seat that has not spoken that the room is waiting on it', async () => {
    const r = await capture(client())({ unread_only: true, limit: 50 });
    expect(text(r)).toContain('yet to speak: Ada');
    expect(text(r)).toContain('you are named here and have not spoken');
  });

  it('reports a closed room as closed, and where the output landed, instead of inviting a turn', async () => {
    const closed = env({
      id: 'H1-t3',
      from: 'izzo',
      act: 'resolve',
      body: 'landed',
      thread: 'H1',
      meta: { anchor_ref: 'docs/decisions/378-a-huddle-is-a-thread.md' },
      ts: 40,
    });
    const r = await capture(
      client({
        fetchInbox: (async () => ({ messages: [closed], cursor: null })) as any,
        fetchMessages: (async () => ({ messages: [root, older, arriving, closed] })) as any,
      }),
    )({ unread_only: true, limit: 50 });
    expect(text(r)).toContain('— closed');
    expect(text(r)).toContain('landed at docs/decisions/378');
    expect(text(r)).not.toContain('answer in it');
  });

  // The cost control: the timeline read is the price of the room, and an inbox with no turn in it
  // must not pay it. A stub that throws if called is how that is proved rather than assumed.
  it('does not read the timeline when nothing in the slice is threaded', async () => {
    const loose = env({ id: 'm1', from: 'nick', body: 'not a turn', ts: 5 });
    const r = await capture(
      client({
        fetchInbox: (async () => ({ messages: [loose], cursor: null })) as any,
        fetchMessages: (() => {
          throw new Error('the timeline must not be read for a huddle-free inbox');
        }) as any,
      }),
    )({ unread_only: true, limit: 50 });
    expect(text(r)).toContain('not a turn');
    expect(r.structuredContent.huddles).toBeUndefined();
  });

  // A room is a nicety; an inbox is not. An older daemon, or one that refuses the timeline read,
  // must still deliver the messages — degraded to exactly the behaviour that shipped before this.
  it('still delivers the turn when the timeline read fails', async () => {
    const r = await capture(
      client({ fetchMessages: (async () => Promise.reject(new Error('nope'))) as any }),
    )({ unread_only: true, limit: 50 });
    expect(text(r)).toContain('the opener pays');
    expect(text(r)).not.toContain('in huddle');
  });

  // A thread is not always a huddle: a plain reply chain has no root carrying `meta.huddle`, and
  // labelling it a room would be an invention.
  it('leaves an ordinary threaded reply unlabelled', async () => {
    const plainRoot = env({ id: 'P1', from: 'nick', body: 'question', ts: 10 });
    const reply = env({ id: 'P2', from: 'izzo', body: 'answer', thread: 'P1', ts: 20 });
    const r = await capture(
      client({
        fetchInbox: (async () => ({ messages: [reply], cursor: null })) as any,
        fetchMessages: (async () => ({ messages: [plainRoot, reply] })) as any,
      }),
    )({ unread_only: true, limit: 50 });
    expect(text(r)).not.toContain('in huddle');
    expect(r.structuredContent.huddles).toBeUndefined();
  });
});
