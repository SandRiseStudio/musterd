import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * The deferred-act surface on `GET /inbox` (ADR 211 §3/§5).
 *
 * The property under test is the one the single monotonic read cursor cannot express: a Member
 * postpones act B, reads past it (which advances the cursor beyond B), and B still comes back when
 * its condition fires. Pendingness is derived from the deferral fold, not from the cursor, so the
 * cursor is never rewound and no per-item read state is introduced.
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let nickCred: string;

/** An agent key authenticates the team; `x-musterd-seat` names the seat it acts as (SPEC A.7). */
function authHeaders(auth?: string, seat?: string): Record<string, string> {
  return {
    ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    ...(seat ? { 'x-musterd-seat': seat } : {}),
  };
}
async function post(path: string, body: unknown, auth?: string, seat?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(auth, seat) },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function get(path: string, auth?: string, seat?: string) {
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
});

afterEach(async () => {
  await server.close();
});

let clock = 1_000;
/** Send as `from`, with a monotonic ts so the fold's ordering is unambiguous. */
async function send(
  from: string,
  auth: string,
  seat: string | undefined,
  over: Parameters<typeof makeEnvelope>[0] extends infer _ ? Record<string, unknown> : never,
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

/** Read the inbox the way a client does: fetch, then advance the cursor past what was shown. */
async function readInbox(auth: string, seat?: string) {
  const r = await get('/teams/dawn/inbox', auth, seat);
  expect(r.status).toBe(200);
  const shown = r.json.messages as { id: string; ts: number }[];
  if (shown.length > 0) {
    const newest = shown.reduce((a, b) => (b.ts > a.ts ? b : a));
    const c = await post(
      '/teams/dawn/inbox/cursor',
      { last_read_message_id: newest.id },
      auth,
      seat,
    );
    expect(c.status).toBe(200);
  }
  return r.json;
}

describe('GET /inbox — deferred acts (ADR 211)', () => {
  it('re-raises a deferred act the cursor has already passed', async () => {
    const ask = await send('nick', nickCred, undefined, {
      to: { kind: 'member', name: 'Ada' },
      act: 'ask',
      body: 'judge this',
      meta: { species: 'approve', tier: 'standard' },
    });
    await send('Ada', agentKey, 'Ada', {
      act: 'wait',
      body: 'not now',
      meta: { defer_ref: ask.id, until: { reply: true } },
    });
    // Unrelated later traffic, then a read: the cursor advances PAST the deferred ask.
    await send('nick', nickCred, undefined, {
      to: { kind: 'member', name: 'Ada' },
      act: 'message',
      body: 'something else',
    });
    await readInbox(agentKey, 'Ada');

    // The UNREAD view is the one that matters: it is what the cursor filters, what feeds the wake
    // candidate set, and what the client counts. The default view is a recent window regardless of
    // read state, so the ask legitimately still appears there.
    let inbox = await get('/teams/dawn/inbox?unread=1', agentKey, 'Ada').then((r) => r.json);
    expect(inbox.messages.map((m: { id: string }) => m.id)).not.toContain(ask.id);
    expect(inbox.deferred).toEqual([{ target: ask.id, until: { reply: true }, raised: false }]);

    // The condition fires: someone else replies on the deferred act's thread.
    await send('nick', nickCred, undefined, {
      to: { kind: 'member', name: 'Ada' },
      act: 'message',
      body: 'ping',
      thread: ask.id,
    });

    inbox = await get('/teams/dawn/inbox?unread=1', agentKey, 'Ada').then((r) => r.json);
    expect(inbox.messages.map((m: { id: string }) => m.id)).toContain(ask.id);
    expect(inbox.deferred).toEqual([{ target: ask.id, until: { reply: true }, raised: true }]);
  });

  it('raises on a lane-state act for the named lane', async () => {
    const ask = await send('nick', nickCred, undefined, {
      to: { kind: 'member', name: 'Ada' },
      act: 'ask',
      body: 'review when it lands',
      meta: { species: 'approve', tier: 'standard' },
    });
    await send('Ada', agentKey, 'Ada', {
      act: 'wait',
      body: 'blocked on L1',
      meta: { defer_ref: ask.id, until: { lane: 'L1' } },
    });
    await readInbox(agentKey, 'Ada');

    let inbox = await get('/teams/dawn/inbox', agentKey, 'Ada').then((r) => r.json);
    expect(inbox.deferred[0].raised).toBe(false);

    await send('nick', nickCred, undefined, {
      act: 'message',
      body: '[lane] moved',
      meta: { lane_state: { lane: 'L1', state: 'done' } },
    });

    inbox = await get('/teams/dawn/inbox?unread=1', agentKey, 'Ada').then((r) => r.json);
    expect(inbox.deferred[0].raised).toBe(true);
    expect(inbox.messages.map((m: { id: string }) => m.id)).toContain(ask.id);
  });

  it('audits the deferral with the condition KIND only — never the lane id or a body', async () => {
    const ask = await send('nick', nickCred, undefined, {
      to: { kind: 'member', name: 'Ada' },
      act: 'ask',
      body: 'x',
      meta: { species: 'consult', tier: 'advisory' },
    });
    await send('Ada', agentKey, 'Ada', {
      act: 'wait',
      body: 'not now, blocked on L1',
      meta: { defer_ref: ask.id, until: { lane: 'L1' } },
    });

    const team = getTeamBySlug(server.db, 'dawn')!;
    const rows = listAudit(server.db, team.id).filter((r) => r.action === 'inbox.deferred');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('Ada');
    expect(rows[0]!.target).toBe(ask.id);
    expect(JSON.parse(rows[0]!.detail as string)).toEqual({ until: 'lane' });
    // Shapes only (ADR 051): the lane id and the body never reach the audit log.
    expect(rows[0]!.detail).not.toContain('L1');
    expect(rows[0]!.detail).not.toContain('blocked');
  });

  it('does not audit a bare wait or a deciding wait as a deferral', async () => {
    await send('Ada', agentKey, 'Ada', { act: 'wait', body: 'paused' });
    const ask = await send('Ada', agentKey, 'Ada', {
      to: { kind: 'member', name: 'nick' },
      act: 'ask',
      body: 'ship it?',
      meta: { species: 'approve', tier: 'standard' },
    });
    await send('nick', nickCred, undefined, {
      act: 'wait',
      body: 'deciding',
      meta: { ask_ref: ask.id, until: '1h' },
    });

    const team = getTeamBySlug(server.db, 'dawn')!;
    const rows = listAudit(server.db, team.id).filter((r) => r.action === 'inbox.deferred');
    expect(rows).toHaveLength(0);
  });

  it('surfaces a deferral that never raised as a report exception (ADR 211 Failure mode)', async () => {
    const ask = await send('nick', nickCred, undefined, {
      to: { kind: 'member', name: 'Ada' },
      act: 'ask',
      body: 'x',
      meta: { species: 'consult', tier: 'advisory' },
    });
    await send('Ada', agentKey, 'Ada', {
      act: 'wait',
      body: 'not now',
      meta: { defer_ref: ask.id, until: { lane: 'never-moves' } },
    });

    // This harness stamps a synthetic clock, so the wait's ts is arbitrary relative to the real
    // threshold — set it explicitly for each half of the assertion.
    const setWaitTs = (ts: number) =>
      server.db.prepare('UPDATE messages SET ts = ? WHERE act = ?').run(ts, 'wait');

    // Fresh: nothing is old enough to warn about.
    setWaitTs(Date.now() - 1000);
    let report = await get('/teams/dawn/report', nickCred).then((r) => r.json);
    expect(report.long_deferred).toEqual([]);

    // Aged past the threshold, condition still never fired.
    setWaitTs(Date.now() - 8 * 24 * 60 * 60 * 1000);

    report = await get('/teams/dawn/report', nickCred).then((r) => r.json);
    expect(report.long_deferred).toHaveLength(1);
    expect(report.long_deferred[0]).toMatchObject({
      seat: 'Ada',
      target: ask.id,
      until: 'lane',
      age_days: 8,
    });
    // Condition kind only — the lane id is not a report fact.
    expect(JSON.stringify(report.long_deferred)).not.toContain('never-moves');
  });

  it('reports an empty deferred list when nothing is deferred', async () => {
    const inbox = await get('/teams/dawn/inbox', agentKey, 'Ada').then((r) => r.json);
    expect(inbox.deferred).toEqual([]);
  });

  it('does not duplicate a raised act that is still unread', async () => {
    const ask = await send('nick', nickCred, undefined, {
      to: { kind: 'member', name: 'Ada' },
      act: 'ask',
      body: 'x',
      meta: { species: 'consult', tier: 'advisory' },
    });
    await send('Ada', agentKey, 'Ada', {
      act: 'wait',
      body: 'not now',
      meta: { defer_ref: ask.id, until: { reply: true } },
    });
    await send('nick', nickCred, undefined, {
      to: { kind: 'member', name: 'Ada' },
      act: 'message',
      body: 'ping',
      thread: ask.id,
    });

    const inbox = await get('/teams/dawn/inbox?unread=1', agentKey, 'Ada').then((r) => r.json);
    const ids = inbox.messages.map((m: { id: string }) => m.id);
    expect(ids.filter((id: string) => id === ask.id)).toHaveLength(1);
  });
});
