import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from '@musterd/protocol';
import {
  AuditFetchError,
  LiveFetchError,
  acquireObserver,
  createLane,
  fetchReport,
  fetchRoster,
  isStaleCredential,
  updateLane,
} from './client';

describe('isStaleCredential', () => {
  it('is true for a 401 LiveFetchError (the stale/invalid observer credential the daemon 401s)', () => {
    expect(isStaleCredential(new LiveFetchError('invalid human credential', 'unauthorized', 401))).toBe(
      true,
    );
  });

  it('is true for a 401 AuditFetchError (it IS a LiveFetchError subclass)', () => {
    expect(isStaleCredential(new AuditFetchError('no token', 'unauthorized', 401))).toBe(true);
  });

  it('is false for a 403 (forbidden — a real authz failure, not a stale credential to re-provision)', () => {
    expect(isStaleCredential(new LiveFetchError('forbidden', 'forbidden', 403))).toBe(false);
  });

  it('is false for a 500 or a plain Error (never auto-reprovision on a non-credential failure)', () => {
    expect(isStaleCredential(new LiveFetchError('boom', 'internal', 500))).toBe(false);
    expect(isStaleCredential(new Error('network down'))).toBe(false);
    expect(isStaleCredential('nope')).toBe(false);
    expect(isStaleCredential(null)).toBe(false);
  });
});

/**
 * `acquireObserver` is the ONLY way the broadcast route (ADR 157) resolves a credential — it has no
 * advanced-seat branch at all. That matters beyond tidiness: connecting as a real seat would attach a
 * *human* presence row and put a phantom person on the roster for as long as the stream runs (ADR 155).
 * So: it reads the observer key and nothing else, whatever else the browser has stored.
 */
describe('acquireObserver (the observer-only path broadcast mode relies on)', () => {
  const store = (entries: Record<string, string>) => {
    const map = new Map(Object.entries(entries));
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    });
    return map;
  };

  afterEach(() => vi.unstubAllGlobals());

  it('returns the cached observer seat without provisioning anything', async () => {
    store({
      'musterd.live.observer.v2.revive': JSON.stringify({ name: 'web-a1b2c3', token: 'mscr_obs' }),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(acquireObserver('revive')).resolves.toEqual({
      team: 'revive',
      as: 'web-a1b2c3',
      token: 'mscr_obs',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores every other stored credential — a seat key or a watch-link seat is never picked up', async () => {
    store({
      'musterd.live.observer.v2.revive': JSON.stringify({ name: 'web-a1b2c3', token: 'mscr_obs' }),
      // a real agent key + a shared watch-link seat, both sitting in the same localStorage
      'musterd.agent.key': 'mskey_seat_credential',
      'musterd.live.watchlink.v1.revive': JSON.stringify({ name: 'watch-zz', token: 'mscr_pub' }),
    });
    const cfg = await acquireObserver('revive');
    expect(cfg.as).toBe('web-a1b2c3');
    expect(cfg.token).toBe('mscr_obs');
  });

  it('is scoped per team — another team’s cached observer is not reused', async () => {
    store({
      'musterd.live.observer.v2.other': JSON.stringify({ name: 'web-other', token: 'mscr_other' }),
    });
    // no cached observer for `revive` → it must provision one rather than borrow the other team's
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ human_credential: 'mscr_fresh' }),
      })),
    );
    const cfg = await acquireObserver('revive');
    expect(cfg.team).toBe('revive');
    expect(cfg.token).toBe('mscr_fresh');
    expect(cfg.as).not.toBe('web-other');
  });
});

/**
 * The writable board's two mutations (item 5 / ADR 104). Member-authed POST/PATCH — a browser lane
 * mutation is indistinguishable from a CLI one to the daemon, which is also why the client must NOT
 * send any companion act: the daemon emits the `lane_open`/`lane_claim`/… team acts itself.
 */
