import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registerGoals } from './goals.js';
import { registerInboxCheck } from './inboxCheck.js';
import { registerInsights } from './insights.js';
import { registerLanes } from './lanes.js';
import { registerLeave } from './leave.js';
import { registerMembers } from './members.js';
import { registerMemory } from './memory.js';
import { registerSend } from './send.js';
import { registerStatus } from './status.js';

/**
 * The results & empty-states audit (ADR 144 inc 3) — the "audited standard" the ADR asks for, held
 * as a test instead of a checklist doc. Three mechanical holds:
 *
 *   1. every EMPTY result names the next action (a tool, a CLI command, or an explicit re-check);
 *   2. every ERROR result flows through `errorResult` (held by a source scan — a hand-rolled
 *      `error:` string would escape the repair classes), and a known failure class carries its
 *      repair line;
 *   3. the tools that promised structured-first results actually return `structuredContent`.
 *
 * Exemptions are explicit here, not silent: `team_join`'s error branches are bespoke (each names
 * its action — covered in tools.test.ts), and `team_report`/`team_next` on a quiet team still
 * render a report, which IS the result.
 */

type Handler = (args: any) => Promise<{ content: { text: string }[]; structuredContent?: any }>;

function captureAll(
  register: (server: any, client: any, config?: any) => void,
  client: any,
  config?: any,
) {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _schema: unknown, h: Handler) => {
      handlers[name] = h;
    },
  };
  register(server, client, config);
  return handlers;
}

const config = { team: 'dawn', member: 'Ada', surface: 'claude-code' };

/** An empty result names the next action: a tool name, a musterd CLI command, or an explicit re-check. */
const ACTION_RE = /team_[a-z_]+|lane_[a-z_]+|musterd [a-z]+|check again/;

/** A client for a team with nothing on it: joined, but every read comes back empty. */
const emptyClient: any = {
  joined: true,
  claimed: true,
  member: 'Ada',
  build: undefined,
  memory: null,
  roster: async () => ({ members: [] }),
  drainBuffer: () => [],
  fetchInbox: async () => ({ messages: [] }),
  markRead: async () => undefined,
  goals: async () => ({ goals: [] }),
  laneBoard: async () => ({ lanes: [], warnings: [] }),
  next: async () => ({
    member: 'Ada',
    in_flight: [],
    up_next: [],
    shipped: [],
    why: null,
    next_goal: null,
  }),
  readMemory: async () => {
    throw new Error('no memory saved for this seat');
  },
};

async function text(h: Handler, args: any = {}): Promise<string> {
  return (await h(args)).content[0]!.text;
}

describe('empty states name the next action', () => {
  it('team_status on an empty roster', async () => {
    const h = captureAll(registerStatus, emptyClient)['team_status']!;
    expect(await text(h)).toMatch(ACTION_RE);
  });

  it('team_members — empty roster and unknown member', async () => {
    const h = captureAll(registerMembers, emptyClient)['team_members']!;
    expect(await text(h)).toMatch(ACTION_RE);
    expect(await text(h, { name: 'nobody' })).toMatch(ACTION_RE);
  });

  it('team_inbox_check with nothing waiting', async () => {
    const h = captureAll(registerInboxCheck, emptyClient)['team_inbox_check']!;
    expect(await text(h)).toMatch(ACTION_RE);
  });

  it('team_goals with none declared', async () => {
    const h = captureAll(registerGoals, emptyClient)['team_goals']!;
    expect(await text(h)).toMatch(ACTION_RE);
  });

  it('lane_board and team_next with nothing in flight', async () => {
    const handlers = captureAll(registerLanes, emptyClient);
    expect(await text(handlers['lane_board']!)).toMatch(ACTION_RE);
    expect(await text(handlers['team_next']!)).toMatch(ACTION_RE);
  });

  it('team_memory_read with nothing saved points at team_memory_save', async () => {
    const h = captureAll(registerMemory, emptyClient)['team_memory_read']!;
    expect(await text(h)).toContain('team_memory_save');
  });

  it('team_leave when not joined points at team_join', async () => {
    const h = captureAll(registerLeave, { joined: false }, config)['team_leave']!;
    expect(await text(h)).toContain('team_join');
  });
});

