import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from '@musterd/protocol';
import {
  AuditFetchError,
  LiveFetchError,
  acquireObserver,
  createLane,
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
});
