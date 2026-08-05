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
        return {
          outcome: { occupied: true, session: 'fresh' },
          settled: Promise.resolve(undefined),
        };
      },
    },
  };
}

function deps(over: Partial<HostPollDeps> & Pick<HostPollDeps, 'backends'>): HostPollDeps {
  return {
    bounds: { timeout_ms: 60_000 },
    log: () => undefined,
    readAgentKey: () => 'mskey_test',
    // Deterministic guard state: default = no local session (the pre-capture world).
    liveness: () => ({ state: 'none' }),
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

  it('policy bounds only TIGHTEN the operator ceiling: min(order, --timeout), knobs pass through', async () => {
    const { client } = fakeClient([
      order({ bounds: { timeout_ms: 30_000, max_turns: 9, budget_usd: 2 } }),
      order({ lease_id: 'L2', act_id: 'A2', bounds: { timeout_ms: 900_000 } }),
      order({ lease_id: 'L3', act_id: 'A3' }), // pre-inc-5 daemon: no bounds on the order
    ]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    // Wait — one lease per seat per poll server-side; here three orders exercise the same entry.
    expect(specs).toHaveLength(3);
    expect(specs[0]!.bounds).toEqual({ timeout_ms: 30_000, max_turns: 9, budget_usd: 2 });
    expect(specs[1]!.bounds.timeout_ms).toBe(60_000); // 900s policy clamped to the 60s flag
    expect(lines.join('\n')).toMatch(/clamped/);
    expect(specs[2]!.bounds.timeout_ms).toBe(60_000); // absent bounds ⇒ the operator flag
  });

  it('work_order derivation does not clamp below order.bounds.timeout_ms (ADR 199)', async () => {
    const { client } = fakeClient([
      order({
        lease_id: 'L-wo',
        act_id: 'H1',
        derivation: 'work_order',
        lane_id: 'lane1',
        bounds: { timeout_ms: 1_800_000 },
      }),
    ]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]!.bounds.timeout_ms).toBe(1_800_000);
    expect(lines.join('\n')).toMatch(/work_order using policy timeout/);
    expect(lines.join('\n')).not.toMatch(/clamped/);
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
    expect(calls.reports[0]).toMatchObject({
      lease_id: 'L9',
      occupied: false,
      wakeability: 'not_enrolled',
    });
    expect(calls.reports[0]!.reason).toMatch(/host registry/);
  });

  it('a registered seat whose workspace is unreadable reports enrolled_dead_workspace (ADR 189)', async () => {
    const { client, calls } = fakeClient([order({ seat: 'ghost', lease_id: 'L8' })]);
    await pollHostOnce(
      deps({
        backends: new Map(),
        // Registry knows the seat, but readAgentKey fails → not spawnable (dead workspace).
        loadRegistry: () => ({
          entries: [entryOf(), entryOf({ seat: 'ghost', workspace: '/ws/ghost' })],
        }),
        readAgentKey: (ws) => (ws === '/ws/ghost' ? undefined : 'mskey_x'),
        clientFor: () => client,
      }),
    );
    expect(calls.reports[0]).toMatchObject({
      lease_id: 'L8',
      occupied: false,
      wakeability: 'enrolled_dead_workspace',
    });
    expect(calls.reports[0]!.reason).toMatch(/missing or has no binding/);
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

  it('a MIXED group: the seat whose workspace is unreadable is reported, never spawned into', async () => {
    // The single-entry case above hides this bug, because an all-unreadable group is skipped whole.
    // With one healthy seat beside one whose worktree is gone, the group still has a readable key,
    // so the poll proceeds — and the dead seat's order must not reach a backend carrying a cwd that
    // does not exist. Measured on the dogfood machine 2026-07-30: izzo's registry entry named a
    // worktree deleted two weeks earlier, beside miley's and dolly's healthy ones.
    const { client, calls } = fakeClient([
      order({ lease_id: 'L-ok', seat: 'miley', act_id: 'A-ok' }),
      order({ lease_id: 'L-dead', seat: 'izzo', act_id: 'A-dead' }),
    ]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({
          entries: [
            entryOf({ seat: 'miley', workspace: '/ws/miley' }),
            entryOf({ seat: 'izzo', workspace: '/ws/gone' }),
          ],
        }),
        readAgentKey: (ws) => (ws === '/ws/gone' ? undefined : 'mskey_test'),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    // The healthy seat is unaffected — this must not become "skip the whole group".
    expect(specs.map((s) => s.workspace)).toEqual(['/ws/miley']);
    // The dead seat is reported (never dropped — the lease must settle) with a reason that names
    // the workspace, so the operator is not left reading an ENOENT attributed to a stale binary.
    const dead = calls.reports.find((r) => r.lease_id === 'L-dead');
    expect(dead?.occupied).toBe(false);
    expect(dead?.reason).toMatch(/workspace/i);
    expect(dead?.reason).toContain('/ws/gone');
    expect(lines.join('\n')).toMatch(/wake FAILED for izzo/);
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
            last_seen_at: Date.now() + 1_000, // fresh evidence — touched after the verify began
            provenance: 'wake',
            wake_lease: 'L1', // ADR 241: and attesting THIS lease — the order's `lease_id`

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
        return { outcome: { occupied: verified.occupied }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: true, provenance: 'wake', lease_matched: true });
  });

  /**
   * ADR 238. A presence row belonging to ANOTHER live session is fresh by definition — whoever owns
   * it keeps touching it — so the debris bar below, which filters by time, cannot exclude it. Verify
   * used to return on the first fresh row of any provenance, so it judged the wake before the woken
   * adapter had claimed, and reported the other session's `session` row as this wake's outcome.
   * Measured live on 2026-08-05: the woken codex adapter's `wake` row appeared ~8s after spawn, well
   * inside the 90s window, behind a stale-but-live `session` row that answered instantly.
   */
  const memberWith = (
    presences: { provenance: string; last_seen_at: number; wake_lease?: string }[],
  ): MemberSummary[] => [
    {
      id: 'm1',
      team: 'dawn',
      name: 'scout',
      kind: 'agent',
      role: '',
      lifecycle: 'forever',
      presence: 'online',
      presences: presences.map((p) => ({
        surface: 'claude-code',
        status: 'online' as const,
        last_seen_at: p.last_seen_at,
        provenance: p.provenance,
        ...(p.wake_lease !== undefined ? { wake_lease: p.wake_lease } : {}),
      })),
      created_at: 1,
    },
  ];

  it('roster verify: waits past another live session for THIS wake, rather than crediting its row', async () => {
    const other = memberWith([{ provenance: 'session', last_seen_at: Date.now() + 1_000 }]);
    const bothRows = memberWith([
      { provenance: 'session', last_seen_at: Date.now() + 1_000 },
      { provenance: 'wake', last_seen_at: Date.now() + 2_000, wake_lease: 'L1' },
    ]);
    // Two polls: the other session answers first, our own adapter claims on the second.
    const { client } = fakeClient([order()], [other, bothRows]);
    let verified: { occupied: boolean; provenance?: string | null } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout');
        return { outcome: { occupied: verified.occupied }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: true, provenance: 'wake', lease_matched: true });
  });

  /**
   * ADR 241 — the regression gptbot's rejection of ADR 238 asked for, and the point of the whole
   * increment. Increment 1 accepted any fresh `provenance: 'wake'` row as this wake's evidence, but
   * `wake` describes a KIND of session: a PRIOR wake, still alive inside its 30-minute work-order
   * timeout, keeps its row fresh by working. So the later wake was credited to it on the first poll,
   * the act was reported delivered, and no session ever received it — a false SUCCESS, strictly
   * worse than the false failure increment 1 removed, because nothing retries it.
   *
   * The fixture is that exact shape: an old lease's wake row, fresh from the first poll, and this
   * wake's own row arriving later. Verified by mutation — relax the match in `verifyOccupied` back
   * to `p.provenance === 'wake'` and this test reports `lease_matched: true` against L-OLD's row on
   * poll one, which is the bug reproduced.
   */
  it('roster verify: a PRIOR live wake session does not satisfy a later wake (ADR 241)', async () => {
    const priorWake = memberWith([
      { provenance: 'wake', last_seen_at: Date.now() + 1_000, wake_lease: 'L-OLD' },
    ]);
    const ours = memberWith([
      { provenance: 'wake', last_seen_at: Date.now() + 1_000, wake_lease: 'L-OLD' },
      { provenance: 'wake', last_seen_at: Date.now() + 2_000, wake_lease: 'L1' },
    ]);
    const { client } = fakeClient([order()], [priorWake, ours]);
    const seen: { occupied: boolean; provenance?: string | null; lease_matched?: boolean }[] = [];
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        seen.push(await ctx.verifyOccupied('scout'));
        return { outcome: { occupied: true }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    // It waited past the prior wake's row and answered on OUR lease, not on the description it shares.
    expect(seen).toEqual([{ occupied: true, provenance: 'wake', lease_matched: true }]);
  });

  it('roster verify: a seat held ONLY by another wake defers rather than failing (ADR 241)', async () => {
    // The deadline case of the same condition, and the reason `lease_matched` had to replace the
    // provenance test rather than sit beside it: under ADR 238's rule this row read `wake`, so it
    // was NOT held-by-other, so it became a charged failure. The other session is alive and working;
    // this act should wait for it, not pay for it.
    const priorWake = memberWith([
      { provenance: 'wake', last_seen_at: Date.now() + 1_000, wake_lease: 'L-OLD' },
    ]);
    const { client } = fakeClient([order()], [priorWake]);
    let verified: { occupied: boolean; provenance?: string | null; lease_matched?: boolean } = {
      occupied: false,
    };
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout', 300);
        return { outcome: { occupied: false, reason: 'x' }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: true, provenance: 'wake', lease_matched: false });
  });

  it('roster verify: an UNTOKENED fresh wake row never matches — absence is not an assertion', async () => {
    // ADR 236's subject, restated on this surface: a row from a client that does not attest the
    // token (an older adapter dist) must read as "not mine", never as "close enough". The honest
    // consequence is a deferral until that workspace's dist catches up — ADR 241's rollout note.
    const untokened = memberWith([{ provenance: 'wake', last_seen_at: Date.now() + 1_000 }]);
    const { client } = fakeClient([order()], [untokened]);
    let verified: { occupied: boolean; lease_matched?: boolean } = { occupied: false };
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout', 300);
        return { outcome: { occupied: false, reason: 'x' }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified.lease_matched).toBe(false);
  });

  it('roster verify: a seat held only by a non-wake session resolves occupied with that provenance', async () => {
    // The deadline case of the same condition: nobody but the other session ever shows up. Verify
    // still reports honestly — occupied, provenance `session` — and the BACKEND decides that this is
    // a deferral (someone else holds the seat) rather than a failure of this wake.
    const other = memberWith([{ provenance: 'session', last_seen_at: Date.now() + 1_000 }]);
    const { client } = fakeClient([order()], [other]);
    let verified: { occupied: boolean; provenance?: string | null } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout', 300);
        return { outcome: { occupied: false, reason: 'x' }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: true, provenance: 'session', lease_matched: false });
  });

  it('roster verify: window expiry without presence resolves occupied=false', async () => {
    const { client } = fakeClient([order()], [[]]);
    let verified: { occupied: boolean } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout');
        return { outcome: { occupied: false, reason: 'x' }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: false, lease_matched: false });
  });

  it('roster verify: STALE presence (pre-spawn last_seen_at) never verifies — the debris bar', async () => {
    // The first live fallback rehearsal (2026-07-13): a presence row lingering from a previous
    // occupancy read non-offline and a dead resume child was reported woke. Only evidence touched
    // at-or-after the spawn counts.
    const stale: MemberSummary[] = [
      {
        id: 'm1',
        team: 'dawn',
        name: 'scout',
        kind: 'agent',
        role: '',
        lifecycle: 'forever',
        presence: 'online',
        presences: [
          {
            surface: 'claude-code',
            status: 'online',
            last_seen_at: Date.now() - 60_000, // a minute old — predates any spawn this tick
            provenance: 'session',
          },
        ],
        created_at: 1,
      },
    ];
    const { client } = fakeClient([order()], [stale]);
    let verified: { occupied: boolean } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout', undefined, Date.now());
        return {
          outcome: { occupied: verified.occupied, reason: 'x' },
          settled: Promise.resolve(undefined),
        };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: false, lease_matched: false });
  });

  it('the local-session guard (inc 4): a live local session defers — backend never called, lease settled', async () => {
    const { client, calls } = fakeClient([order()]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
        liveness: (workspace, harness) => {
          expect(workspace).toBe('/ws/scout'); // judged through the registry's workspace path
          expect(harness).toBe('claude-code');
          return {
            state: 'live',
            session: { harness: 'claude-code', id: 'cap-1', started_at: 1 },
          };
        },
      }),
    );
    expect(specs).toHaveLength(0); // no spawn beside a working session — the whole point
    expect(calls.reports).toEqual([
      { lease_id: 'L1', occupied: false, deferred: true, reason: 'local-session-live' },
    ]);
    expect(lines.join('\n')).toContain('wake deferred: scout');
  });

  it('passes a Codex registry harness to the local-session guard', async () => {
    const { client } = fakeClient([order()]);
    const { backend, specs } = fakeBackend('codex');
    let seen: string | undefined;
    await pollHostOnce(
      deps({
        backends: new Map([['codex', backend]]),
        loadRegistry: () => ({ entries: [entryOf({ harness: 'codex' })] }),
        clientFor: () => client,
        liveness: (_workspace, harness) => {
          seen = harness;
          return { state: 'none' };
        },
      }),
    );
    expect(seen).toBe('codex');
    expect(specs).toHaveLength(1);
  });

  it('a FAILED wake is loud in the host log — the reason, not a placid "polling"', async () => {
    // The dogfood silence (lane 01KYQ913P5): the reason reached the span and the daemon's audit row,
    // and nothing a human reads. Every wake died on ENOENT for hours while the log said "◉ polling".
    const { client } = fakeClient([order()]);
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([
          [
            'claude-code',
            {
              harness: 'claude-code',
              wake: async () => ({
                outcome: {
                  occupied: false,
                  session: 'fresh' as const,
                  reason: 'spawn failed: spawn /gone/claude ENOENT',
                },
                settled: Promise.resolve(undefined),
              }),
            },
          ],
        ]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    const log = lines.join('\n');
    expect(log).toContain('wake FAILED for scout');
    expect(log).toContain('ENOENT');
  });

  it('a DEFERRAL stays quiet — the local-session guard working as designed is not a failure', async () => {
    const { client } = fakeClient([order()]);
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', fakeBackend().backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
        liveness: () => ({
          state: 'live',
          session: { harness: 'claude-code', id: 'cap-1', started_at: 1 },
        }),
      }),
    );
    expect(lines.join('\n')).not.toContain('wake FAILED');
  });

  it('the guard passes resumable/ended/none states straight through to the backend', async () => {
    for (const state of ['resumable', 'gc-expired', 'none'] as const) {
      const { client, calls } = fakeClient([order()]);
      const { backend, specs } = fakeBackend();
      await pollHostOnce(
        deps({
          backends: new Map([['claude-code', backend]]),
          loadRegistry: () => ({ entries: [entryOf()] }),
          clientFor: () => client,
          liveness: () => ({ state }),
        }),
      );
      expect(specs).toHaveLength(1);
      expect(calls.reports[0]!.deferred).toBeUndefined();
    }
  });
});

