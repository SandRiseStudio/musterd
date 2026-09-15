import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/**
 * Doorbell contract clause 7, on the OTHER surface. #1383 taught the interrupt line to discharge
 * (ii) an obligation whose lane has left awaiting acceptance and (iv) an act the seat has been
 * shown — but the human-facing count is folded client-side over the `discharged` array `GET /inbox`
 * returns, and that query only ever knew (iii), the co-addressee's accept.
 *
 * Measured 2026-09-14 on the laptop daemon (d60b2c2, carrying abc462cb): acceptance ask
 * `01M2GMN7V1` on lane `01M2GJFCQV`, lane `done` — `musterd inbox --interrupt-check` silent,
 * `musterd inbox --waiting` still counting it at 8. The bell was quiet and the number nick reads
 * was not. These are that falsifier, in the fixture.
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let nickCred: string;
let adaAuth: AgentHttpAuth;
let boAuth: AgentHttpAuth;

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
async function patch(path: string, body: unknown, auth?: string | AgentHttpAuth) {
  const res = await fetch(base + path, {
    method: 'PATCH',
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
  await post('/teams/dawn/members', { name: 'Bo', kind: 'agent' }, nickCred);
  adaAuth = await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Ada');
  boAuth = await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Bo');
});
afterEach(async () => {
  await server.close();
});

let clock = 1_000;

/**
 * A lane owned by Bo, submitted with a named acceptor so the DAEMON composes the acceptance ask.
 * It has to be the real path: `meta.lane_review` is server-controlled (ADR 225) and stripped from
 * any client-supplied meta, so a hand-rolled ask is not an obligation at all and would test
 * nothing.
 */
async function laneAwaitingAdasVerdict(title: string) {
  const lane = await post('/teams/dawn/lanes', { title, claim: true }, boAuth);
  expect(lane.status).toBe(201);
  const id = lane.json.lane.id as string;
  const submitted = await patch(
    `/teams/dawn/lanes/${id}`,
    { state: 'awaiting_acceptance', acceptor: 'Ada' },
    boAuth,
  );
  expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);

  const inbox = await get('/teams/dawn/inbox', adaAuth);
  const ask = (inbox.json.messages as any[]).find(
    (m) => m.act === 'ask' && m.meta?.lane_review?.lane === id,
  );
  expect(
    ask,
    `no lane_review ask routed to Ada: ${JSON.stringify(inbox.json.messages)}`,
  ).toBeTruthy();
  return { laneId: id, askId: ask.id as string };
}

const dischargeOf = (inbox: any, id: string) =>
  (inbox.json.discharged as { id: string; reason?: string; by?: string }[]).find(
    (d) => d.id === id,
  );

describe("clause 7(ii) on the waiting view — a closed lane's acceptance ask", () => {
  it('is NOT discharged while the lane is still awaiting acceptance — it is a real obligation', async () => {
    const { askId } = await laneAwaitingAdasVerdict('still open');
    const inbox = await get('/teams/dawn/inbox', adaAuth);
    expect(dischargeOf(inbox, askId)).toBeUndefined();
  });

  it('is discharged once the lane leaves awaiting acceptance, and names the lane — not an answerer', async () => {
    const { laneId, askId } = await laneAwaitingAdasVerdict('closes under Ada');
    const closed = await patch(`/teams/dawn/lanes/${laneId}`, { state: 'done' }, boAuth);
    expect(closed.status, JSON.stringify(closed.json)).toBe(200);
    expect(closed.json.lane.state).toBe('done');

    const inbox = await get('/teams/dawn/inbox', adaAuth);
    // The discharge has no answering seat: nobody accepted, the lane simply closed. Borrowing `by`
    // here would invent an answerer, which is the one thing this row must never do.
    expect(dischargeOf(inbox, askId)).toEqual({ id: askId, reason: 'lane_closed' });
  });

  it('keeps ringing while the lane is unknown to this daemon — dropping on absence would silence a real obligation', async () => {
    // A replicated ask whose lane has not folded here yet. Built by routing a real one and then
    // removing the lane row, so the ask itself is the daemon-composed article.
    const { laneId, askId } = await laneAwaitingAdasVerdict('vanishes');
    server.db.prepare('DELETE FROM lanes WHERE id = ?').run(laneId);

    const inbox = await get('/teams/dawn/inbox', adaAuth);
    expect(dischargeOf(inbox, askId)).toBeUndefined();
  });
});

describe('clause 7(iv) on the waiting view — a steer the seat has been shown', () => {
  async function steerAda(body: string) {
    clock += 100;
    const env = makeEnvelope({
      id: `st-${clock}`,
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

  it('counts on the first read and is discharged from the second — the read is the discharge', async () => {
    const steer = await steerAda('stop rebasing, land it');

    // The read that renders it is the read that discharges it, so it must still be COUNTED here —
    // a seat that never sees the act cannot have been shown it.
    const first = await get('/teams/dawn/inbox', adaAuth);
    expect(dischargeOf(first, steer.id)).toBeUndefined();

    const second = await get('/teams/dawn/inbox', adaAuth);
    expect(dischargeOf(second, steer.id)).toEqual({ id: steer.id, reason: 'read' });
  });

  it("says nothing about another seat's steer — Bo was never shown Ada's", async () => {
    const steer = await steerAda('Ada only');
    await get('/teams/dawn/inbox', adaAuth);
    await get('/teams/dawn/inbox', adaAuth);

    const bo = await get('/teams/dawn/inbox', boAuth);
    expect(dischargeOf(bo, steer.id)).toBeUndefined();
  });
});
