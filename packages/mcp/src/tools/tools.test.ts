import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  makeEnvelope,
  nextRoleHandle,
  type Envelope,
  type Lane,
  type MemberSummary,
} from '@musterd/protocol';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { formatMessage, notJoinedMessage, textResult } from './format.js';
import { registerInboxCheck } from './inboxCheck.js';
import { registerJoin } from './join.js';
import { registerLanes } from './lanes.js';
import { registerLeave } from './leave.js';
import { registerMembers } from './members.js';
import { memoryLine, registerMemory } from './memory.js';
import { registerSend } from './send.js';
import { registerStatus } from './status.js';
import { registerWakeContext } from './wakeContext.js';

type Handler = (args: any) => Promise<{ content: { text: string }[]; structuredContent?: any }>;

/** Capture the single tool handler a register* function installs, so we can call it directly. */
function capture(
  register: (server: any, client: any, config: any) => void,
  client: Partial<MusterdClient>,
  config?: Partial<McpConfig>,
): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_name: string, _schema: unknown, h: Handler) => {
      handler = h;
    },
  };
  register(server, client, config ?? {});
  if (!handler) throw new Error('no handler registered');
  return handler;
}

/** Like `capture`, for a register* function that installs several tools — keyed by tool name. */
function captureAll(
  register: (server: any, client: any, config?: any) => void,
  client: Partial<MusterdClient>,
): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _schema: unknown, h: Handler) => {
      handlers[name] = h;
    },
  };
  register(server, client);
  return handlers;
}

const config: McpConfig = {
  server: 'http://x',
  team: 'dawn',
  agent_key: 'mskey_team',
  member: 'Ada',
  surface: 'claude-code',
  provenance: 'session',
  workspace: 'repo',
  claim: { mode: 'seat', name: 'Ada' },
  connId: 'conn-1',
  claimCode: 'AB12',
  // An ISOLATED temp subdir, never a shared root like `/tmp`: the team_join handler test persists a
  // binding here (claimAndJoin → persistBinding writes bindingDir/.musterd/binding.json), and a shared
  // root would sit on the walk-up path of every other test's temp dir under $TMPDIR — leaking an
  // identity into their findBinding/resolveBindingDir (the CI-only failure this guards against). A
  // sibling temp dir is never an ancestor, so it can't pollute.
  bindingDir: mkdtempSync(pathJoin(tmpdir(), 'mcp-tools-bind-')),
};
afterAll(() => rmSync(config.bindingDir, { recursive: true, force: true }));

function member(over: Partial<MemberSummary> = {}): MemberSummary {
  return {
    id: 'm1',
    team: 'dawn',
    name: 'Ada',
    kind: 'agent',
    role: 'backend',
    roles: ['backend'],
    lifecycle: 'forever',
    lifecycle_until: null,
    created_at: 0,
    presence: 'online',
    // A live agent normally attests its model. The fixture carries one so these tests keep testing
    // facet composition rather than tripping the `model unattested` warn facet — which has its own
    // test below, and is the whole point of it being loud.
    presences: [
      { surface: 'claude-code', status: 'active', last_seen_at: 0, model: 'claude-opus-5' },
    ],
    ...over,
  };
}

