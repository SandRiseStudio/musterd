import { makeEnvelope, type Envelope, type MemberSummary } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { formatMessage, notJoinedMessage, textResult } from './format.js';
import { registerInboxCheck } from './inboxCheck.js';
import { registerJoin } from './join.js';
import { registerLeave } from './leave.js';
import { registerMembers } from './members.js';
import { registerSend } from './send.js';
import { registerStatus } from './status.js';

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

const config: McpConfig = {
  server: 'http://x',
  team: 'dawn',
  member: 'Ada',
  token: 't',
  surface: 'claude-code',
};

function member(over: Partial<MemberSummary> = {}): MemberSummary {
  return {
    id: 'm1',
    team: 'dawn',
    name: 'Ada',
    kind: 'agent',
    role: 'backend',
    lifecycle: 'forever',
    lifecycle_until: null,
    created_at: 0,
    presence: 'online',
    presences: [{ surface: 'claude-code', status: 'active', last_seen_at: 0 }],
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
    const withErr = notJoinedMessage('send', 'superseded by a newer session');
    expect(withErr).toContain('last join attempt failed: superseded by a newer session');
  });
});

describe('team_send handler', () => {
  it('blocks when not joined and surfaces the last join error', async () => {
    const handler = capture(
      registerSend,
      { joined: false, lastJoinError: 'token rejected' },
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

  it('maps @team / @broadcast recipients', async () => {
    const sent: Envelope[] = [];
    const handler = capture(
      registerSend,
      {
        joined: true,
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
});

describe('team_inbox_check handler', () => {
  function inboxClient(over: Partial<MusterdClient>): Partial<MusterdClient> {
    return {
      joined: true,
      lastJoinError: null,
      drainBuffer: () => [],
      markRead: (async () => undefined) as any,
      ...over,
    };
  }

  it('blocks when not joined', async () => {
    const handler = capture(registerInboxCheck, { joined: false, lastJoinError: null });
    const r = await handler({});
    expect(text(r)).toContain('call team_join first');
  });

  it('reports no new messages when empty', async () => {
    const handler = capture(
      registerInboxCheck,
      inboxClient({ fetchInbox: (async () => ({ messages: [], cursor: null })) as any }),
    );
    const r = await handler({ unread_only: true, limit: 50 });
    expect(text(r)).toBe('no new messages');
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
  it('lists members with presence, role and lifecycle', async () => {
    const handler = capture(registerMembers, {
      roster: (async () => ({ members: [member()] })) as any,
    });
    const r = await handler({});
    expect(text(r)).toContain(
      'Ada — kind=agent role=backend lifecycle=forever presence=[claude-code:active]',
    );
  });

  it('renders an until-lifecycle and a not-present member, and filters by name', async () => {
    const handler = capture(registerMembers, {
      roster: (async () => ({
        members: [
          member({ name: 'Lin', role: '', lifecycle: 'until', lifecycle_until: 0, presences: [] }),
          member({ name: 'Ada' }),
        ],
      })) as any,
    });
    const r = await handler({ name: 'Lin' });
    const out = text(r);
    expect(out).toContain('Lin');
    expect(out).toContain('role=—');
    expect(out).toContain('lifecycle=until');
    expect(out).toContain('presence=[not present]');
    expect(out).not.toContain('Ada');
  });

  it('reports when a named member is missing or roster is empty', async () => {
    const empty = capture(registerMembers, { roster: (async () => ({ members: [] })) as any });
    expect(text(await empty({}))).toBe('no members');
    const named = capture(registerMembers, {
      roster: (async () => ({ members: [member()] })) as any,
    });
    expect(text(await named({ name: 'Zed' }))).toBe('no member "Zed"');
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

describe('team_status handler', () => {
  it('renders online (with surface) and offline members', async () => {
    const handler = capture(registerStatus, {
      roster: (async () => ({
        members: [
          member({ name: 'Ada', presence: 'online' }),
          member({ name: 'nick', kind: 'human', role: '', presence: 'offline', presences: [] }),
        ],
      })) as any,
    });
    const out = text(await handler({}));
    expect(out).toContain('Ada (agent, backend) — online via claude-code');
    expect(out).toContain('nick (human) — offline');
  });

  it('reports no members and surfaces errors', async () => {
    const empty = capture(registerStatus, { roster: (async () => ({ members: [] })) as any });
    expect(text(await empty({}))).toBe('no members');
    const err = capture(registerStatus, {
      roster: (async () => {
        throw new Error('down');
      }) as any,
    });
    expect(text(await err({}))).toContain('error: down');
  });
});

describe('team_join handler', () => {
  it('is idempotent when already joined', async () => {
    const join = vi.fn(async () => undefined);
    const handler = capture(registerJoin, { joined: true, join: join as any }, config);
    expect(text(await handler({}))).toContain('Already joined dawn as Ada');
    expect(join).not.toHaveBeenCalled();
  });

  it('joins and returns the stay-in-sync guidance', async () => {
    const handler = capture(
      registerJoin,
      { joined: false, join: (async () => undefined) as any },
      config,
    );
    const out = text(await handler({}));
    expect(out).toContain('Joined dawn as Ada (claude-code)');
    expect(out).toContain('team_inbox_check');
  });

  it('explains a member_busy collision distinctly from a generic failure', async () => {
    const busy = capture(
      registerJoin,
      {
        joined: false,
        join: (async () => {
          throw new Error('member_busy: already active');
        }) as any,
      },
      config,
    );
    expect(text(await busy({}))).toContain('already live in another session');

    const generic = capture(
      registerJoin,
      {
        joined: false,
        join: (async () => {
          throw new Error('connection refused');
        }) as any,
      },
      config,
    );
    expect(text(await generic({}))).toContain('Could not join dawn as Ada: connection refused');
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
    const handler = capture(registerLeave, { joined: true, leave }, config);
    expect(text(await handler({}))).toContain('Left dawn');
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
