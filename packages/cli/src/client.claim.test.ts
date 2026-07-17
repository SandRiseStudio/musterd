import { FEATURE_EPOCH } from '@musterd/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client.js';
import { CliError } from './errors.js';

// Pin the CLI's own build stamp to "unstamped": the exact-body assertions below must not pick up
// this worktree's ambient dist/build.json (ADR 135) — the build field has its own dedicated tests.
vi.mock('./version.js', () => ({ cliVersion: () => '0.0.0', cliBuild: () => undefined }));

const seat = { id: 'm1', team: 'dawn', name: 'Ada', kind: 'agent' as const, created_at: 1 };
const input = { key: 'mskey_x', target: { seat: 'Ada' } as const, surface: 'cli' as const };

/** Stub global fetch to return a Response with the given status + JSON body. */
function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('HttpClient.claim (SPEC A.7, ADR 075/077) — status dispatch', () => {
  it('200 → occupied outcome', async () => {
    stubFetch(200, { type: 'occupied', seat, presence_id: '01J', server_time: 7, memory: null });
    const out = await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(out.state).toBe('occupied');
    if (out.state === 'occupied') {
      expect(out.presenceId).toBe('01J');
      expect(out.serverTime).toBe(7);
    }
  });

  it('202 → pending outcome (request opened, no grant)', async () => {
    stubFetch(202, { type: 'pending', request_id: '01J', message: 'asked admins' });
    const out = await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(out.state).toBe('pending');
    if (out.state === 'pending') expect(out.requestId).toBe('01J');
  });

  it('409 → refused (claim_conflict) with claimable + hint', async () => {
    stubFetch(409, {
      type: 'refused',
      code: 'claim_conflict',
      message: 'seat taken',
      claimable: ['backend-2'],
      hint: 'musterd claim --role backend',
    });
    const out = await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(out.state).toBe('refused');
    if (out.state === 'refused') {
      expect(out.code).toBe('claim_conflict');
      expect(out.claimable).toEqual(['backend-2']);
      expect(out.hint).toBe('musterd claim --role backend');
    }
  });

  it('403 → refused (forbidden, bad key) + 410 → refused (expired_grant)', async () => {
    stubFetch(403, { type: 'refused', code: 'forbidden', message: 'no', claimable: [], hint: 'x' });
    let out = await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(out.state).toBe('refused');
    if (out.state === 'refused') expect(out.code).toBe('forbidden');

    stubFetch(410, {
      type: 'refused',
      code: 'expired_grant',
      message: 'old',
      claimable: [],
      hint: 'rotate',
    });
    out = await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(out.state).toBe('refused');
    if (out.state === 'refused') expect(out.code).toBe('expired_grant');
  });

  it('posts { key, target, grant?, surface } (no WS type/v) to /teams/:slug/claim', async () => {
    const fn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x' }).claim('dawn', {
      key: 'mskey_x',
      target: { role: 'backend' },
      grant: 'msgr_y',
      surface: 'claude-code',
    });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('http://x/teams/dawn/claim');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      key: 'mskey_x',
      target: { role: 'backend' },
      grant: 'msgr_y',
      surface: 'claude-code',
      // Feature epoch (ADR 147) — always attested by our own clients (a compiled-in constant).
      epoch: FEATURE_EPOCH,
    });
    expect(body.type).toBeUndefined();
    expect(body.v).toBeUndefined();
  });

  it('5xx → CliError server error (exit 1)', async () => {
    stubFetch(500, {});
    await expect(new HttpClient({ server: 'http://x' }).claim('dawn', input)).rejects.toMatchObject(
      {
        message: /server error \(500\)/,
        exitCode: 1,
      },
    );
  });

  it('connection refused → CliError exit 7 (daemon not running)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8080')),
    );
    await expect(new HttpClient({ server: 'http://x' }).claim('dawn', input)).rejects.toMatchObject(
      {
        exitCode: 7,
      },
    );
  });

  it('4xx with a plain ErrorBody (not a refused frame) → standard error mapping', async () => {
    stubFetch(400, { error: { code: 'bad_request', message: 'no target' } });
    await expect(new HttpClient({ server: 'http://x' }).claim('dawn', input)).rejects.toMatchObject(
      {
        message: 'no target',
      },
    );
  });

  it('200 with a malformed occupied body (missing memory:null) → CliError', async () => {
    stubFetch(200, { type: 'occupied', seat, presence_id: '01J', server_time: 7 });
    await expect(
      new HttpClient({ server: 'http://x' }).claim('dawn', input),
    ).rejects.toBeInstanceOf(CliError);
  });
});
