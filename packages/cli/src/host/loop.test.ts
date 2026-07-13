import type { MemberSummary, WakeOrder, WakeReportBody } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { ActuatorBackend, WakeSpec } from './backend.js';
import { pollHostOnce, type HostPollDeps, type WakeClient } from './loop.js';
import type { HostRegistryEntry } from './registry.js';

/**
 * The loop is exercised entirely through its injectables: no sockets, no spawns, no filesystem.
 * What matters here is the orchestration contract (ADR 131 §2): one lease poll per
 * (server, team, host-label) group, every order reported exactly once — including the orders no
 * backend can serve — and the backend fed the right workspace under the daemon's order.
 */

const order = (over: Partial<WakeOrder> = {}): WakeOrder => ({
  lease_id: 'L1',
  seat: 'scout',
  act_id: 'A1',
  act: 'request_help',
  sender: 'lin',
  lane: 'batched',
  composed_line: 'musterd wake — you are seat "scout" …',
  expires_at: Date.now() + 120_000,
  ...over,
});

const entryOf = (over: Partial<HostRegistryEntry> = {}): HostRegistryEntry => ({
  server: 'http://s1',
  team: 'dawn',
  seat: 'scout',
  workspace: '/ws/scout',
  harness: 'claude-code',
  host: 'mac.lan',
  updated_at: 1,
  ...over,
});

interface FakeCalls {
  leases: { team: string; host: string }[];
  reports: WakeReportBody[];
  rosters: number;
}

function fakeClient(
  orders: WakeOrder[],
  members: MemberSummary[][] = [],
): {
  client: WakeClient;
  calls: FakeCalls;
} {
  const calls: FakeCalls = { leases: [], reports: [], rosters: 0 };
  const client: WakeClient = {
    wakeLeases: async (team, host) => {
      calls.leases.push({ team, host });
      return { orders };
    },
    wakeReport: async (_team, body) => {
      calls.reports.push(body);
      return { ok: true };
    },
    roster: async () => {
      const page = members[Math.min(calls.rosters, members.length - 1)] ?? [];
      calls.rosters += 1;
      return { members: page };
    },
  };
  return { client, calls };
}

function fakeBackend(harness = 'claude-code'): { backend: ActuatorBackend; specs: WakeSpec[] } {
  const specs: WakeSpec[] = [];
  return {
    specs,
    backend: {
      harness,
      wake: async (spec) => {
        specs.push(spec);
        return { outcome: { occupied: true, session: 'fresh' }, settled: Promise.resolve() };
      },
    },
  };
}

function deps(over: Partial<HostPollDeps> & Pick<HostPollDeps, 'backends'>): HostPollDeps {
  return {
    bounds: { timeout_ms: 60_000 },
    log: () => undefined,
    readAgentKey: () => 'mskey_test',
    verifyWindowMs: 50,
    verifyPollMs: 5,
    ...over,
  };
}

describe('pollHostOnce (ADR 131 inc 3 — lease → actuate → report)', () => {
  it('actuates a registered seat: backend gets order + workspace, outcome is reported on the lease', async () => {
    const { client, calls } = fakeClient([order()]);
    const { backend, specs } = fakeBackend();
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(calls.leases).toEqual([{ team: 'dawn', host: 'mac.lan' }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.workspace).toBe('/ws/scout');
    expect(specs[0]!.order.lease_id).toBe('L1');
    expect(calls.reports).toEqual([{ lease_id: 'L1', occupied: true, session: 'fresh' }]);
    expect(result.orders).toBe(1);
    await Promise.all(result.settled);
  });

  it('an order for a seat this machine does not hold is reported failed, never dropped', async () => {
    const { client, calls } = fakeClient([order({ seat: 'ghost', lease_id: 'L9' })]);
    await pollHostOnce(
      deps({
        backends: new Map(),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(calls.reports).toHaveLength(1);
    expect(calls.reports[0]).toMatchObject({ lease_id: 'L9', occupied: false });
    expect(calls.reports[0]!.reason).toMatch(/host registry/);
  });

  it('an order for a harness with no backend is reported failed with the harness named', async () => {
    const { client, calls } = fakeClient([order()]);
    await pollHostOnce(
      deps({
        backends: new Map(), // no claude-code backend registered
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(calls.reports[0]).toMatchObject({ lease_id: 'L1', occupied: false });
    expect(calls.reports[0]!.reason).toMatch(/claude-code/);
  });

  it('groups by (server, team, host label): one lease poll covers all seats of a group', async () => {
    const { client, calls } = fakeClient([]);
    await pollHostOnce(
      deps({
        backends: new Map(),
        loadRegistry: () => ({
          entries: [entryOf(), entryOf({ seat: 'kai', workspace: '/ws/kai' })],
        }),
        clientFor: () => client,
      }),
    );
    expect(calls.leases).toEqual([{ team: 'dawn', host: 'mac.lan' }]);
  });

  it('polls once per distinct enrolled host label (hostname drift never silently derives nothing)', async () => {
    const { client, calls } = fakeClient([]);
    await pollHostOnce(
      deps({
        backends: new Map(),
        loadRegistry: () => ({
          entries: [entryOf(), entryOf({ seat: 'kai', host: 'mac.local' })],
        }),
        clientFor: () => client,
      }),
    );
    expect(calls.leases).toEqual([
      { team: 'dawn', host: 'mac.lan' },
      { team: 'dawn', host: 'mac.local' },
    ]);
  });

  it('no readable agent key: the group is skipped with a named warning, not a crash', async () => {
    const { client, calls } = fakeClient([]);
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map(),
        loadRegistry: () => ({ entries: [entryOf()] }),
        readAgentKey: () => undefined,
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    expect(calls.leases).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/no agent key/);
  });

  it('roster verify: offline → live-with-wake-provenance resolves occupied with the provenance', async () => {
    const offline: MemberSummary[] = [
      {
        id: 'm1',
        team: 'dawn',
        name: 'scout',
        kind: 'agent',
        role: '',
        lifecycle: 'forever',
        presence: 'offline',
        presences: [],
        created_at: 1,
      },
    ];
    const woken: MemberSummary[] = [
      {
        ...offline[0]!,
        presence: 'online',
        presences: [
          {
            surface: 'claude-code',
            status: 'online',
            last_seen_at: 2,
            provenance: 'wake',
          },
        ],
      },
    ];
    const { client } = fakeClient([order()], [offline, woken]);
    let verified: { occupied: boolean; provenance?: string | null } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout');
        return { outcome: { occupied: verified.occupied }, settled: Promise.resolve() };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: true, provenance: 'wake' });
  });

  it('roster verify: window expiry without presence resolves occupied=false', async () => {
    const { client } = fakeClient([order()], [[]]);
    let verified: { occupied: boolean } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout');
        return { outcome: { occupied: false, reason: 'x' }, settled: Promise.resolve() };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: false });
  });
});