function text(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('format helpers', () => {
  it('formats a member-addressed message with meta and id', () => {
    const env = makeEnvelope({
      id: 'abc',
      team: 'dawn',
      from: 'nick',
      to: { kind: 'member', name: 'Ada' },
      act: 'message',
      body: 'hi',
      meta: { progress: 0.5 },
    });
    const s = formatMessage(env);
    expect(s).toContain('nick [message] → Ada: hi');
    expect(s).toContain('{"progress":0.5}');
    expect(s).toContain('(id=abc)');
  });

  it('renders @team and @broadcast recipients, and omits empty meta', () => {
    const team = formatMessage(
      makeEnvelope({
        id: '1',
        team: 'dawn',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: 'b',
      }),
    );
    const bc = formatMessage(
      makeEnvelope({
        id: '2',
        team: 'dawn',
        from: 'nick',
        to: { kind: 'broadcast' },
        act: 'message',
        body: 'b',
      }),
    );
    expect(team).toContain('→ @team');
    expect(bc).toContain('→ @broadcast');
    expect(team).not.toContain('{}');
  });

  it('textResult wraps a string as MCP text content', () => {
    expect(textResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });

  it('notJoinedMessage appends the last join error when present', () => {
    expect(notJoinedMessage('send', null)).toMatch(/call team_join first, then send/);
    const withErr = notJoinedMessage('send', 'timed out waiting for admin approval');
    expect(withErr).toContain('last join attempt failed: timed out waiting for admin approval');
    // A superseded join error takes the ADR 237 eviction branch instead — see format.test.ts.
    expect(notJoinedMessage('send', 'superseded by a newer session')).toMatch(/evicted/i);
  });
});

describe('team_send handler', () => {
  it('blocks when not joined and surfaces the last join error', async () => {
    const handler = capture(
      registerSend,
      { joined: false, claimed: true, lastJoinError: 'token rejected', claimCode: 'AB12' },
      config,
    );
    const r = await handler({ to: '@team', act: 'message', body: 'x' });
    expect(text(r)).toContain('call team_join first');
    expect(text(r)).toContain('token rejected');
  });

  it('sends an envelope, marks it seen, and reports the id', async () => {
    const sendEnvelope = vi.fn(async () => undefined);
    const markSeen = vi.fn();
    const handler = capture(
      registerSend,
      {
        joined: true,
        holdsSeat: true,
        lastJoinError: null,
        sendEnvelope: sendEnvelope as any,
        markSeen,
      },
      config,
    );
    const r = await handler({ to: 'Lin', act: 'handoff', body: 'take this', reply_to: 'r1' });
    expect(sendEnvelope).toHaveBeenCalledTimes(1);
    const sent = sendEnvelope.mock.calls[0]![0] as Envelope;
    expect(sent.to).toEqual({ kind: 'member', name: 'Lin' });
    expect(sent.meta?.['in_reply_to']).toBe('r1');
    expect(markSeen).toHaveBeenCalledWith(sent.id);
    expect(text(r)).toContain('sent handoff to Lin');
  });

  it('surfaces a delivery_hint verbatim in text + structuredContent; absent hint leaves both bare (ADR 167)', async () => {
    const hint = {
      recipient_live: true,
      rail: 'ccd_session',
      nudge_text:
        'musterd: stanley sent you a handoff (01AAAAAAAAAAAAAAAAAAAAAAAA) — run team_inbox_check.',
      nudge_fingerprint: 'aaaabbbbccccdddd',
    };
    const handler = capture(
      registerSend,
      {
        joined: true,
        holdsSeat: true,
        lastJoinError: null,
        sendEnvelope: (async () => ({ delivery_hint: hint })) as any,
        markSeen: vi.fn(),
      },
      config,
    );
    const r = await handler({ to: 'Lin', act: 'handoff', body: 'take this' });
    expect(text(r)).toContain('VERBATIM');
    expect(text(r)).toContain(hint.nudge_text); // quoted whole, so the model can relay it unmodified
    expect((r as any).structuredContent.delivery_hint).toEqual(hint);

    // Older daemon / no hint → byte-identical to the pre-ADR response shape.
    const bare = capture(
      registerSend,
      {
        joined: true,
        holdsSeat: true,
        lastJoinError: null,
        sendEnvelope: (async () => undefined) as any,
        markSeen: vi.fn(),
      },
      config,
    );
    const r2 = await bare({ to: 'Lin', act: 'handoff', body: 'take this' });
    expect(text(r2)).not.toContain('VERBATIM');
    expect((r2 as any).structuredContent.delivery_hint).toBeUndefined();
  });

  it('maps @team / @broadcast recipients', async () => {
    const sent: Envelope[] = [];
    const handler = capture(
      registerSend,
      {
        joined: true,
        holdsSeat: true,
        lastJoinError: null,
        sendEnvelope: (async (e: Envelope) => {
          sent.push(e);
        }) as any,
        markSeen: vi.fn(),
      },
      config,
    );
    await handler({ to: '@team', act: 'message', body: 'a' });
    await handler({ to: '@broadcast', act: 'message', body: 'b' });
    expect(sent[0]!.to).toEqual({ kind: 'team' });
    expect(sent[1]!.to).toEqual({ kind: 'broadcast' });
  });

  it('reports an error result when the send fails', async () => {
    const handler = capture(
      registerSend,
      {
        joined: true,
        holdsSeat: true,
        lastJoinError: null,
        sendEnvelope: (async () => {
          throw new Error('network down');
        }) as any,
        markSeen: vi.fn(),
      },
      config,
    );
    const r = await handler({ to: '@team', act: 'message', body: 'x' });
    expect(text(r)).toContain('error: network down');
  });

  // accept/decline auto-targeting (ADR 067, parity with the CLI).
  function sendClient(over: Partial<MusterdClient> = {}): {
    client: Partial<MusterdClient>;
    sent: Envelope[];
  } {
    const sent: Envelope[] = [];
    return {
      sent,
      client: {
        joined: true,
        holdsSeat: true,
        lastJoinError: null,
        sendEnvelope: (async (e: Envelope) => {
          sent.push(e);
        }) as any,
        markSeen: vi.fn(),
        ...over,
      },
    };
  }
  const req = (over: Partial<Envelope>): Envelope =>
    ({
      id: 'x',
      team: 'dawn',
      from: 'nick',
      to: { kind: 'member', name: 'Ada' },
      act: 'request_help',
      body: '?',
      thread: null,
      ts: 1,
      meta: null,
      ...over,
    }) as Envelope;

  it('accept auto-targets the latest open request and inherits its thread (no reply_to)', async () => {
    const { client, sent } = sendClient({
      fetchInbox: (async () => ({
        messages: [
          req({ id: 'req1', ts: 1 }),
          req({ id: 'req2', ts: 5, act: 'handoff', thread: 'root2' }),
        ],
        cursor: null,
      })) as any,
    });
    const handler = capture(registerSend, client, config);
    await handler({ to: 'nick', act: 'accept', body: 'on it' });
    expect(sent[0]!.meta?.['in_reply_to']).toBe('req2'); // newest open
    expect(sent[0]!.thread).toBe('root2'); // inherited the request's thread
  });

  // The mis-attribution observed live 2026-07-31: an accept whose body read "Lane A accepted" bound
  // to lane B's ask, 90s newer, because auto-targeting takes the NEWEST open ask. Writing a considered
  // verdict takes minutes, which is exactly the window another ask arrives in — so a lane acceptance
  // must never be guessed at.
  const laneAsk = (id: string, ts: number, lane: string): Envelope =>
    req({ id, ts, act: 'ask', meta: { lane_review: { lane } } as never });

  it('refuses to guess which lane an accept answers when the newest open ask is a lane review', async () => {
    const { client, sent } = sendClient({
      fetchInbox: (async () => ({
        messages: [
          laneAsk('askA', 1, '01LANEA'),
          laneAsk('askB', 5, '01LANEB'), // newest — would have silently stolen the verdict
        ],
        cursor: null,
      })) as any,
    });
    const handler = capture(registerSend, client, config);
    const r = await handler({ to: 'nick', act: 'accept', body: 'Lane 01LANEA accepted' });
    expect(sent).toHaveLength(0); // nothing sent — a mis-attributed verdict is worse than none
    const out = text(r);
    expect(out).toContain('reply_to:askA');
    expect(out).toContain('01LANEA'); // names the candidates so answering is one copy-paste
    expect(out).toContain('reply_to:askB');
  });

  // The candidate list is only useful if it shrinks. An ask I already answered must leave it —
  // and NOTHING in my own inbox says I answered, because `listInbox` excludes my own sends, so the
  // accept that discharged it is not in `messages`. Closure came from `act === 'resolve'` alone and
  // the live ledger holds 199 accepts against 9 resolves, so every answered acceptance ask stayed a
  // candidate forever. Found when the guard offered me six asks whose lanes were all long done.
  it('drops an ask this seat already answered, so the candidate list shrinks (server `answered`)', async () => {
    const inbox = {
      messages: [laneAsk('askA', 1, '01LANEA'), laneAsk('askB', 5, '01LANEB')],
      cursor: null,
      answered: ['askB'], // the verdict on B is already sent — only A is still a question
    };
    const { client, sent } = sendClient({ fetchInbox: (async () => inbox) as any });
    const handler = capture(registerSend, client, config);
    await handler({ to: 'nick', act: 'accept', body: 'looks right' });
    // One candidate left, so the guard does not fire and the verdict binds to A — not to the
    // newest ask, which is exactly the mis-attribution the guard exists to prevent.
    expect(sent[0]!.meta?.['in_reply_to']).toBe('askA');
  });

  it('still refuses to guess when TWO asks are genuinely unanswered', async () => {
    const inbox = {
      messages: [laneAsk('askA', 1, '01LANEA'), laneAsk('askB', 5, '01LANEB')],
      cursor: null,
      answered: [] as string[],
    };
    const { client, sent } = sendClient({ fetchInbox: (async () => inbox) as any });
    const handler = capture(registerSend, client, config);
    const r = await handler({ to: 'nick', act: 'accept', body: 'Lane 01LANEA accepted' });
    expect(sent).toHaveLength(0);
    expect(text(r)).toContain('reply_to:askA');
  });

  // THE LIVE DEFECT (lane 01M03ANKS4, measured 2026-08-15). The guard used to ask whether the
  // NEWEST open ask was a lane acceptance — so a plain team-wide `ask` arriving after the
  // acceptance ask turned the guard off, and the verdict bound to the newcomer. Four accepts landed
  // on guardian `daemon_down` asks that way; two of them, like this one, had the correct acceptance
  // ask sitting open and passed it over.
  it('refuses when a lane ask is open but a PLAIN ask is newer (the guardian mis-binding)', async () => {
    const { client, sent } = sendClient({
      fetchInbox: (async () => ({
        messages: [
          laneAsk('askA', 1, '01LANEA'),
          req({ id: 'guardian1', ts: 9, act: 'ask', to: { kind: 'team' } as any }),
        ],
        cursor: null,
      })) as any,
    });
    const handler = capture(registerSend, client, config);
    const r = await handler({ to: 'nick', act: 'accept', body: 'Lane 01LANEA accepted' });
    expect(sent).toHaveLength(0);
    // …and the lane ask it should have gone to is offered by id.
    expect(text(r)).toContain('reply_to:askA');
    expect(text(r)).toContain('01LANEA');
  });

  it('still auto-targets a lone lane-review ask — one candidate is not a guess', async () => {
    const { client, sent } = sendClient({
      fetchInbox: (async () => ({
        messages: [laneAsk('only1', 3, '01LANEA')],
        cursor: null,
      })) as any,
    });
    const handler = capture(registerSend, client, config);
    await handler({ to: 'nick', act: 'accept', body: 'looks right' });
    expect(sent[0]!.meta?.['in_reply_to']).toBe('only1');
  });

  it('keeps ADR 067 convenience for plain requests even with several open', async () => {
    const { client, sent } = sendClient({
      fetchInbox: (async () => ({
        messages: [
          req({ id: 'r1', ts: 1 }),
          req({ id: 'r2', ts: 9, act: 'handoff', thread: 'root2' }),
        ],
        cursor: null,
      })) as any,
    });
    const handler = capture(registerSend, client, config);
    await handler({ to: 'nick', act: 'accept', body: 'on it' });
    // Answering the wrong request_help is recoverable; answering the wrong lane is not.
    expect(sent[0]!.meta?.['in_reply_to']).toBe('r2');
  });

  it('sends a steer (the ADR 103 steering vocabulary is selectable from MCP)', async () => {
    const { client, sent } = sendClient();
    const handler = capture(registerSend, client, config);
    const r = await handler({ to: 'Ada', act: 'steer', body: 'switch to v2' });
    expect(sent[0]!.act).toBe('steer');
    expect(text(r)).toContain('sent steer to Ada');
  });

  it('accept auto-targets an open challenge (challenge is answered with an accept, ADR 103)', async () => {
    const { client, sent } = sendClient({
      fetchInbox: (async () => ({
        messages: [req({ id: 'ch1', ts: 7, act: 'challenge', thread: 'root-ch' })],
        cursor: null,
      })) as any,
    });
    const handler = capture(registerSend, client, config);
    await handler({ to: 'nick', act: 'accept', body: 'here is why' });
    expect(sent[0]!.meta?.['in_reply_to']).toBe('ch1');
    expect(sent[0]!.thread).toBe('root-ch');
  });

  it('an explicit reply_to wins over auto-targeting (no inbox read)', async () => {
    const fetchInbox = vi.fn();
    const { client, sent } = sendClient({ fetchInbox: fetchInbox as any });
    const handler = capture(registerSend, client, config);
    await handler({ to: 'nick', act: 'accept', body: 'on it', reply_to: 'explicit' });
    expect(sent[0]!.meta?.['in_reply_to']).toBe('explicit');
    expect(fetchInbox).not.toHaveBeenCalled();
  });

  it('accept errors with guidance when nothing is open (resolved threads excluded)', async () => {
    const { client, sent } = sendClient({
      fetchInbox: (async () => ({
        messages: [
          req({ id: 'req1', thread: 'root1', ts: 1 }),
          req({ id: 'res1', act: 'resolve', thread: 'root1', ts: 2 }),
        ],
        cursor: null,
      })) as any,
    });
    const handler = capture(registerSend, client, config);
    const r = await handler({ to: 'nick', act: 'accept', body: 'on it' });
    expect(text(r)).toContain('no open request to accept');
    expect(sent).toHaveLength(0); // nothing sent
  });

  // ADR 254: naming 2-4 seats in `to` sends ONE team-addressed act carrying meta.eligible. The
  // array is surface sugar — nothing below routeEnvelope learns a new wire shape.
  describe('an eligible set in `to`', () => {
    const liveClient = () => {
      const sendEnvelope = vi.fn(async () => undefined);
      return {
        sendEnvelope,
        client: {
          joined: true,
          holdsSeat: true,
          lastJoinError: null,
          sendEnvelope: sendEnvelope as any,
          markSeen: vi.fn(),
        },
      };
    };

    it('sends one team act carrying the set, not two directed acts', async () => {
      const { sendEnvelope, client } = liveClient();
      const handler = capture(registerSend, client, config);
      const r = await handler({
        to: ['stanley', 'izzo'],
        act: 'message',
        body: 'either of you know why the daemon pinned?',
      });

      expect(sendEnvelope).toHaveBeenCalledTimes(1);
      const sent = sendEnvelope.mock.calls[0]![0] as Envelope;
      expect(sent.to).toEqual({ kind: 'team' });
      expect(sent.meta?.['eligible']).toEqual(['stanley', 'izzo']);
      expect(text(r)).toContain('stanley, izzo');
    });

    it('reports the set in structuredContent so a programmatic caller need not parse prose', async () => {
      const { client } = liveClient();
      const handler = capture(registerSend, client, config);
      const r = await handler({ to: ['stanley', 'izzo'], act: 'challenge', body: 'justify it' });
      expect(r.structuredContent).toMatchObject({
        act: 'challenge',
        to: 'stanley, izzo',
        eligible: ['stanley', 'izzo'],
      });
    });

    it('refuses five names without sending, and says to use @team', async () => {
      const { sendEnvelope, client } = liveClient();
      const handler = capture(registerSend, client, config);
      const r = await handler({ to: ['a', 'b', 'c', 'd', 'e'], act: 'message', body: 'x' });
      expect(sendEnvelope).not.toHaveBeenCalled();
      expect(text(r)).toContain('@team');
    });

    it('refuses an eligible set on handoff — the protocol rejects it, and nothing is sent', async () => {
      const { sendEnvelope, client } = liveClient();
      const handler = capture(registerSend, client, config);
      const r = await handler({ to: ['stanley', 'izzo'], act: 'handoff', body: 'take this' });
      expect(sendEnvelope).not.toHaveBeenCalled();
      expect(text(r)).toMatch(/eligible/i);
    });

    it('regression: a one-element array still sends a plain directed act', async () => {
      const { sendEnvelope, client } = liveClient();
      const handler = capture(registerSend, client, config);
      await handler({ to: ['Lin'], act: 'handoff', body: 'take this' });
      const sent = sendEnvelope.mock.calls[0]![0] as Envelope;
      expect(sent.to).toEqual({ kind: 'member', name: 'Lin' });
      expect(sent.meta?.['eligible']).toBeUndefined();
    });
  });
});

describe('team_inbox_check handler', () => {
  function inboxClient(over: Partial<MusterdClient>): Partial<MusterdClient> {
    return {
      joined: true,
      holdsSeat: true,
      lastJoinError: null,
      drainBuffer: () => [],
      markRead: (async () => undefined) as any,
      ...over,
    };
  }

  it('blocks when not joined', async () => {
    const handler = capture(registerInboxCheck, {
      joined: false,
      claimed: true,
      lastJoinError: null,
      claimCode: 'AB12',
    });
    const r = await handler({});
    expect(text(r)).toContain('call team_join first');
  });

  it('refuses with a claim hint while pending (unclaimed)', async () => {
    const handler = capture(registerInboxCheck, {
      joined: false,
      claimed: false,
      lastJoinError: null,
      claimCode: 'ZZ99',
    });
    const r = await handler({});
    expect(text(r)).toContain('pending presence');
    expect(text(r)).toContain('ZZ99');
    expect(text(r)).toContain("team_join {as:'Ada'}");
  });

  // ADR 254: an eligible-set act someone else answered still sits in the inbox, so it must SAY it
  // has been taken — a silent retirement leaves a mid-draft reader working on a closed question.
  describe('the eligible-set stand-down trace', () => {
    const asked = {
      id: 'el-1',
      v: 1,
      team: 'dawn',
      from: 'nick',
      to: { kind: 'team' as const },
      act: 'message' as const,
      body: 'either of you know why the daemon pinned?',
      thread: null,
      meta: { eligible: ['Ada', 'izzo'] },
      ts: 1,
    };

    it('names who took it, and says the reader no longer owes it', async () => {
      const handler = capture(
        registerInboxCheck,
        inboxClient({
          fetchInbox: (async () => ({
            messages: [asked],
            cursor: null,
            discharged: [{ id: 'el-1', by: 'izzo' }],
          })) as any,
        }),
      );
      const r = await handler({ unread_only: true, limit: 50 });
      expect(text(r)).toContain('answered by izzo');
      expect(text(r)).toContain('no longer owe');
      expect((r.structuredContent as any).messages[0].discharged_by).toBe('izzo');
    });

    it('stays silent on an act nobody has answered', async () => {
      const handler = capture(
        registerInboxCheck,
        inboxClient({
          fetchInbox: (async () => ({ messages: [asked], cursor: null, discharged: [] })) as any,
        }),
      );
      const r = await handler({ unread_only: true, limit: 50 });
      expect(text(r)).not.toContain('answered by');
      expect((r.structuredContent as any).messages[0].discharged_by).toBeUndefined();
    });

    it('degrades quietly against an older daemon that sends no trace', async () => {
      const handler = capture(
        registerInboxCheck,
        inboxClient({
          fetchInbox: (async () => ({ messages: [asked], cursor: null })) as any,
        }),
      );
      const r = await handler({ unread_only: true, limit: 50 });
      expect(text(r)).toContain('either of you know');
      expect(text(r)).not.toContain('answered by');
    });
  });

  it('reports no new messages when empty, and names the way back to what was already read', async () => {
    const handler = capture(
      registerInboxCheck,
      inboxClient({ fetchInbox: (async () => ({ messages: [], cursor: null })) as any }),
    );
    const r = await handler({ unread_only: true, limit: 50 });
    expect(text(r)).toBe(
      'no new messages — nothing waiting on you; check again at your next task boundary' +
        '\nlooking for one you already read? unread_only: false returns it',
    );
  });

  // The recall route is advice for a seat looking at the unread slice. A caller who ALREADY passed
  // unread_only: false is looking at everything there is — telling them to do what they just did
  // would be the noise this line is trying to avoid being.
  it('omits the recall route when the caller is already reading everything', async () => {
    const handler = capture(
      registerInboxCheck,
      inboxClient({ fetchInbox: (async () => ({ messages: [], cursor: null })) as any }),
    );
    const r = await handler({ unread_only: false, limit: 50 });
    expect(text(r)).toBe(
      'no new messages — nothing waiting on you; check again at your next task boundary',
    );
  });

  it('does not say the inbox is empty when unread remain behind the fetch bound', async () => {
    const handler = capture(
      registerInboxCheck,
      inboxClient({
        fetchInbox: (async () => ({
          messages: [],
          cursor: null,
          unread_remaining: 12,
        })) as any,
      }),
    );
    const r = await handler({ unread_only: true, limit: 50 });
    expect(text(r)).not.toContain('nothing waiting on you');
    expect(text(r)).toContain('12 older unread not shown');
    expect(text(r)).toContain('limit: 12');
  });

  it('names a drain limit that covers elided unread, not the fetched slice', async () => {
    const mk = (id: string, ts: number) =>
      makeEnvelope({
        id,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: id,
        ts,
      });
    const messages = Array.from({ length: 50 }, (_, i) => mk(`n${i}`, 1000 + i));
    const handler = capture(
      registerInboxCheck,
      inboxClient({
        fetchInbox: (async () => ({
          messages,
          cursor: null,
          unread_remaining: 100,
        })) as any,
      }),
    );
    const r = await handler({ unread_only: true, limit: 50 });
    expect(text(r)).toContain('100 older unread not shown');
    expect(text(r)).toContain('Call again with limit: 150');
    expect(text(r)).not.toContain('Call again with limit: 50 to');
  });

  it('merges buffered + fetched, dedups by id, sorts by ts, and advances the cursor', async () => {
    const mk = (id: string, ts: number) =>
      makeEnvelope({
        id,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'member', name: 'Ada' },
        act: 'message',
        body: id,
        ts,
      });
    const markRead = vi.fn(async () => undefined);
    const handler = capture(
      registerInboxCheck,
      inboxClient({
        drainBuffer: () => [mk('b', 2), mk('a', 1)],
        fetchInbox: (async () => ({ messages: [mk('a', 1), mk('c', 3)], cursor: null })) as any,
        markRead: markRead as any,
      }),
    );
    const r = await handler({ unread_only: true, limit: 50 });
    expect(r.structuredContent.messages.map((m: any) => m.id)).toEqual(['a', 'b', 'c']);
    expect(markRead).toHaveBeenCalledWith('c'); // newest
  });

  it('returns an error result when the fetch throws', async () => {
    const handler = capture(
      registerInboxCheck,
      inboxClient({
        fetchInbox: (async () => {
          throw new Error('boom');
        }) as any,
      }),
    );
    const r = await handler({});
    expect(text(r)).toContain('error: boom');
  });
});

describe('team_members handler', () => {
  // ADR 227 close-out: the role filter rides the wire so the daemon can audit the discovery query
  // (`roster.role_query`). The handler must PASS the arg — a local-only filter is invisible to the
  // eval. (A defensive local pass stays for older daemons that ignore `?role=`.)
  it('passes the role filter to the server instead of filtering locally', async () => {
    const calls: Array<string | undefined> = [];
    const handler = capture(registerMembers, {
      roster: (async (role?: string) => {
        calls.push(role);
        return {
          members:
            role === 'platform'
              ? [member({ name: 'izzo', role: 'platform', roles: ['platform'] })]
              : [member({ name: 'izzo', role: 'platform', roles: ['platform'] }), member()],
          roles: [{ name: 'platform', summary: 'infra toucher' }],
        };
      }) as any,
    });
    const out = text(await handler({ role: 'platform' }));
    expect(calls).toEqual(['platform']);
    expect(out).toContain('izzo');
    expect(out).not.toContain('Ada');
  });

  it('renders the known-roles hint from the server library on a miss', async () => {
    const handler = capture(registerMembers, {
      roster: (async () => ({
        members: [],
        roles: [{ name: 'platform', summary: null }],
      })) as any,
    });
    const out = text(await handler({ role: 'nonesuch' }));
    expect(out).toContain('no seat holds role "nonesuch"');
    expect(out).toContain('team roles: platform');
  });

  it('lists members with their facets, and no empty-field noise', async () => {
    const handler = capture(registerMembers, {
      roster: (async () => ({ members: [member()] })) as any,
    });
    const out = text(await handler({}));
    expect(out).toContain('Ada (agent · backend · claude-opus-5 · claude-code)');
    // the old `key=value` dump printed `role=—` / `lifecycle=forever` — an empty field is not a fact
    expect(out).not.toContain('kind=');
    expect(out).not.toContain('role=');
    expect(out).not.toContain('lifecycle=forever');
  });

  // This is the surface a seat reads before handing off or routing a review, so an unattested
  // teammate has to be visible here: ADR 158 will refuse them as an acceptor, and better to see
  // that before routing than to discover it as a silent `no_candidate`.
  it('marks a live agent attesting no model, and leaves humans and offline seats alone', async () => {
    const roster = (members: MemberSummary[]) =>
      capture(registerMembers, { roster: (async () => ({ members })) as any });

    const unattested = text(
      await roster([
        member({ presences: [{ surface: 'codex', status: 'active', last_seen_at: 0 }] }),
      ])({}),
    );
    expect(unattested).toContain('model unattested');

    // a human has no harness to attest with (ADR 121) — never marked
    const human = text(
      await roster([
        member({
          name: 'nick',
          kind: 'human',
          role: '',
          roles: [],
          presences: [{ surface: 'cli', status: 'active', last_seen_at: 0 }],
        }),
      ])({}),
    );
    expect(human).not.toContain('model unattested');

    // an offline seat attests nothing by definition — silence, not a wall of warnings
    const offline = text(
      await roster([member({ name: 'Lin', presence: 'offline', presences: [] })])({}),
    );
    expect(offline).not.toContain('model unattested');
  });

  it('renders an until-lifecycle and a not-present member, and filters by name', async () => {
    const handler = capture(registerMembers, {
      roster: (async () => ({
        members: [
          member({
            name: 'Lin',
            role: '',
            roles: [],
            lifecycle: 'until',
            lifecycle_until: 0,
            presences: [],
          }),
          member({ name: 'Ada' }),
        ],
      })) as any,
    });
    const out = text(await handler({ name: 'Lin' }));
    expect(out).toContain('Lin');
    expect(out).toContain('until 1970-01-01'); // a non-default lifecycle still says so
    expect(out).not.toContain('role='); // ...but an absent role stays silent
    expect(out).not.toContain('Ada');
  });

  it('reports when a named member is missing or roster is empty', async () => {
    const empty = capture(registerMembers, { roster: (async () => ({ members: [] })) as any });
    expect(text(await empty({}))).toBe('no members yet — team_join claims your seat');
    const named = capture(registerMembers, {
      roster: (async () => ({ members: [member()] })) as any,
    });
    expect(text(await named({ name: 'Zed' }))).toBe(
      'no member "Zed" — team_status lists the roster',
    );
  });

  it('filters by role, leading with the role summary (ADR 227 discovery)', async () => {
    const handler = capture(registerMembers, {
      roster: (async () => ({
        members: [
          member({ name: 'izzo', role: 'platform', roles: ['platform'] }),
          member({ name: 'miley', role: 'designer', roles: ['designer', 'platform'] }),
          member({ name: 'dolly', role: '', roles: [] }),
        ],
        roles: [{ name: 'platform', summary: 'Designated toucher of running infrastructure' }],
      })) as any,
    });
    const out = text(await handler({ role: 'platform' }));
    expect(out).toContain('platform — Designated toucher of running infrastructure');
    expect(out).toContain('izzo');
    expect(out).toContain('miley'); // multi-role holder matches too
    expect(out).not.toContain('dolly');
  });

  it('renders every held role on a multi-role seat', async () => {
    const handler = capture(registerMembers, {
      roster: (async () => ({
        members: [member({ name: 'miley', role: 'designer', roles: ['designer', 'platform'] })],
      })) as any,
    });
    expect(text(await handler({}))).toContain('designer+platform');
  });

  it('names the team roles in the no-holder empty state', async () => {
    const handler = capture(registerMembers, {
      roster: (async () => ({
        members: [member()],
        roles: [
          { name: 'admin', summary: null },
          { name: 'observer', summary: 'You watch, you do not act' },
        ],
      })) as any,
    });
    expect(text(await handler({ role: 'platform' }))).toBe(
      'no seat holds role "platform" — team roles: admin, observer',
    );
  });

  it('appends the quiescence read when the daemon serves one (ADR 219 liveness trio)', async () => {
    const handler = capture(registerMembers, {
      roster: (async () => ({
        members: [
          member({
            quiescence: { state: 'quiet', quiet_for_ms: 120_000, source: 'audit' },
          }),
        ],
      })) as any,
    });
    expect(text(await handler({}))).toContain('quiet 2m');
  });

  it('returns an error result when roster throws', async () => {
    const handler = capture(registerMembers, {
      roster: (async () => {
        throw new Error('offline');
      }) as any,
    });
    expect(text(await handler({}))).toContain('error: offline');
  });
});

describe('build skew warning (ADR 135)', () => {
  const sha = (c: string) => c.repeat(40);
  const rosterOk = (async () => ({
    members: [member({ name: 'Ada', presence: 'online' })],
  })) as any;

  it('team_status appends the differs-from-daemon warning when builds mismatch', async () => {
    const handler = capture(registerStatus, {
      roster: rosterOk,
      build: sha('a'),
      daemonBuild: (async () => sha('b')) as any,
    });
    const out = text(await handler({}));
    expect(out).toContain('differs from the daemon');
    expect(out).toContain(sha('a').slice(0, 7));
    expect(out).toContain(sha('b').slice(0, 7));
    expect(out).toContain('/mcp reload');
  });

  it('stays silent when the builds match', async () => {
    const handler = capture(registerStatus, {
      roster: rosterOk,
      build: sha('a'),
      daemonBuild: (async () => sha('a')) as any,
    });
    expect(text(await handler({}))).not.toContain('differs from the daemon');
  });

  it('stays silent when either side is unknown (unstamped adapter / unreachable daemon)', async () => {
    const unstamped = capture(registerStatus, {
      roster: rosterOk,
      build: undefined,
      daemonBuild: (async () => sha('b')) as any,
    });
    expect(text(await unstamped({}))).not.toContain('differs');
    const noDaemon = capture(registerStatus, {
      roster: rosterOk,
      build: sha('a'),
      daemonBuild: (async () => undefined) as any,
    });
    expect(text(await noDaemon({}))).not.toContain('differs');
  });
});

describe('team_status handler', () => {
  it('renders online (with surface) and offline members', async () => {
    const handler = capture(registerStatus, {
      roster: (async () => ({
        members: [
          member({ name: 'Ada', presence: 'online' }),
          member({
            name: 'nick',
            kind: 'human',
            role: '',
            roles: [],
            presence: 'offline',
            presences: [],
          }),
        ],
      })) as any,
    });
    const out = text(await handler({}));
    expect(out).toContain('2 members · 1 present');
    expect(out).toContain('Ada (agent · backend · claude-opus-5 · claude-code)');
    expect(out).toContain('here:');
    expect(out).toContain('out:');
    expect(out).toContain('nick (human)');
  });

  /** ADR 237 decision 3 — reads carry the eviction. The incident's session read "you are ryder"
   *  unqualified for twenty minutes while the client knew the eviction the whole time. */
  it('leads with the eviction banner when this session was superseded', async () => {
    const handler = capture(registerStatus, {
      member: 'ryder',
      lastJoinError: 'superseded: your session as ryder was taken over by a newer one',
      roster: (async () => ({
        members: [member({ name: 'ryder', presence: 'online' })],
      })) as any,
    });
    const out = text(await handler({}));
    expect(out).toContain('evicted from its seat');
    expect(out).toContain('reflects whoever holds it now');
    expect(out).toContain('taken over by a newer one'); // the raw refusal rides along as detail
    // The banner LEADS — before the roster, not appended where a skimming reader stops early.
    expect(out.indexOf('evicted')).toBeLessThan(out.indexOf('1 member'));
  });

  it('renders the roster unqualified when the last join error is not an eviction', async () => {
    const handler = capture(registerStatus, {
      member: 'ryder',
      lastJoinError: 'pending approval — request 42 (an admin must approve)',
      roster: (async () => ({
        members: [member({ name: 'ryder', presence: 'online' })],
      })) as any,
    });
    expect(text(await handler({}))).not.toContain('evicted');
  });

  it('renders the roster unqualified when no join ever failed', async () => {
    const handler = capture(registerStatus, {
      member: 'ryder',
      lastJoinError: null,
      roster: (async () => ({
        members: [member({ name: 'ryder', presence: 'online' })],
      })) as any,
    });
    expect(text(await handler({}))).not.toContain('evicted');
  });

  it('tells an agent what its teammates are working on — the point of a coordination roster', async () => {
    const handler = capture(registerStatus, {
      member: 'Lin',
      roster: (async () => ({
        members: [
          member({
            name: 'Ada',
            presence: 'online',
            activity: 'working',
            state: 'refactoring the wake ledger',
          }),
        ],
      })) as any,
    });
    const out = text(await handler({}));
    // the old tool could say Ada was *online* but never what she was *doing*
    expect(out).toContain('refactoring the wake ledger');
    expect(out).toContain('working:');
    expect(out).toContain('you are Lin');
  });

  it('reports no members and surfaces errors', async () => {
    const empty = capture(registerStatus, { roster: (async () => ({ members: [] })) as any });
    expect(text(await empty({}))).toBe('no members yet — team_join claims your seat');
    const err = capture(registerStatus, {
      roster: (async () => {
        throw new Error('down');
      }) as any,
    });
    expect(text(await err({}))).toContain('error: down');
  });
});

describe('team_wake_context (ADR 209)', () => {
  it('refuses before join and returns only bounded fields after join', async () => {
    const dormant = capture(registerWakeContext, { holdsSeat: false });
    expect(text(await dormant({ act_id: 'a1' }))).toContain('team_join');

    const wakeContext = vi.fn(async () => ({
      version: 1,
      wake: { kind: 'reply', act_id: 'a1' },
      objective: { action: 'reply' },
      state: { memory: { headline: 'safe headline', saved_at: 1, size_bytes: 32 } },
      fetch: ['inbox_thread', 'seat_memory'],
      delivery: { requirement: 'portable', intended: 'fresh' },
    }));
    const handler = capture(registerWakeContext, { holdsSeat: true, wakeContext } as any);
    const result = await handler({ act_id: 'a1' });
    expect(wakeContext).toHaveBeenCalledWith({ act_id: 'a1' });
    expect(text(result)).toContain('next action: reply');
    expect(text(result)).toContain('team_memory_read');
    expect(result.structuredContent.context.wake).toEqual({ kind: 'reply', act_id: 'a1' });
  });

  it('requires exactly one canonical target', async () => {
    const handler = capture(registerWakeContext, { holdsSeat: true } as any);
    expect(text(await handler({}))).toContain('exactly one');
    expect(text(await handler({ act_id: 'a1', lane_id: 'l1' }))).toContain('exactly one');
  });
});

describe('team_memory handlers (ADR 093)', () => {
  it('memoryLine renders headline + age + the read pointer, never the body', () => {
    const line = memoryLine(
      { headline: 'mid-refactor of ws.ts eviction, tests red', saved_at: 1000, size_bytes: 2048 },
      1000 + 2 * 3600_000,
    );
    expect(line).toBe(
      'Saved memory from 2h ago: "mid-refactor of ws.ts eviction, tests red" — ' +
        'team_memory_read to load it (2048 bytes).',
    );
  });

  it('save and read refuse while not joined (dormant guard)', async () => {
    const handlers = captureAll(registerMemory, {
      joined: false,
      claimed: true,
      lastJoinError: null,
      claimCode: 'AB12',
    });
    expect(text(await handlers['team_memory_save']!({ headline: 'h' }))).toContain(
      'call team_join first',
    );
    expect(text(await handlers['team_memory_read']!({}))).toContain('call team_join first');
  });

  it('save forwards headline + body and echoes the headline back', async () => {
    const saveMemory = vi.fn(async () => undefined);
    const handlers = captureAll(registerMemory, {
      joined: true,
      holdsSeat: true,
      saveMemory: saveMemory as any,
    });
    const out = text(
      await handlers['team_memory_save']!({ headline: 'wrapping up', body: 'left off at X' }),
    );
    expect(saveMemory).toHaveBeenCalledWith({ headline: 'wrapping up', body: 'left off at X' });
    expect(out).toContain('memory saved');
    expect(out).toContain('"wrapping up"');
  });

  it('save surfaces the server cap error (limit named, not swallowed)', async () => {
    const handlers = captureAll(registerMemory, {
      joined: true,
      holdsSeat: true,
      saveMemory: (async () => {
        throw new Error('memory body is 9000 bytes; the limit is 8192');
      }) as any,
    });
    expect(text(await handlers['team_memory_save']!({ headline: 'h', body: 'big' }))).toContain(
      'the limit is 8192',
    );
  });

  it('read renders headline + age, then the body', async () => {
    const handlers = captureAll(registerMemory, {
      joined: true,
      holdsSeat: true,
      readMemory: (async () => ({
        headline: 'mid-refactor',
        body: 'tests red in ws.test.ts',
        saved_at: Date.now() - 90_000,
      })) as any,
    });
    const out = text(await handlers['team_memory_read']!({}));
    expect(out).toContain('memory (saved 1m ago): mid-refactor');
    expect(out).toContain('tests red in ws.test.ts');
  });

  // An absent note is an EMPTY STATE, not a failure (ADR 144 inc 4). The daemon's 404 is the right
  // HTTP answer, but rendering it through errorResult made a first-ever read count as a tool error
  // — inflating the error rate the increment is measured against. Empty states name the next action.
  it('read presents a seat with nothing saved as an empty state, not an error', async () => {
    const handlers = captureAll(registerMemory, {
      joined: true,
      holdsSeat: true,
      readMemory: (async () => {
        throw new Error('no memory saved for this seat');
      }) as any,
    });
    const out = await handlers['team_memory_read']!({});
    expect(text(out)).toContain('no memory saved for this seat yet');
    expect(text(out)).toContain('team_memory_save'); // names the next action
    expect(text(out).startsWith('error:')).toBe(false); // would classify as `error` in telemetry
  });

  it('read still surfaces a real failure as an error', async () => {
    const handlers = captureAll(registerMemory, {
      joined: true,
      holdsSeat: true,
      readMemory: (async () => {
        throw new Error('daemon unreachable');
      }) as any,
    });
    expect(text(await handlers['team_memory_read']!({})).startsWith('error:')).toBe(true);
  });
});

describe('team_join handler (claim-on-first-use overload, ADR 032)', () => {
  // claimAndJoin persists the claimed seat to <cwd>/.musterd — keep that off the real tree.
  let tmpCwd: string;
  beforeEach(() => {
    tmpCwd = mkdtempSync(pathJoin(tmpdir(), 'musterd-join-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpCwd);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  /**
   * A pending (unclaimed) client whose v0.3 `join()` resolves the seat from the config's claim policy
   * (seat → that name; role → next free `<role>-<n>` against the roster), mirroring an `occupied` frame.
   * Pass the SAME config object that `capture()` gets, since `claimAndJoin` mutates `config.claim`.
   */
  function pendingClient(
    cfg: McpConfig,
    over: Partial<MusterdClient> = {},
  ): Partial<MusterdClient> {
    let member: string | undefined;
    const roster = (over.roster ?? (async () => ({ members: [] }))) as MusterdClient['roster'];
    return {
      joined: false,
      memory: null,
      get claimed() {
        return Boolean(member);
      },
      get member() {
        return member;
      },
      claimCode: cfg.claimCode,
      roster,
      join: (async () => {
        const c = cfg.claim;
        if (c.mode === 'seat') member = c.name;
        else if (c.mode === 'role') {
          const { members } = await roster();
          member = nextRoleHandle(c.role, new Set(members.map((m) => m.name)));
        }
      }) as any,
      ...over,
    };
  }

  it('is idempotent when already joined', async () => {
    const join = vi.fn(async () => undefined);
    const handler = capture(
      registerJoin,
      { joined: true, holdsSeat: true, join: join as any, memory: null },
      config,
    );
    expect(text(await handler({}))).toContain('Already joined dawn as Ada');
    expect(join).not.toHaveBeenCalled();
  });

  it('already-joined still shows the memory one-liner (a background approval may have occupied silently)', async () => {
    const handler = capture(
      registerJoin,
      {
        joined: true,
        holdsSeat: true,
        charter: 'Own the rails.',
        memory: { headline: 'mid-refactor', saved_at: Date.now() - 60_000, size_bytes: 7 },
      },
      config,
    );
    const out = text(await handler({}));
    expect(out).toContain('Already joined dawn as Ada');
    expect(out).toContain('Your Team Role charter:\nOwn the rails.');
    expect(out).toContain('Saved memory from 1m ago: "mid-refactor"');
  });

  it('claims a named seat with {as} and returns the stay-in-sync guidance', async () => {
    const cfg = { ...config, member: undefined };
    const handler = capture(registerJoin, pendingClient(cfg), cfg);
    const out = text(await handler({ as: 'Ada' }));
    expect(out).toContain('Joined dawn as Ada (claude-code)');
    expect(out).toContain('team_inbox_check');
  });

  it('surfaces the Team Role charter delivered by authenticated occupancy', async () => {
    const cfg = { ...config, member: undefined };
    const handler = capture(
      registerJoin,
      pendingClient(cfg, { charter: 'Own the rails. Ask before changing deployment.' } as never),
      cfg,
    );

    const out = text(await handler({ as: 'Ada' }));

    expect(out).toContain('Your Team Role charter:');
    expect(out).toContain('Own the rails. Ask before changing deployment.');
    expect(out).not.toContain('charter + the team working-loop are in AGENTS.md');
  });

  it('renders the saved-memory one-liner when the occupy delivered an envelope (ADR 093)', async () => {
    const cfg = { ...config, member: undefined };
    const handler = capture(
      registerJoin,
      pendingClient(cfg, {
        memory: {
          headline: 'mid-refactor, tests red',
          saved_at: Date.now() - 3600_000,
          size_bytes: 512,
        },
      }),
      cfg,
    );
    const out = text(await handler({ as: 'Ada' }));
    expect(out).toContain('Saved memory from 1h ago: "mid-refactor, tests red"');
    expect(out).toContain('team_memory_read');
  });

  it('omits the memory line when the seat has nothing saved', async () => {
    const cfg = { ...config, member: undefined };
    const handler = capture(registerJoin, pendingClient(cfg), cfg);
    expect(text(await handler({ as: 'Ada' }))).not.toContain('Saved memory');
  });

  it('claims the next open pool seat with {role}', async () => {
    const cfg = { ...config, member: undefined, claim: { mode: 'chat' as const } };
    const handler = capture(
      registerJoin,
      pendingClient(cfg, {
        roster: (async () => ({ members: [{ name: 'backend-1' }] })) as any,
      }),
      cfg,
    );
    const out = text(await handler({ role: 'backend' }));
    expect(out).toContain('Joined dawn as backend-2 (role backend)');
  });

  it('occupies the folder seat policy on bare team_join {} (back-compat)', async () => {
    // A folder bound to seat:Ada → bare {} claims that policy seat (v0.3: no mint, no re-mint).
    const cfg = { ...config, member: undefined }; // claim: { seat: 'Ada' }
    const handler = capture(registerJoin, pendingClient(cfg), cfg);
    const out = text(await handler({}));
    expect(out).toContain('Joined dawn as Ada');
  });

  it('asks the session to name itself when policy is chat and no target is given', async () => {
    const cfg = {
      ...config,
      member: undefined,
      claim: { mode: 'chat' as const },
      claimCode: 'ZZ99',
    };
    const handler = capture(registerJoin, pendingClient(cfg), cfg);
    const out = text(await handler({}));
    expect(out).toContain('pending presence');
    expect(out).toContain('ZZ99');
    expect(out).toContain("team_join {as:'Ada'}");
  });

  it('follows the folder seat policy when no target is given', async () => {
    const cfg = { ...config, member: undefined, claim: { mode: 'seat' as const, name: 'Polly' } };
    const handler = capture(registerJoin, pendingClient(cfg), cfg);
    const out = text(await handler({}));
    expect(out).toContain('Joined dawn as Polly');
  });

  it('refuses a seat already occupied by another session (claim_conflict)', async () => {
    const cfg = { ...config, member: undefined };
    const handler = capture(
      registerJoin,
      pendingClient(cfg, {
        roster: (async () => ({ members: [{ name: 'Ada' }, { name: 'Bo' }] })) as any,
        join: (async () => {
          throw new Error('claim_conflict: seat "Ada" is occupied');
        }) as any,
      }),
      cfg,
    );
    const out = text(await handler({ as: 'Ada' }));
    expect(out).toContain("Can't claim that seat");
    expect(out).toContain('Ada, Bo'); // the offered roster
  });
});

describe('team_leave handler', () => {
  it('reports nothing to leave when not joined', async () => {
    const leave = vi.fn();
    const handler = capture(registerLeave, { joined: false, leave }, config);
    expect(text(await handler({}))).toContain('nothing to leave');
    expect(leave).not.toHaveBeenCalled();
  });

  it('leaves and explains the held seat', async () => {
    const leave = vi.fn();
    const handler = capture(registerLeave, { joined: true, holdsSeat: true, leave }, config);
    expect(text(await handler({}))).toContain('Left dawn');
    expect(leave).toHaveBeenCalledTimes(1);
  });
});

describe('lane_resolve handler (branch cleanup hint, ADR 106)', () => {
  function lane(over: Partial<Lane> = {}): Lane {
    return {
      id: 'lane1',
      team: 'dawn',
      project: 'default',
      title: 'the work',
      detail: null,
      owner_seat: 'Ada',
      role: null,
      scope: [],
      depends_on: [],
      branch: null,
      goal_id: null,
      state: 'done',
      created_by: 'Ada',
      created_at: 0,
      claimed_at: null,
      resolved_at: null,
      updated_at: 0,
      ...over,
    };
  }

  it('prints the local-branch cleanup command when the resolved lane carries a branch', async () => {
    const updateLane = vi.fn(async () => ({ lane: lane({ branch: 'feat/x' }), warnings: [] }));
    const handlers = captureAll(registerLanes, { updateLane } as Partial<MusterdClient>);
    const out = text(await handlers['lane_resolve']!({ id: 'lane1' }));
    expect(out).toContain('lane done');
    expect(out).toContain('git branch -D feat/x');
    expect(out).toContain('git switch --detach origin/main');
    expect(updateLane).toHaveBeenCalledWith('lane1', { state: 'done' });
  });

  /**
   * The adapter runs in the seat's own workspace, so it — not the daemon — is what knows the repo.
   * `MUSTERD_PROJECT` stands in for the derivation here; the derivation itself is covered in
   * `@musterd/protocol`'s project tests (including the worktree case).
   */
  it('lane_open stamps the derived project, and an explicit project still wins', async () => {
    const openLane = vi.fn(async () => ({ lane: lane(), warnings: [] }));
    const handlers = captureAll(registerLanes, { openLane } as Partial<MusterdClient>);
    process.env['MUSTERD_PROJECT'] = 'derived';
    await handlers['lane_open']!({ title: 'a' });
    await handlers['lane_open']!({ title: 'b', project: 'explicit' });
    delete process.env['MUSTERD_PROJECT'];
    expect(openLane).toHaveBeenNthCalledWith(1, { title: 'a', project: 'derived' });
    expect(openLane).toHaveBeenNthCalledWith(2, { title: 'b', project: 'explicit' });
  });

  it('omits the hint for a branchless lane', async () => {
    const updateLane = vi.fn(async () => ({ lane: lane({ branch: null }), warnings: [] }));
    const handlers = captureAll(registerLanes, { updateLane } as Partial<MusterdClient>);
    const out = text(await handlers['lane_resolve']!({ id: 'lane1' }));
    expect(out).toContain('lane done');
    expect(out).not.toContain('git branch -D');
  });

  it('passes the merge attestation through as merged {pr, sha, authorized_by} (ADR 109)', async () => {
    // Worker self-close. A counterpart omits these fields (ADR 305); the server ignores them if sent.
    const updateLane = vi.fn(async () => ({ lane: lane({ branch: 'feat/x' }), warnings: [] }));
    const handlers = captureAll(
      (s: any, c: any) => registerLanes(s, c, async () => 'ancestor' as any),
      { updateLane } as Partial<MusterdClient>,
    );
    await handlers['lane_resolve']!({
      id: 'lane1',
      pr: 167,
      sha: 'abc123f',
      authorized_by: 'nick',
    });
    expect(updateLane).toHaveBeenCalledWith('lane1', {
      state: 'done',
      merged: { pr: 167, sha: 'abc123f', authorized_by: 'nick', verification: 'ancestor' },
    });
  });

  it('omits merged entirely when no attestation fields are given', async () => {
    const updateLane = vi.fn(async () => ({ lane: lane(), warnings: [] }));
    const handlers = captureAll(registerLanes, { updateLane } as Partial<MusterdClient>);
    await handlers['lane_resolve']!({ id: 'lane1' });
    expect(updateLane).toHaveBeenCalledWith('lane1', { state: 'done' });
  });

  /**
   * The close nudge reports the RECORDED reason (ADR 283), not ownership.
   *
   * `lane_submit` already refuses to conflate the by-design exemption with the ADR 172
   * degradation — "no ask by DESIGN ... and the wording must not conflate them". The resolve side
   * fired on `owner_seat === member` alone, so an exempt lane was told "unconfirmed close
   * recorded — prefer lane_submit" moments after submit told it "none is owed: lane_resolve when
   * ready". Two calls, opposite instructions, over a close the ledger had already labelled
   * `acceptance_exempt` — and it defeated the reason `close_records` is sent at submit at all:
   * so the ledger label is never a surprise found afterwards.
   */
  it('names the exemption instead of calling a by-design close unconfirmed (ADR 234/283)', async () => {
    const updateLane = vi.fn(async () => ({
      lane: lane({ owner_seat: 'Ada' }),
      warnings: [],
      closed: { verified: false, reason: 'acceptance_exempt' as const },
    }));
    const handlers = captureAll(registerLanes, {
      updateLane,
      member: 'Ada',
    } as Partial<MusterdClient>);
    const out = text(await handlers['lane_resolve']!({ id: 'lane1' }));
    expect(out).toContain('acceptance_exempt');
    expect(out).toContain('no acceptance was owed');
    // The degradation vocabulary must not appear: this close degraded nothing.
    expect(out).not.toContain('unconfirmed');
    expect(out).not.toContain('prefer lane_submit');
  });

  it('still nudges the owner on a self-close that WAS owed an acceptance', async () => {
    const updateLane = vi.fn(async () => ({
      lane: lane({ owner_seat: 'Ada' }),
      warnings: [],
      closed: { verified: false, reason: 'review_timeout' as const },
    }));
    const handlers = captureAll(registerLanes, {
      updateLane,
      member: 'Ada',
    } as Partial<MusterdClient>);
    const out = text(await handlers['lane_resolve']!({ id: 'lane1' }));
    expect(out).toContain('unconfirmed close recorded');
    expect(out).toContain('prefer lane_submit');
  });

  /**
   * An older daemon sends no `closed` block. Abstaining would drop the ADR 192 nudge for every
   * seat on a lagging daemon, so absence keeps the pre-existing ownership-based advice — the
   * same "the fallback is the safe one" discipline the backstop field documents.
   */
  it('falls back to the ownership nudge when the daemon reports no close reason', async () => {
    const updateLane = vi.fn(async () => ({ lane: lane({ owner_seat: 'Ada' }), warnings: [] }));
    const handlers = captureAll(registerLanes, {
      updateLane,
      member: 'Ada',
    } as Partial<MusterdClient>);
    const out = text(await handlers['lane_resolve']!({ id: 'lane1' }));
    expect(out).toContain('unconfirmed close recorded');
  });

  it('says nothing about acceptance when a counterpart closed the lane', async () => {
    const updateLane = vi.fn(async () => ({
      lane: lane({ owner_seat: 'Bo' }),
      warnings: [],
      closed: { verified: true, reason: 'counterpart_confirm' as const },
    }));
    const handlers = captureAll(registerLanes, {
      updateLane,
      member: 'Ada',
    } as Partial<MusterdClient>);
    const out = text(await handlers['lane_resolve']!({ id: 'lane1' }));
    expect(out).not.toContain('unconfirmed');
    expect(out).not.toContain('no acceptance was owed');
  });
});

describe('value layer: goal outcome + review debt + claim-time linking', () => {
  function vlLane(over: Partial<Lane> = {}): Lane {
    return {
      id: 'lane1',
      team: 'dawn',
      project: 'default',
      title: 'the work',
      detail: null,
      owner_seat: 'Ada',
      role: null,
      scope: [],
      depends_on: [],
      branch: null,
      goal_id: null,
      state: 'done',
      created_by: 'Ada',
      created_at: 0,
      claimed_at: null,
      resolved_at: null,
      updated_at: 0,
      ...over,
    };
  }

  it('team_goal_outcome round-trips and renders the note', async () => {
    const goalOutcome = vi.fn(async () => ({
      goal: {
        id: 'g1',
        title: 'G1',
        wave: null,
        depends_on: [],
        declared_by: 'nick',
        declared_at: 0,
        status: 'shipped',
        epoch: 0,
        outcome: { text: 'users can now X', by: 'stanley', at: 5 },
      },
    }));
    const { registerGoals } = await import('./goals.js');
    const handlers = captureAll(registerGoals, { goalOutcome } as Partial<MusterdClient>);
    const out = text(
      await handlers['team_goal_outcome']!({ goal_id: 'g1', outcome: 'users can now X' }),
    );
    expect(goalOutcome).toHaveBeenCalledWith({ goal_id: 'g1', outcome: 'users can now X' });
    expect(out).toContain('outcome recorded');
    expect(out).toContain('users can now X');
  });

  it('team_goal_outcome says so when the goal is not yet declared', async () => {
    const goalOutcome = vi.fn(async () => ({ goal: null }));
    const { registerGoals } = await import('./goals.js');
    const handlers = captureAll(registerGoals, { goalOutcome } as Partial<MusterdClient>);
    const out = text(await handlers['team_goal_outcome']!({ goal_id: 'ghost', outcome: 'x' }));
    expect(out).toContain('queued');
  });

  it('team_goal_retract round-trips and renders the withdrawal', async () => {
    const goalRetract = vi.fn(async () => ({
      goal: {
        id: 'g1',
        title: 'G1',
        wave: null,
        depends_on: [],
        declared_by: 'nick',
        declared_at: 0,
        status: 'planned',
        epoch: 0,
        retracted: { by: 'dolly', at: 5 },
      },
    }));
    const { registerGoals } = await import('./goals.js');
    const handlers = captureAll(registerGoals, { goalRetract } as Partial<MusterdClient>);
    const out = text(await handlers['team_goal_retract']!({ goal_id: 'g1' }));
    expect(goalRetract).toHaveBeenCalledWith({ goal_id: 'g1' });
    expect(out).toContain('goal retracted');
    expect(out).toContain('retracted by dolly');
  });

  it('team_goals hides retracted goals by default and counts them', async () => {
    const base = {
      title: 'T',
      wave: null,
      depends_on: [],
      declared_by: 'nick',
      declared_at: 0,
      status: 'planned',
      epoch: 0,
    };
    const goals = vi.fn(async () => ({
      goals: [
        { ...base, id: 'live' },
        { ...base, id: 'gone', retracted: { by: 'dolly', at: 5 } },
      ],
    }));
    const { registerGoals } = await import('./goals.js');
    const handlers = captureAll(registerGoals, { goals } as Partial<MusterdClient>);
    const out = text(await handlers['team_goals']!({}));
    expect(out).toContain('live');
    expect(out).not.toContain('gone [');
    expect(out).toContain('1 retracted');
    const all = text(await handlers['team_goals']!({ include_retracted: true }));
    expect(all).toContain('gone');
  });

  it('lane_claim passes goal_id through to updateLane in the same call', async () => {
    const updateLane = vi.fn(async () => ({ lane: vlLane({ goal_id: 'g1' }), warnings: [] }));
    const handlers = captureAll(registerLanes, {
      member: 'Ada',
      updateLane,
    } as Partial<MusterdClient>);
    await handlers['lane_claim']!({ id: 'lane1', goal_id: 'g1' });
    expect(updateLane).toHaveBeenCalledWith('lane1', { owner_seat: 'Ada', goal_id: 'g1' });
    await handlers['lane_claim']!({ id: 'lane1' });
    expect(updateLane).toHaveBeenLastCalledWith('lane1', { owner_seat: 'Ada' });
  });

  it('lane_resolve renders notices from the response (the ship nudge reaches the closer)', async () => {
    const updateLane = vi.fn(async () => ({
      lane: vlLane(),
      warnings: [],
      notices: ['goal "g2" just shipped — say what changed for a user: team_goal_outcome {…}'],
    }));
    const handlers = captureAll(registerLanes, { updateLane } as Partial<MusterdClient>);
    const out = text(await handlers['lane_resolve']!({ id: 'lane1' }));
    expect(out).toContain('just shipped');
    expect(out).toContain('team_goal_outcome');
  });

  it('team_next renders review debt with age', async () => {
    const next = vi.fn(async () => ({
      member: 'Ada',
      in_flight: [],
      shipped: [],
      up_next: [],
      owed_reviews: [],
      why: null,
      next_goal: null,
      goals: [],
      review_debt: [{ id: 'laneZ', title: 'stuck work', owner: 'June', waited_ms: 26 * 3_600_000 }],
    }));
    const handlers = captureAll(registerLanes, { next } as Partial<MusterdClient>);
    const out = text(await handlers['team_next']!({}));
    expect(out).toContain('review debt');
    expect(out).toContain('stuck work');
    expect(out).toMatch(/26h/);
    // The owner is the field that reveals whose work this is — dropping it invited
    // silent self-acceptance whenever a stale brief still listed the reader's own lane.
    expect(out).toContain('owner=June');
  });
});

describe('lane_submit merge verification (merge-verified submit)', () => {
  const submittedLane: Lane = {
    id: 'L1',
    team: 'dawn',
    project: 'default',
    title: 't',
    detail: null,
    owner_seat: 'Ada',
    role: null,
    scope: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    state: 'awaiting_acceptance',
    created_by: 'Ada',
    created_at: 0,
    claimed_at: null,
    resolved_at: null,
    updated_at: 0,
  };

  function submitWith(tier: string) {
    const updateLane = vi.fn(async () => ({ lane: submittedLane, warnings: [] }));
    const handlers = captureAll((s: any, c: any) => registerLanes(s, c, async () => tier as any), {
      updateLane,
    } as Partial<MusterdClient>);
    return { submit: handlers['lane_submit']!, updateLane };
  }

  it('refuses pr without sha — an open PR is not a landed artifact', async () => {
    const { submit, updateLane } = submitWith('ancestor');
    const out = text(await submit({ id: 'L1', pr: 42 }));
    expect(out).toMatch(/open PR/i);
    expect(out).toMatch(/arm auto-merge/i);
    expect(updateLane).not.toHaveBeenCalled();
  });

  it('refuses a malformed sha before any lane mutation', async () => {
    const { submit, updateLane } = submitWith('ancestor');
    const out = text(await submit({ id: 'L1', sha: 'not-a-sha!' }));
    expect(out).toMatch(/not a git SHA/i);
    expect(updateLane).not.toHaveBeenCalled();
  });

  it('refuses not_ancestor with actionable guidance and no lane mutation', async () => {
    const { submit, updateLane } = submitWith('not_ancestor');
    const out = text(await submit({ id: 'L1', sha: 'abc123f' }));
    expect(out).toContain('not on origin/main');
    expect(out).toContain('arm auto-merge');
    expect(updateLane).not.toHaveBeenCalled();
  });

  it('proceeds on ancestor and stamps the tier on the attestation', async () => {
    const { submit, updateLane } = submitWith('ancestor');
    await submit({ id: 'L1', pr: 42, sha: 'abc123f' });
    expect(updateLane).toHaveBeenCalledWith('L1', {
      state: 'awaiting_acceptance',
      merged: { pr: 42, sha: 'abc123f', verification: 'ancestor' },
    });
  });

  it('proceeds on fetch_failed (degrade, never wedge) with the tier recorded', async () => {
    const { submit, updateLane } = submitWith('fetch_failed');
    await submit({ id: 'L1', sha: 'abc123f' });
    expect(updateLane).toHaveBeenCalledWith('L1', {
      state: 'awaiting_acceptance',
      merged: { sha: 'abc123f', verification: 'fetch_failed' },
    });
  });

  it('artifact-less submit proceeds, stamped unattested', async () => {
    const { submit, updateLane } = submitWith('unattested');
    await submit({ id: 'L1' });
    expect(updateLane).toHaveBeenCalledWith('L1', {
      state: 'awaiting_acceptance',
      merged: { verification: 'unattested' },
    });
  });
});

describe('lane_resolve merge verification (done means landed — the #997/#998 aliasing)', () => {
  // lane_submit verified its attestation while lane_resolve — the worker self-close that writes
  // the SAME merged object — verified nothing. Two lanes sat `done` for 3 days with open PRs
  // while five seats cited the unmerged page. Resolve now runs the same checks as submit.
  const doneLane: Lane = {
    id: 'L1',
    team: 'dawn',
    project: 'default',
    title: 't',
    detail: null,
    owner_seat: 'Ada',
    role: null,
    scope: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    state: 'done',
    created_by: 'Ada',
    created_at: 0,
    claimed_at: null,
    resolved_at: null,
    updated_at: 0,
  };

  function resolveWith(tier: string) {
    const updateLane = vi.fn(async () => ({ lane: doneLane, warnings: [] }));
    const handlers = captureAll((s: any, c: any) => registerLanes(s, c, async () => tier as any), {
      updateLane,
    } as Partial<MusterdClient>);
    return { resolve: handlers['lane_resolve']!, updateLane };
  }

  it('refuses pr without sha — an open PR is not a landed artifact', async () => {
    const { resolve, updateLane } = resolveWith('ancestor');
    const out = text(await resolve({ id: 'L1', pr: 997 }));
    expect(out).toMatch(/open PR/i);
    expect(updateLane).not.toHaveBeenCalled();
  });

  it('refuses a malformed sha before any lane mutation', async () => {
    const { resolve, updateLane } = resolveWith('ancestor');
    const out = text(await resolve({ id: 'L1', sha: 'not-a-sha!' }));
    expect(out).toMatch(/not a git SHA/i);
    expect(updateLane).not.toHaveBeenCalled();
  });

  it('refuses not_ancestor — done with an unlanded attestation is the aliasing itself', async () => {
    const { resolve, updateLane } = resolveWith('not_ancestor');
    const out = text(await resolve({ id: 'L1', sha: 'abc123f' }));
    expect(out).toContain('not on origin/main');
    expect(updateLane).not.toHaveBeenCalled();
  });

  it('proceeds on ancestor and stamps the tier on the attestation', async () => {
    const { resolve, updateLane } = resolveWith('ancestor');
    await resolve({ id: 'L1', pr: 42, sha: 'abc123f' });
    expect(updateLane).toHaveBeenCalledWith('L1', {
      state: 'done',
      merged: { pr: 42, sha: 'abc123f', verification: 'ancestor' },
    });
  });

  it('proceeds on fetch_failed (degrade, never wedge) with the tier recorded', async () => {
    const { resolve, updateLane } = resolveWith('fetch_failed');
    await resolve({ id: 'L1', sha: 'abc123f' });
    expect(updateLane).toHaveBeenCalledWith('L1', {
      state: 'done',
      merged: { sha: 'abc123f', verification: 'fetch_failed' },
    });
  });

  it('an attestation-less resolve still sends no merged object (counterpart accepts, ADR 305)', async () => {
    const { resolve, updateLane } = resolveWith('unattested');
    await resolve({ id: 'L1' });
    expect(updateLane).toHaveBeenCalledWith('L1', { state: 'done' });
  });

  it('an attestation without a sha is stamped unattested, same as submit', async () => {
    const { resolve, updateLane } = resolveWith('ancestor');
    await resolve({ id: 'L1', authorized_by: 'nick' });
    expect(updateLane).toHaveBeenCalledWith('L1', {
      state: 'done',
      merged: { authorized_by: 'nick', verification: 'unattested' },
    });
  });
});
