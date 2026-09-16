import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/**
 * `POST /teams/:slug/workspace/repair` (spec 2026-09-16 workspace self-heal, ADR 408): a seat with
 * a live session lease records what its SessionStart repair wrote, skipped and left, as ONE
 * `workspace.repaired` audit row. Same auth as `/inbox/interrupt-check` — credential AND lease —
 * because only a live occupancy repairs a workspace.
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let nickCred: string;
let adaAuth: AgentHttpAuth;

function authHeaders(auth?: string | AgentHttpAuth): Record<string, string> {
  return {
    ...(auth ? { authorization: `Bearer ${typeof auth === 'string' ? auth : auth.key}` } : {}),
    ...(typeof auth === 'object'
      ? { 'x-musterd-session-lease': auth.sessionLease, 'x-musterd-seat': auth.seat }
      : {}),
  };
}
async function post(path: string, body: unknown, auth?: string | AgentHttpAuth) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function get(path: string, auth?: string | AgentHttpAuth) {
  const res = await fetch(base + path, { headers: authHeaders(auth) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

const body = {
  build: 'abc1234',
  repaired: { guidance: 15, hooks: 3 },
  skipped: [
    { class: 'permissions', reason: 'policy' },
    { class: 'hooks', reason: 'outside_worktree', path: '/shared/.codex/hooks.json' },
  ],
  remaining: { guidance: 0, hooks: 1, permissions: 1 },
};

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  agentKey = team.json.agent_key;
  nickCred = team.json.human_credential;
  await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
  adaAuth = await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Ada');
});
afterEach(async () => {
  await server.close();
});

describe('POST /teams/:slug/workspace/repair (ADR 408)', () => {
  it('a seat with a live lease records one workspace.repaired audit row carrying the body', async () => {
    const r = await post('/teams/dawn/workspace/repair', body, adaAuth);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    const audit = await get('/teams/dawn/audit', nickCred);
    const rows = (audit.json.audit as any[]).filter((e) => e.action === 'workspace.repaired');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('Ada');
    expect(rows[0].target).toBe('Ada');
    expect(rows[0].result).toBe('allow');
    expect(rows[0].detail).toEqual(body);
  });

  it('is refused without a session lease, exactly like interrupt-check', async () => {
    const r = await post('/teams/dawn/workspace/repair', body, {
      ...adaAuth,
      sessionLease: '',
    });
    expect(r.status).toBe(401);
    const audit = await get('/teams/dawn/audit', nickCred);
    expect((audit.json.audit as any[]).some((e) => e.action === 'workspace.repaired')).toBe(false);
  });

  it('rejects a malformed body and records nothing', async () => {
    const r = await post('/teams/dawn/workspace/repair', { build: 'x' }, adaAuth);
    expect(r.status).toBe(400);
    const audit = await get('/teams/dawn/audit', nickCred);
    expect((audit.json.audit as any[]).some((e) => e.action === 'workspace.repaired')).toBe(false);
  });
});
