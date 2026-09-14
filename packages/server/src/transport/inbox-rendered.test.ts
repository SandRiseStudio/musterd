import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/**
 * Doorbell contract clause 7(iv), end to end: a steer rings the interrupt line at every tool
 * boundary until the addressee has READ it — and an inbox read is the read. Measured 2026-09-14
 * (delta, stanley's steer 01M2GC25MN): read at boundary 3, acted on, replied to on its thread, and
 * still ringing at every boundary of a second session, because a steer has no accept/decline and
 * the ADR 287 watermark was pinned behind it by an elided backlog. The bell taught the model to
 * ignore the bell.
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

let clock = 1_000;
async function steerAda(body: string) {
  clock += 100;
  const env = makeEnvelope({
    id: `m-${clock}`,
    team: 'dawn',
    from: 'nick',
    ts: clock,
    to: { kind: 'member', name: 'Ada' },
    act: 'steer',
    body,
  });
  const r = await post('/teams/dawn/messages', { envelope: env }, nickCred);
  expect(r.status).toBe(201);
  return env;
}

describe('a steer is discharged by being read (clause 7(iv))', () => {
  it('rings until GET /inbox renders it to the addressee, then goes quiet — with no cursor advance', async () => {
    const steer = await steerAda('drop the refactor, ship the fix');

    const before = await get('/teams/dawn/inbox/interrupt-check', adaAuth);
    expect(before.status).toBe(200);
    expect(before.json.raised).toBe(true);
    expect(before.json.act.id).toBe(steer.id);

    // The one-line notice is not a read: it rings again at the next boundary.
    const again = await get('/teams/dawn/inbox/interrupt-check', adaAuth);
    expect(again.json.raised).toBe(true);

    // The read. The cursor is deliberately NOT advanced — an elided backlog pins it in the field
    // (ADR 287) — so the discharge must not depend on it.
    const inbox = await get('/teams/dawn/inbox?unread=1', adaAuth);
    expect(inbox.status).toBe(200);
    expect(inbox.json.messages.map((m: { id: string }) => m.id)).toContain(steer.id);

    const after = await get('/teams/dawn/inbox/interrupt-check', adaAuth);
    expect(after.json.raised).toBe(false);

    // A NEWER steer rings again: discharge is per act, not per seat.
    const next = await steerAda('and write the wiki page');
    const fresh = await get('/teams/dawn/inbox/interrupt-check', adaAuth);
    expect(fresh.json.raised).toBe(true);
    expect(fresh.json.act.id).toBe(next.id);
  });
});