describe('a known failure class carries its repair line', () => {
  /** Every read/mutate rejects the way an unreachable daemon does. */
  const downClient: any = {
    joined: true,
    claimed: true,
    member: 'Ada',
    build: undefined,
    drainBuffer: () => [],
    markSeen: () => undefined,
    roster: async () => {
      throw new Error('fetch failed');
    },
    fetchInbox: async () => {
      throw new Error('fetch failed');
    },
    goals: async () => {
      throw new Error('fetch failed');
    },
    declareGoal: async () => {
      throw new Error('fetch failed');
    },
    laneBoard: async () => {
      throw new Error('fetch failed');
    },
    openLane: async () => {
      throw new Error('fetch failed');
    },
    updateLane: async () => {
      throw new Error('fetch failed');
    },
    next: async () => {
      throw new Error('fetch failed');
    },
    report: async () => {
      throw new Error('fetch failed');
    },
    sendEnvelope: async () => {
      throw new Error('fetch failed');
    },
    saveMemory: async () => {
      throw new Error('fetch failed');
    },
    readMemory: async () => {
      throw new Error('fetch failed');
    },
  };

  const cases: [string, Record<string, Handler>, string, any][] = [];
  const add = (handlers: Record<string, Handler>, names: [string, any?][]) => {
    for (const [name, args] of names) cases.push([name, handlers, name, args ?? {}]);
  };
  add(captureAll(registerStatus, downClient), [['team_status']]);
  add(captureAll(registerMembers, downClient), [['team_members']]);
  add(captureAll(registerInboxCheck, downClient), [['team_inbox_check']]);
  add(captureAll(registerGoals, downClient), [
    ['team_goals'],
    ['team_goal_declare', { id: 'g', title: 't' }],
  ]);
  add(captureAll(registerLanes, downClient), [
    ['lane_open', { title: 't' }],
    ['lane_claim', { id: 'l1' }],
    ['lane_board'],
    ['lane_handoff', { id: 'l1', to: 'Bo' }],
    ['lane_update', { id: 'l1' }],
    ['lane_resolve', { id: 'l1' }],
    ['team_next'],
  ]);
  add(captureAll(registerInsights, downClient), [['team_report']]);
  add(captureAll(registerSend, downClient, config), [
    ['team_send', { to: '@team', act: 'status_update', body: 'x' }],
  ]);
  add(captureAll(registerMemory, downClient), [
    ['team_memory_save', { headline: 'h' }],
    ['team_memory_read'],
  ]);

  it.each(cases.map(([name, handlers, tool, args]) => [name, handlers[tool]!, args] as const))(
    '%s repairs a daemon-unreachable failure',
    async (_name, handler, args) => {
      const out = await text(handler, args);
      expect(out).toContain('error: fetch failed');
      expect(out).toContain('musterd service status');
    },
  );
});

describe('errors flow through the one renderer (source scan)', () => {
  it('no tool module hand-rolls its error text', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const modules = readdirSync(dir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'format.ts',
    );
    for (const f of modules) {
      const src = readFileSync(pathJoin(dir, f), 'utf8');
      // errorResult (or join's repairHint composition) is the only sanctioned error path — a
      // hand-rolled `error:` template would silently skip the repair classes.
      expect(src, `${f} must route errors through errorResult`).not.toMatch(/textResult\(`error:/);
    }
  });
});

describe('structured-first results carry structuredContent', () => {
  const lane = {
    id: 'l1',
    state: 'claimed',
    title: 't',
    owner_seat: 'Ada',
    project: 'default',
    surface_globs: [],
    depends_on: [],
    branch: 'feat/x',
    goal_id: null,
  };
  const okClient: any = {
    joined: true,
    member: 'Ada',
    markSeen: () => undefined,
    sendEnvelope: async () => undefined,
    openLane: async () => ({ lane, warnings: [] }),
    updateLane: async () => ({ lane, warnings: [] }),
  };

  it('team_send returns the id/thread a programmatic caller threads with', async () => {
    const h = captureAll(registerSend, okClient, config)['team_send']!;
    const res = await h({ to: '@team', act: 'status_update', body: 'x' });
    expect(res.structuredContent.id).toBeTruthy();
    expect(res.structuredContent.act).toBe('status_update');
  });

  it('lane mutations return the lane, warnings, and any hint as fields', async () => {
    const handlers = captureAll(registerLanes, okClient);
    const opened = await handlers['lane_open']!({ title: 't' });
    expect(opened.structuredContent.lane.id).toBe('l1');
    expect(opened.structuredContent.warnings).toEqual([]);
    const resolved = await handlers['lane_resolve']!({ id: 'l1' });
    // The branch-cleanup next action rides as a field, not only inside the prose.
    expect(resolved.structuredContent.hint).toContain('git branch -D feat/x');
  });
});
