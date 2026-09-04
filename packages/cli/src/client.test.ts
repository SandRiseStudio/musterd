import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_LEASE_TIMEOUT_MS, HttpClient, type ClaimSocket } from './client.js';
import { CliError } from './errors.js';

class FakeSocket implements ClaimSocket {
  handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  sent: string[] = [];
  closed = false;
  on(event: string, cb: (arg?: unknown) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    // Emulate ws: closing does not itself emit 'close' — the server's 1001 does.
  }
  emit(event: 'open' | 'message' | 'error' | 'close', arg?: unknown): void {
    (this.handlers[event] ?? []).forEach((cb) => cb(arg));
  }
}

const baseOpts = {
  server: 'http://x',
  team: 'dawn',
  key: 'msac_test1234567890abcdef',
  seat: 'Ada',
  surface: 'cli',
} as const;

describe('claimSessionLease — settlement (lane 01M1F7Y4N)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a graceful daemon close (code 1001) before settlement rejects instead of hanging', async () => {
    const sock = new FakeSocket();
    const client = new HttpClient({
      ...baseOpts,
      claimSeatPerRequest: true,
      createClaimSocket: () => sock,
    });

    const promise = client.claimSessionLease();
    // watchClaim sends claim on open
    sock.emit('open');
    // daemon shuts down gracefully — ws spec: ONLY 'close' fires, never 'error'
    sock.emit('close', 1001 as unknown as undefined);

    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining('code 1001') });
    expect(sock.closed).toBe(true);
  });

  it('times out after CLAIM_LEASE_TIMEOUT_MS when the daemon never answers', async () => {
    const sock = new FakeSocket();
    const client = new HttpClient({
      ...baseOpts,
      claimSeatPerRequest: true,
      createClaimSocket: () => sock,
    });

    const promise = client.claimSessionLease();
    sock.emit('open');
    // no message ever arrives — advance past the bounded timeout
    vi.advanceTimersByTime(CLAIM_LEASE_TIMEOUT_MS + 10);

    await expect(promise).rejects.toMatchObject({ message: /timed out/ });
    expect(sock.closed).toBe(true);
  });

  it('occupied before timeout resolves with the lease and does not hang the timer', async () => {
    const sock = new FakeSocket();
    const client = new HttpClient({
      ...baseOpts,
      claimSeatPerRequest: true,
      createClaimSocket: () => sock,
    });

    const promise = client.claimSessionLease();
    sock.emit('open');
    // server answers quickly
    const seat = { id: 'm1', team: 'dawn', name: 'Ada', kind: 'agent' as const, created_at: 1 };
    sock.emit(
      'message',
      JSON.stringify({
        type: 'occupied',
        seat,
        presence_id: '01J',
        server_time: 7,
        memory: null,
        session_lease: 'lease-123',
      }),
    );

    await expect(promise).resolves.toMatchObject({ lease: 'lease-123' });
    // timer was cleared — advancing should not reject a second time
    vi.advanceTimersByTime(CLAIM_LEASE_TIMEOUT_MS + 100);
    // still resolved, no second rejection
    const result = await promise;
    expect(result.lease).toBe('lease-123');
    result.close();
    expect(sock.closed).toBe(true);
  });

  it('a second close after settlement does not re-reject', async () => {
    const sock = new FakeSocket();
    const client = new HttpClient({
      ...baseOpts,
      claimSeatPerRequest: true,
      createClaimSocket: () => sock,
    });

    const promise = client.claimSessionLease();
    sock.emit('open');
    sock.emit('close', 1001 as unknown as undefined);
    await expect(promise).rejects.toBeInstanceOf(CliError);
    // emitting close again must not cause unhandled rejection
    sock.emit('close', 1001 as unknown as undefined);
    expect(sock.closed).toBe(true);
  });
});

