import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACE_POLICY_FILE } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusterdClient } from './client.js';

/*
 * ADR 445 §4 — `team_status` says `traced: structural` when this seat's hooks would record. The
 * adapter does not run the tap, so it mirrors the tap's own preconditions; and it answers from the
 * same memoized `/health` read the build-skew check uses, so asking both costs one round trip.
 */

const health = (body: Record<string, unknown>) =>
  new Response(JSON.stringify({ ok: true, v: '1', ...body }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const client = (over: Record<string, unknown> = {}) =>
  new MusterdClient({
    server: 'http://x',
    team: 'revive',
    agent_key: 'mskey_team',
    seatCredential: 'msac_seat',
    member: 'ryder',
    ...over,
  } as never);

describe('MusterdClient.traceDepth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is structural against a daemon with a trace store, sharing the build read', async () => {
    const fn = vi.fn().mockResolvedValue(health({ build: 'abc', trace_schema: 1 }));
    vi.stubGlobal('fetch', fn);
    const c = client();
    expect(await c.traceDepth({})).toBe('structural');
    expect(await c.daemonBuild()).toBe('abc');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is null before ADR 445, without a seat credential, or under the kill switch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(health({ build: 'abc' })));
    expect(await client().traceDepth({})).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(health({ trace_schema: 1 })));
    expect(await client({ seatCredential: undefined }).traceDepth({})).toBeNull();
    expect(await client().traceDepth({ MUSTERD_NO_TRACE: '1' })).toBeNull();
  });

  it('is null when the daemon is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await client().traceDepth({})).toBeNull();
  });
});

describe('MusterdClient.traceDepth — content (increment 1b)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-mcp-trace-'));
    mkdirSync(join(dir, '.musterd'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => health({ trace_schema: 1 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });
  const inDir = (over: Record<string, unknown> = {}) => {
    const c = client({ server: 'http://localhost:4849', ...over });
    vi.spyOn(c, 'workspaceDir', 'get').mockReturnValue(dir);
    return c;
  };

  it('says structural+content when the tap cached `on` and the daemon is local', async () => {
    expect(await inDir().traceDepth({})).toBe('structural');
    writeFileSync(join(dir, '.musterd', TRACE_POLICY_FILE), JSON.stringify({ content: 'on' }));
    expect(await inDir().traceDepth({})).toBe('structural+content');
    // A remote daemon never gets content, whatever the cache says.
    expect(await inDir({ server: 'https://musterd.example.com' }).traceDepth({})).toBe(
      'structural',
    );
  });
});
