import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/**
 * `answered` on `GET /inbox` — which of my open asks I have already replied to.
 *
 * WHY THE SERVER HAS TO SAY THIS. `listInbox` excludes the member's own sends
 * (`from_member != me`), and the reply that answers an ask IS the member's own send. So a
 * client folding over its inbox can never observe that it answered anything — which is exactly
 * what happened: `openAnswerable` in the MCP adapter and the CLI both derive "still open" from
 * `act === 'resolve'` alone, and the live ledger holds 199 accepts against 9 resolves. Every
 * acceptance ask anyone has ever answered stayed "open" forever, and the lane-acceptance
 * disambiguation list — the guard that exists so a verdict lands on the right lane — filled with
 * dead asks, showing only its newest six.
 *
 * /live already gets this right (`packages/web/src/live/asks.ts`: an `accept` referencing an ask
 * closes it) because it reads the team timeline rather than one seat's inbox. This puts the same
 * fact where the agent-facing readers can reach it.
 *
 * The scan is the one ADR 211 §3 already runs for deferrals — same bound, same reason, no extra
 * query — so an answer older than the window degrades to today's behaviour (the ask simply reads
 * as open) rather than to a wrong answer.
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let adaAuth: AgentHttpAuth;
let linAuth: AgentHttpAuth;
let nickCred: string;

function authHeaders(auth?: string | AgentHttpAuth, seat?: string): Record<string, string> {
  return {
    ...(auth ? { authorization: `Bearer ${typeof auth === 'string' ? auth : auth.key}` } : {}),
    ...(typeof auth === 'object' ? { 'x-musterd-session-lease': auth.sessionLease } : {}),
    ...((seat ?? (typeof auth === 'object' ? auth.seat : undefined))
      ? { 'x-musterd-seat': seat ?? (typeof auth === 'object' ? auth.seat : undefined)! }
      : {}),
  };
}
async function post(path: string, body: unknown, auth?: string | AgentHttpAuth, seat?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(auth, seat) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function get(path: string, auth?: string | AgentHttpAuth, seat?: string) {
  const res = await fetch(base + path, { headers: authHeaders(auth, seat) });
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
  linAuth = adaAuth;
});

afterEach(async () => {
  await server.close();
});

let clock = 1_000;
async function send(
  from: string,
  auth: string | AgentHttpAuth,
  seat: string | undefined,
  over: Record<string, unknown>,
) {
  clock += 100;
  const env = makeEnvelope({
    id: `m-${clock}`,
    team: 'dawn',
    from,
    ts: clock,
    to: { kind: 'team' },
    ...over,
  } as Parameters<typeof makeEnvelope>[0]);
  const r = await post('/teams/dawn/messages', { envelope: env }, auth, seat);
  expect(r.status).toBe(201);
  return env;
}

const askAda = (body: string) =>
  send('nick', nickCred, undefined, {
    to: { kind: 'member', name: 'Ada' },
    act: 'ask',
    body,
    meta: { species: 'approve', tier: 'standard' },
  });

describe('GET /inbox — answered asks', () => {
  it('reports an ask this seat has replied to, keyed by in_reply_to', async () => {
    const ask = await askAda('judge lane A');
    await send('Ada', adaAuth, undefined, {
      to: { kind: 'member', name: 'nick' },
      act: 'accept',
      body: 'accepted',
      meta: { in_reply_to: ask.id },
    });
    const inbox = await get('/teams/dawn/inbox', adaAuth);
    expect(inbox.json.answered).toContain(ask.id);
  });

  // The whole point: the reply carries no thread. 173 of the 205 replies in the live ledger are
  // exactly this shape, because an explicit `reply_to` sets `in_reply_to` and never inherits a
  // thread. A closure rule keyed on the thread would miss every one of them.
  it('does NOT need the reply to share a thread with the ask', async () => {
    const ask = await askAda('judge lane B');
    const reply = await send('Ada', adaAuth, undefined, {
      to: { kind: 'member', name: 'nick' },
      act: 'accept',
      body: 'accepted',
      meta: { in_reply_to: ask.id },
    });
    expect(reply.thread).toBeNull();
    const inbox = await get('/teams/dawn/inbox', adaAuth);
    expect(inbox.json.answered).toContain(ask.id);
  });

  it('leaves an unanswered ask out — the list is answers, not asks', async () => {
    const open = await askAda('judge lane C');
    const inbox = await get('/teams/dawn/inbox', adaAuth);
    expect(inbox.json.answered ?? []).not.toContain(open.id);
  });

  // Someone ELSE answering nick's ask does not discharge Ada's copy of it. `answered` is
  // first-person by construction — it is built only from this member's own sends.
  it('does not count another seat’s reply as this seat’s answer', async () => {
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickCred);
    linAuth = await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Lin');
    const ask = await send('nick', nickCred, undefined, {
      to: { kind: 'team' },
      act: 'ask',
      body: 'anyone?',
      meta: { species: 'consult', tier: 'advisory' },
    });
    await send('Lin', linAuth, undefined, {
      to: { kind: 'member', name: 'nick' },
      act: 'accept',
      body: 'I took it',
      meta: { in_reply_to: ask.id },
    });
    const ada = await get('/teams/dawn/inbox', adaAuth);
    expect(ada.json.answered ?? []).not.toContain(ask.id);
    const lin = await get('/teams/dawn/inbox', linAuth);
    expect(lin.json.answered).toContain(ask.id);
  });
});