describe('the supplementary wake-cost report (inc 5)', () => {
  it('posts a second report when the run settles with a summary the primary lacked', async () => {
    const { client, calls } = fakeClient([order()]);
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async () => ({
        outcome: { occupied: true, session: 'fresh' },
        settled: Promise.resolve({ cost_usd: 0.42, duration_ms: 34_000 }),
      }),
    };
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    await Promise.all(result.settled);
    expect(calls.reports).toEqual([
      { lease_id: 'L1', occupied: true, session: 'fresh' },
      { lease_id: 'L1', occupied: true, cost_usd: 0.42, duration_ms: 34_000 },
    ]);
  });

  it('no supplement when the primary already carried cost (fast-fail merge) or none exists', async () => {
    const { client, calls } = fakeClient([order(), order({ lease_id: 'L2', act_id: 'A2' })]);
    let call = 0;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async () => {
        call += 1;
        return call === 1
          ? {
              // Fast-fail: the primary outcome already carries the summary.
              outcome: { occupied: false, session: 'fresh', reason: 'x', cost_usd: 0.05 },
              settled: Promise.resolve({ cost_usd: 0.05, duration_ms: 900 }),
            }
          : {
              // A run that surfaced no summary (hung, killed) — nothing to supplement.
              outcome: { occupied: false, session: 'fresh', reason: 'y' },
              settled: Promise.resolve(undefined),
            };
      },
    };
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    await Promise.all(result.settled);
    expect(calls.reports).toHaveLength(2); // the two primaries, zero supplements
  });
});
