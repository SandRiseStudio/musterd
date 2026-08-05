import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { insertFootprintTick } from '../store/footprint.js';

/**
 * Through-HTTP coverage for the seat-footprint surfaces: GET /teams/:slug/footprint
 * (latest tick or an honest 404) and POST /teams/:slug/footprint/reap. The reap POST
 * here uses pids that do not exist in the live process table, so the daemon's own
 * re-verification refuses them — the kill path itself is covered in footprint/reap.test.ts
 * with injected deps; a test must never kill real processes.
 */
let server: RunningServer;
let base: string;
let agentKey: string;

async function get(path: string, auth?: string) {
  const res = await fetch(base + path, {
    headers: auth ? { authorization: `Bearer ${auth}`, 'x-musterd-seat': 'Ada' } : {},
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function post(path: string, body: unknown, auth?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}`, 'x-musterd-seat': 'Ada' } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'dawn', creator: { name: 'nick', kind: 'human' } }),
  });
  const json = (await res.json()) as any;
  agentKey = json.agent_key;
  await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, json.human_credential);
});

afterEach(async () => {
  await server.close();
});

describe('GET /teams/:slug/footprint', () => {
  it('is 404 while no tick exists — clients read any non-200 as "no data"', async () => {
    const res = await get('/teams/dawn/footprint', agentKey);
    expect(res.status).toBe(404);
  });

  it('returns the latest tick once the sampler has written one', async () => {
    insertFootprintTick(
      server.db,
      [{ ts: 7000, classification: 'orphaned', seat: null, procs: 5, rss_kb: 50_000, pids: '[3]' }],
      { ts: 7000, swap_used_mb: 1500, swap_total_mb: 2048, free_mem_mb: 140 },
    );
    const res = await get('/teams/dawn/footprint', agentKey);
    expect(res.status).toBe(200);
    expect(res.json.ts).toBe(7000);
    expect(res.json.machine.swap_used_mb).toBe(1500);
    expect(res.json.stacks[0]).toMatchObject({ classification: 'orphaned', procs: 5 });
  });

  it('requires auth', async () => {
    const res = await get('/teams/dawn/footprint');
    expect(res.status).toBe(401);
  });
});

describe('POST /teams/:slug/footprint/reap', () => {
  it('re-verifies against the live process table — nonexistent pids are refused, not killed', async () => {
    // Pid 1 is launchd and 2^22 is beyond macOS's pid range; neither matches the
    // sidecar allowlist even if present, so this cannot kill anything real.
    const res = await post('/teams/dawn/footprint/reap', { pids: [4194304] }, agentKey);
    expect(res.status).toBe(200);
    expect(res.json.killed).toEqual([]);
    // darwin refuses it as not_found; a platform whose process table cannot be read (Linux CI)
    // refuses it as unverifiable — either way, refused and never killed.
    expect(res.json.refused).toHaveLength(1);
    expect(res.json.refused[0].pid).toBe(4194304);
    expect(['not_found', 'unverifiable']).toContain(res.json.refused[0].reason);
  });

  it('rejects a malformed body', async () => {
    const res = await post('/teams/dawn/footprint/reap', { pids: 'all' }, agentKey);
    expect(res.status).toBe(400);
  });
});