describe('HttpClient.request — reclaim degrades to stored lease (lane 01M1F7Y4N)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a failed reclaim (closed socket) still performs the HTTP request with the stored sessionLease', async () => {
    const sock = new FakeSocket();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ members: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchFn);

    const client = new HttpClient({
      ...baseOpts,
      sessionLease: 'stored-lease-999',
      claimSeatPerRequest: true,
      createClaimSocket: () => sock,
    });

    // start the HTTP request — it will attempt a reclaim first
    const promise = client.roster('dawn');
    // reclaim path: open then immediate close before occupied
    sock.emit('open');
    sock.emit('close', 1001 as unknown as undefined);
    // degraded path should now issue the HTTP request with the stored lease
    // need to flush the reclaim rejection microtask before fetch is awaited
    await vi.runAllTimersAsync();
    // allow fetch to resolve
    await promise;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const headers = (fetchFn.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-session-lease']).toBe('stored-lease-999');
  });

  it('a timed-out reclaim degrades and does not hang the CLI', async () => {
    const sock = new FakeSocket();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchFn);

    const client = new HttpClient({
      server: 'http://x',
      team: 'dawn',
      key: 'msac_test1234567890abcdef',
      seat: 'Ada',
      surface: 'cli',
      claimSeatPerRequest: true,
      createClaimSocket: () => sock,
    });

    const promise = client.roster('dawn');
    sock.emit('open');
    // never answer — let the reclaim timeout
    await vi.advanceTimersByTimeAsync(CLAIM_LEASE_TIMEOUT_MS + 10);
    // after timeout the request should still proceed (fetch was awaited)
    await promise;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sock.closed).toBe(true);
  });

  it('a successful reclaim uses the fresh lease, not the stored one', async () => {
    const sock = new FakeSocket();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ members: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchFn);

    const client = new HttpClient({
      ...baseOpts,
      sessionLease: 'stored-lease-999',
      claimSeatPerRequest: true,
      createClaimSocket: () => sock,
    });

    const promise = client.roster('dawn');
    sock.emit('open');
    const seat = { id: 'm1', team: 'dawn', name: 'Ada', kind: 'agent' as const, created_at: 1 };
    sock.emit(
      'message',
      JSON.stringify({
        type: 'occupied',
        seat,
        presence_id: '01J',
        server_time: 7,
        memory: null,
        session_lease: 'fresh-lease-abc',
      }),
    );
    await promise;

    const headers = (fetchFn.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-session-lease']).toBe('fresh-lease-abc');
  });
});

describe('a refused session lease is re-claimed once, and the act is not lost (lane 01M1PSY0JX)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The live shape, from the first huddle (01M1PSK8FY): the per-request claim FAILS (daemon
   *  bounced, ws closes 1001), `claimAgentLease` swallows it and degrades to the stored lease, the
   *  server refuses that lease, and the composed act dies with the refusal. */
  function socketsThat(outcomes: Array<'fail' | 'ok'>): () => FakeSocket {
    let n = 0;
    return () => {
      const sock = new FakeSocket();
      const outcome = outcomes[n++] ?? 'ok';
      queueMicrotask(() => {
        sock.emit('open');
        if (outcome === 'fail') {
          sock.emit('close', 1001 as unknown as undefined);
          return;
        }
        sock.emit(
          'message',
          JSON.stringify({
            type: 'occupied',
            seat: { id: 'm1', team: 'dawn', name: 'Ada', kind: 'agent', created_at: 1 },
            presence_id: '01J',
            server_time: 7,
            memory: null,
            session_lease: 'mssl_fresh',
          }),
        );
      });
      return sock;
    };
  }

  const refusal = {
    ok: false,
    status: 401,
    text: async () =>
      JSON.stringify({
        error: {
          code: 'unauthorized',
          message: 'invalid, expired, or revoked agent session lease',
        },
      }),
  };
  const accepted = { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };

  it('re-claims and replays the request, carrying the FRESH lease', async () => {
    const calls: Array<Record<string, string>> = [];
    const fetchStub = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers);
      return (calls.length === 1 ? refusal : accepted) as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchStub);

    const client = new HttpClient({
      ...baseOpts,
      claimSeatPerRequest: true,
      sessionLease: 'mssl_stale',
      createClaimSocket: socketsThat(['fail', 'ok']),
    });

    await expect(client.health()).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!['x-musterd-session-lease']).toBe('mssl_stale');
    expect(calls[1]!['x-musterd-session-lease']).toBe('mssl_fresh');
  });

  it('retries at most once — a refusal that survives a fresh claim still throws', async () => {
    const fetchStub = vi.fn(async () => refusal as unknown as Response);
    vi.stubGlobal('fetch', fetchStub);

    const client = new HttpClient({
      ...baseOpts,
      claimSeatPerRequest: true,
      sessionLease: 'mssl_stale',
      createClaimSocket: socketsThat(['fail', 'ok']),
    });

    await expect(client.health()).rejects.toThrow(/invalid, expired, or revoked/);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-claim for a caller that opted out — the #1130 claim storm stays closed', async () => {
    const fetchStub = vi.fn(async () => refusal as unknown as Response);
    vi.stubGlobal('fetch', fetchStub);
    const makeSocket = vi.fn(socketsThat(['ok']));

    const client = new HttpClient({
      ...baseOpts,
      claimSeatPerRequest: false,
      sessionLease: 'mssl_stale',
      createClaimSocket: makeSocket,
    });

    await expect(client.health()).rejects.toThrow(/invalid, expired, or revoked/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(makeSocket).not.toHaveBeenCalled();
  });

  it('does not re-claim a refusal that a fresh lease cannot fix (a bad credential)', async () => {
    const fetchStub = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          error: { code: 'unauthorized', message: 'invalid agent-seat credential for team "dawn"' },
        }),
    }));
    vi.stubGlobal('fetch', fetchStub);
    const makeSocket = vi.fn(socketsThat(['ok']));

    const client = new HttpClient({
      ...baseOpts,
      claimSeatPerRequest: true,
      sessionLease: 'mssl_stale',
      createClaimSocket: makeSocket,
    });

    await expect(client.health()).rejects.toThrow(/invalid agent-seat credential/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