describe('createLane / updateLane (the writable board, item 5)', () => {
  const cfg = { team: 'revive', as: 'nick', token: 'mscr_nick' };

  const lane = (over: Partial<Lane> = {}): Lane => ({
    id: 'L1',
    team: 'revive',
    project: 'default',
    title: 'write the launch post',
    detail: null,
    owner_seat: 'nick',
    role: null,
    surface_globs: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    risk: [],
    stakes: 'normal' as const,
    stakes_provenance: 'declared' as const,
    merged: null,
    state: 'claimed',
    created_by: 'nick',
    created_at: 1,
    claimed_at: 1,
    resolved_at: null,
    updated_at: 1,
    ...over,
  });

  const okJson = (body: unknown, status = 200) =>
    ({ ok: true, status, text: async () => JSON.stringify(body) }) as Response;
  const errJson = (status: number, code: string, message: string) =>
    ({
      ok: false,
      status,
      text: async () => JSON.stringify({ error: { code, message } }),
    }) as Response;

  afterEach(() => vi.unstubAllGlobals());

  it('createLane POSTs the OpenLane body as the signed-in member and returns the parsed result', async () => {
    const fetchMock = vi.fn(async () => okJson({ lane: lane(), warnings: [] }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createLane(cfg, { title: 'write the launch post', claim: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/teams/revive/lanes');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer mscr_nick');
    expect(headers['x-musterd-surface']).toBe('web');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'write the launch post', claim: true });
    expect(result.lane.owner_seat).toBe('nick');
    expect(result.warnings).toEqual([]);
  });

  it('createLane throws a LiveFetchError carrying the daemon code (so isStaleCredential still works)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errJson(403, 'forbidden', 'observers cannot open lanes')),
    );
    await expect(createLane(cfg, { title: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
      message: 'observers cannot open lanes',
    });
    vi.stubGlobal('fetch', vi.fn(async () => errJson(401, 'unauthorized', 'stale')));
    await expect(createLane(cfg, { title: 'x' })).rejects.toSatisfy(isStaleCredential);
  });

  it('updateLane PATCHes /lanes/:id (id URL-encoded) and returns the updated lane + fresh warnings', async () => {
    const warning = {
      kind: 'surface_overlap' as const,
      subject: 'L1',
      with: 'L2',
      owner: 'stanley',
      detail: 'overlaps packages/web/**',
    };
    const fetchMock = vi.fn(async () =>
      okJson({ lane: lane({ state: 'active' }), warnings: [warning] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateLane(cfg, 'L 1', { state: 'active' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/teams/revive/lanes/L%201');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ state: 'active' });
    expect(result.lane.state).toBe('active');
    expect(result.warnings).toEqual([warning]);
  });

  it('rejects a malformed daemon body at the boundary (schema parse, like fetchLaneBoard)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ lane: { id: 'L1' } })));
    await expect(updateLane(cfg, 'L1', { state: 'active' })).rejects.toThrow();
  });

  it('fetchReport GETs /teams/:slug/report member-authed and parses at the boundary', async () => {
    const report = {
      team: 'revive',
      generated_ts: 1,
      flow: { throughput_7d: 3, cycle_time_ms: null, wip: 2, oldest_wip_age_ms: 5000 },
      waiting_on: [{ member: 'nick', threads: 8, oldest_age_ms: 172800000 }],
      goals: [],
      blocked: [{ id: 'L1', title: 'write the launch post', owner_seat: 'nick', goal_id: null }],
      coordination: {
        window_days: 7,
        acts: 10,
        journal: 2,
        directed: 5,
        threaded: 3,
        journal_ratio: 0.2,
        exchange_ratio: 0.8,
        flag: false,
      },
      open_directed: [],
      mast: {
        window_days: 7,
        time_to_unblock: { closed: 0, median_ms: null, p95_ms: null },
        ignored_help: [],
        stalled_threads: [],
        circular_handoffs: [],
        diversity: [],
      },
      steering: {
        window_days: 7,
        steers: 0,
        acked: 0,
        latency_median_ms: null,
        latency_p95_ms: null,
        superseded_acts: 0,
        stale_wakes: 0,
        stale_caught: 0,
      },
    };
    const fetchMock = vi.fn(async () => okJson(report));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchReport(cfg);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/teams/revive/report');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mscr_nick');
    expect(out.waiting_on[0]!.member).toBe('nick');
    expect(out.flow.wip).toBe(2);
  });
});

/**
 * The roster read is the page's single point of failure (lane 01KZ9EJCHD): `MemberSummarySchema.array()`
 * is strict, so ONE row carrying a `kind`/`surface`/`offline_reason` value this bundle predates threw the
 * WHOLE array — and `useLiveStream` turned that into an error banner instead of a room. That is the exact
 * opposite of ADR 148's premise, where a client behind the daemon degrades calmly and keeps rendering.
 * It fired for real on ADR 232's `kind: 'service'`, and it would fire again for every future enum value.
 *
 * So the read path parses each member INDEPENDENTLY and reports what it could not read. The write path
 * is untouched and must stay strict — tolerating an unknown value on ingest is how bad data gets durable.
 */
describe('fetchRoster (forward-tolerance: one unreadable seat must not cost the page)', () => {
  const cfg = { team: 'revive', as: 'nick', token: 'mscr_nick' };
  const okJson = (body: unknown) =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

  const member = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    team: 'revive',
    name: 'miley',
    kind: 'agent',
    role: '',
    roles: [],
    lifecycle: 'forever',
    created_at: 1,
    presence: 'online',
    presences: [],
    ...over,
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps the seats it understands and counts the ones it does not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson({
          members: [
            member({ id: 'm1', name: 'miley' }),
            // A kind this bundle predates — exactly ADR 232's `service`, from the daemon's future.
            member({ id: 'm2', name: 'autorefresh', kind: 'wormhole' }),
            member({ id: 'm3', name: 'izzo' }),
          ],
          team: {},
        }),
      ),
    );
    const out = await fetchRoster(cfg);
    expect(out.members.map((m) => m.name)).toEqual(['miley', 'izzo']);
    expect(out.unreadable).toBe(1);
  });

  it('reports zero unreadable when every row parses (no false alarm on a matched build)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ members: [member()], team: {} })));
    const out = await fetchRoster(cfg);
    expect(out.members).toHaveLength(1);
    expect(out.unreadable).toBe(0);
  });

  it('still throws when the response is not a roster at all — tolerance is per-row, not blanket', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ members: 'nope' })));
    await expect(fetchRoster(cfg)).rejects.toThrow();
  });
});
