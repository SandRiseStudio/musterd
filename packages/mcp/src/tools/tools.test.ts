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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const handlers = captureAll(registerMemory, { joined: true, saveMemory: saveMemory as any });
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

  it('read reports a seat with nothing saved via the server not_found', async () => {
    const handlers = captureAll(registerMemory, {
      joined: true,
      readMemory: (async () => {
        throw new Error('no memory saved for this seat');
      }) as any,
    });
    expect(text(await handlers['team_memory_read']!({}))).toContain('no memory saved');
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
      { joined: true, join: join as any, memory: null },
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
        memory: { headline: 'mid-refactor', saved_at: Date.now() - 60_000, size_bytes: 7 },
      },
      config,
    );
    const out = text(await handler({}));
    expect(out).toContain('Already joined dawn as Ada');
    expect(out).toContain('Saved memory from 1m ago: "mid-refactor"');
  });

  it('claims a named seat with {as} and returns the stay-in-sync guidance', async () => {
    const cfg = { ...config, member: undefined };
    const handler = capture(registerJoin, pendingClient(cfg), cfg);
    const out = text(await handler({ as: 'Ada' }));
    expect(out).toContain('Joined dawn as Ada (claude-code)');
    expect(out).toContain('team_inbox_check');
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
    const handler = capture(registerLeave, { joined: true, leave }, config);
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
      surface_globs: [],
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

  it('omits the hint for a branchless lane', async () => {
    const updateLane = vi.fn(async () => ({ lane: lane({ branch: null }), warnings: [] }));
    const handlers = captureAll(registerLanes, { updateLane } as Partial<MusterdClient>);
    const out = text(await handlers['lane_resolve']!({ id: 'lane1' }));
    expect(out).toContain('lane done');
    expect(out).not.toContain('git branch -D');
  });
});
