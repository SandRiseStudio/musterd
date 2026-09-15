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
import { registerWakeContext } from './wakeContext.js';

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

/** Minimal well-formed lane for brief fixtures. */
const LANE = {
  id: 'L-0',
  team: 'dawn',
  project: 'default',
  title: 't',
  detail: null,
  owner_seat: 'Lin',
  role: null,
  scope: [],
  depends_on: [],
  branch: null,
  goal_id: null,
  risk: [],
  merged: null,
  state: 'awaiting_acceptance',
  created_by: 'Lin',
  created_at: 0,
  claimed_at: 0,
  resolved_at: null,
  updated_at: 0,
} as const;

/** An empty result names the next action: a tool name, a musterd CLI command, or an explicit re-check. */
const ACTION_RE = /team_[a-z_]+|lane_[a-z_]+|musterd [a-z]+|check again/;

/** A client for a team with nothing on it: joined, but every read comes back empty. */
const emptyClient: any = {
  joined: true,
  holdsSeat: true,
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

  // The emptyClient's `next` fixture deliberately omits `owed_reviews` (ADR 233). That is exactly
  // what a daemon predating the field sends, and `client.next()` CASTS the response rather than
  // parsing it through NextBriefSchema — so the schema's `.default([])` never runs on this path and
  // a renderer touching `.length` would throw. Additive means the old daemon may omit it; tolerating
  // that is the new client's job. Leaving the fixture stale keeps that contract under test.
  it('team_next against a daemon that predates owed_reviews (field absent, not empty)', async () => {
    const handlers = captureAll(registerLanes, emptyClient);
    await expect(text(handlers['team_next']!)).resolves.toMatch(ACTION_RE);
  });

  // The rendered line is the whole intervention — a derivation nobody reads changes nothing. Assert
  // it names the lane, who is waiting, how long, and the exact call that answers it (ADR 233).
  it('team_next renders an owed review first, with the reply_to that binds the verdict', async () => {
    const owedClient: any = {
      ...emptyClient,
      next: async () => ({
        member: 'Ada',
        in_flight: [{ ...LANE, id: 'L-mine', title: 'my own work', state: 'active' }],
        up_next: [],
        shipped: [],
        owed_reviews: [
          {
            lane: { ...LANE, id: 'L-theirs', title: 'their merged lane' },
            from: 'Lin',
            ask_id: 'ask-9',
            ts: Date.now() - 16 * 3600 * 1000,
          },
        ],
        why: null,
        next_goal: null,
      }),
    };
    const out = await text(captureAll(registerLanes, owedClient)['team_next']!);
    expect(out).toContain('owed by you');
    expect(out).toContain('their merged lane');
    expect(out).toContain('Lin has waited 16h');
    expect(out).toContain("reply_to:'ask-9'");
    // Above the seat's own work — the placement IS the fix (see ADR 233).
    expect(out.indexOf('owed by you')).toBeLessThan(out.indexOf('carrying'));
  });

  // ADR 235: the hint IS the intervention — agents self-closed at 8.5 minutes because we told them
  // to. Assert what the three branches actually say, since a wrong word here is the whole bug.
  describe('lane_submit advises from the backstop, not a fixed timer (ADR 235)', () => {
    function submitClient(review: unknown) {
      return {
        ...emptyClient,
        updateLane: async () => ({ lane: { ...LANE, id: 'L-1' }, warnings: [], review }),
      } as any;
    }
    const run = async (review: unknown) =>
      (await captureAll(registerLanes, submitClient(review))['lane_submit']!({ id: 'L-1' }))
        .content[0]!.text as string;

    it('backstop armed — leave it with them, and never a fixed 5-minute timer', async () => {
      const out = await run({
        reviewer: 'Lin',
        route: 'cross_family',
        backstop: { armed: true, grace_ms: 24 * 60 * 60 * 1000 },
      });
      expect(out).toContain('leave it with them');
      expect(out).toContain('Do NOT self-close on silence');
      expect(out).toContain('24h');
      expect(out).not.toContain('wait ≤5m');
      // Never a wedge (ADR 145): the escape must still be named, just not recommended.
      expect(out).toContain('lane_resolve still works');
    });

    it('no backstop — the pre-235 advice is unchanged, because self-close is the only escape', async () => {
      const out = await run({ reviewer: 'Lin', route: 'cross_family' });
      expect(out).toContain('wait ≤5m');
      expect(out).toContain('on silence, lane_resolve yourself');
    });

    it('no acceptor asked — sanctioned regardless, since no verdict is coming', async () => {
      const out = await run({ self_close_sanctioned: true });
      expect(out).toContain('no eligible acceptor is live');
      expect(out).toContain('self-close sanctioned');
    });

    it('no review at all — abstains, and never sanctions self-close on silence', async () => {
      // The 2026-08-05 defect: a repeat submit returns no fresh routing decision, and this client
      // read the silence as "no eligible acceptor is live" against two lanes whose acceptor had a
      // pending ask — inviting the premature unverified close ADR 235 measured 20-for-20. Absence
      // of a decision is not absence of an acceptor (ADR 173): with nothing to report, say nothing.
      const out = await run(undefined);
      expect(out).not.toContain('no eligible acceptor');
      expect(out).not.toContain('self-close sanctioned');
    });

    it('a standing report names the acceptor who already holds the ask', async () => {
      // The server's half of the same fix: a repeat submit reports the STANDING state, and the
      // hint must say "already awaiting" — a report, never a fresh promise, and never a sanction.
      const out = await run({ standing: true, reviewer: 'Lin', route: 'cross_family' });
      expect(out).toContain('already awaiting acceptance from Lin');
      expect(out).toContain('nothing re-routed');
      expect(out).not.toContain('self-close sanctioned');
    });

    it('a standing report with no acceptor keeps the sanction — nobody was ever asked', async () => {
      const out = await run({ standing: true, self_close_sanctioned: true });
      expect(out).toContain('no acceptor was ever routed');
      expect(out).toContain('self-close sanctioned');
    });

    it('an exempt submit is worded as the designed path, never as the degradation', async () => {
      // ADR 234 increment 2: fresh and repeat submits of a declared-low lane both say "exempt" —
      // "no eligible acceptor is live" would report a design choice as an empty fleet.
      const fresh = await run({ acceptance_exempt: true });
      expect(fresh).toContain('acceptance-exempt');
      expect(fresh).not.toContain('no eligible acceptor');
      const repeat = await run({ standing: true, acceptance_exempt: true });
      expect(repeat).toContain('acceptance-exempt');
      expect(repeat).not.toContain('no eligible acceptor');
    });
  });

  /**
   * ADR 083: work should reach the next person as an ARTIFACT, not a description — and submit, which
   * hands the lane to an acceptor, is the moment that matters most. It was the one lane edge that
   * could not set `branch`, while open/handoff/update all can, so seats reached for it here and were
   * bounced: 99 ok / 22 invalid_input measured 2026-08-05, the worst ratio of any lane tool.
   */
  describe('lane_submit carries the branch to the acceptor', () => {
    function patchSpy() {
      const patches: unknown[] = [];
      const client = {
        ...emptyClient,
        updateLane: async (_id: string, patch: unknown) => {
          patches.push(patch);
          return { lane: { ...LANE, id: 'L-1' }, warnings: [], review: undefined };
        },
      } as any;
      return { client, patches };
    }

    it('forwards the branch onto the lane alongside the state move', async () => {
      const { client, patches } = patchSpy();
      await captureAll(registerLanes, client)['lane_submit']!({
        id: 'L-1',
        branch: 'izzo/the-work',
      });
      expect(patches[0]).toMatchObject({
        state: 'awaiting_acceptance',
        branch: 'izzo/the-work',
      });
    });

    it('never invents one: a submit without a branch leaves the lane’s alone', async () => {
      // A docs-only lane legitimately has no branch, so the field must stay absent from the patch
      // rather than arrive as null and clear whatever the lane already carried. (No pr here on
      // purpose: merge-verified submit refuses a pr without a landed sha before any patch.)
      const { client, patches } = patchSpy();
      await captureAll(registerLanes, client)['lane_submit']!({ id: 'L-1' });
      expect(patches[0]).not.toHaveProperty('branch');
    });
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
    holdsSeat: true,
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
    wakeContext: async () => {
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
  add(captureAll(registerWakeContext, downClient), [['team_wake_context', { act_id: 'a1' }]]);

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
    scope: [],
    depends_on: [],
    branch: 'feat/x',
    goal_id: null,
  };
  const okClient: any = {
    joined: true,
    holdsSeat: true,
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

  it('team_wake_context returns its bounded packet as structured content', async () => {
    const handler = captureAll(registerWakeContext, {
      holdsSeat: true,
      wakeContext: async () => ({
        version: 1,
        wake: { kind: 'reply', act_id: 'a1' },
        objective: { action: 'reply' },
        state: {},
        fetch: ['inbox_thread'],
        delivery: { requirement: 'portable', intended: 'fresh' },
      }),
    })['team_wake_context']!;
    const result = await handler({ act_id: 'a1' });
    expect(result.structuredContent.context.wake.act_id).toBe('a1');
  });
});
