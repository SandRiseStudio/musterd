import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * Direct HTTP coverage for the stateless claim handshake (`POST /claim`, ADR 077/087) and the admin
 * request-lane decide (`POST /requests/{id}/decide`). These paths are driven end-to-end by the CLI
 * tests, but those import the *built* server, so this in-package integration test is what exercises
 * the instrumented source.
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let nickCred: string;

type Auth = string | { key: string; seat: string };
function authHeaders(auth?: Auth): Record<string, string> {
  if (!auth) return {};
  if (typeof auth === 'string') return { authorization: `Bearer ${auth}` };
  return { authorization: `Bearer ${auth.key}`, 'x-musterd-seat': auth.seat };
}
async function post(path: string, body: unknown, auth?: Auth) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function get(path: string, auth?: Auth) {
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
});

afterEach(async () => {
  await server.close();
});

async function grantFor(seat: string, lifetime = 'standing'): Promise<string> {
  const r = await post('/teams/dawn/grants', { scope: 'seat', target: seat, lifetime }, nickCred);
  return r.json.token as string;
}

describe('POST /claim — refusals', () => {
  it('refuses an invalid key with 403 forbidden', async () => {
    const r = await post('/teams/dawn/claim', {
      key: 'mskey_bogus',
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ type: 'refused', code: 'forbidden' });
  });

  it('refuses an unknown seat with 404 not_found', async () => {
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ghost' },
      surface: 'cli',
    });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('not_found');
  });

  it('refuses a role target with no matching seats (404)', async () => {
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { role: 'nonexistent-role' },
      surface: 'cli',
    });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('not_found');
  });

  it('refuses an observe target over HTTP (403 — WS only)', async () => {
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { observe: true },
      surface: 'cli',
    });
    expect(r.status).toBe(403);
    expect(r.json.message).toMatch(/observe/i);
  });

  it('refuses a grant minted for a different seat (403)', async () => {
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickCred);
    const linGrant = await grantFor('Lin');
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant: linGrant,
      surface: 'cli',
    });
    expect(r.status).toBe(403);
    expect(r.json.message).toMatch(/grant is for/);
  });

  it('refuses an unknown grant token (403)', async () => {
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant: 'msgr_not_a_real_grant',
      surface: 'cli',
    });
    expect(r.status).toBe(403);
    expect(r.json.type).toBe('refused');
  });

  it('refuses when a human credential names a different seat (403)', async () => {
    // nick's credential can only claim nick's own seat.
    const r = await post('/teams/dawn/claim', {
      key: nickCred,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(r.status).toBe(403);
    expect(r.json.message).toMatch(/identifies/);
  });
});

describe('POST /claim — occupancy', () => {
  it('occupies a seat with a valid grant and attests the model', async () => {
    const grant = await grantFor('Ada');
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant,
      surface: 'cli',
      model: 'claude-opus-4-8',
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ type: 'occupied' });
    expect(r.json.seat.name).toBe('Ada');
    expect(r.json.presence_id).toBeTruthy();

    const team = getTeamBySlug(server.db, 'dawn')!;
    const actions = listAudit(server.db, team.id).map((a) => a.action);
    expect(actions).toContain('claim.occupied');
    expect(actions).toContain('occupancy.model_attested');
  });

  it('lets a human self-authorize onto their own seat via credential', async () => {
    const r = await post('/teams/dawn/claim', {
      key: nickCred,
      target: { seat: 'nick' },
      surface: 'cli',
    });
    expect(r.status).toBe(200);
    expect(r.json.type).toBe('occupied');
    expect(r.json.seat.name).toBe('nick');
  });

  it('opens a pending request (202) when an agent claims without a grant', async () => {
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ type: 'pending' });
    expect(r.json.request_id).toBeTruthy();

    const list = await get('/teams/dawn/requests', nickCred);
    expect(list.json.requests.some((rq: any) => rq.id === r.json.request_id)).toBe(true);
  });
});

describe('POST /claim — dogfood re-seat (ADR 146)', () => {
  // Occupy a seat once so its durable `bound_at` marker is stamped — the "already held it" signal
  // the re-seat policy keys on. Uses a standing grant + agent key (the normal agent occupy path).
  async function bindSeat(seat: string): Promise<void> {
    const grant = await grantFor(seat);
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat },
      grant,
      surface: 'cli',
    });
    expect(r.status).toBe(200);
  }
  async function setReseatPolicy(on: boolean): Promise<void> {
    const r = await post('/teams/dawn/policy', { standing_reseat_known_agents: on }, nickCred);
    expect(r.status).toBe(200);
    expect(r.json.policy.standing_reseat_known_agents).toBe(on);
  }

  it('re-occupies an already-held agent seat with no grant when the policy is on', async () => {
    await bindSeat('Ada');
    await setReseatPolicy(true);
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(r.status).toBe(200);
    expect(r.json.type).toBe('occupied');
    expect(r.json.seat.name).toBe('Ada');

    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    const actions = listAudit(server.db, teamId).map((a) => a.action);
    expect(actions).toContain('claim.reseated');
  });

  it('still gates a never-bound seat even with the policy on (admission stays a decision)', async () => {
    await setReseatPolicy(true);
    // Ada exists but was never occupied — this is new-member admission, not a re-seat.
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(r.status).toBe(202);
    expect(r.json.type).toBe('pending');
  });

  it('still gates a held seat when the policy is off (default)', async () => {
    await bindSeat('Ada');
    // policy left at its default (off)
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(r.status).toBe(202);
    expect(r.json.type).toBe('pending');
  });

  it('does not let the shared agent key re-seat a held human seat', async () => {
    // Occupy nick's human seat via his credential to stamp bound_at, then try the agent key on it.
    await post('/teams/dawn/claim', { key: nickCred, target: { seat: 'nick' }, surface: 'cli' });
    await setReseatPolicy(true);
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'nick' },
      surface: 'cli',
    });
    // Falls through to the request lane — a human seat is never auto-occupiable via the team key.
    expect(r.status).toBe(202);
    expect(r.json.type).toBe('pending');
  });
});

describe('POST /requests/{id}/decide', () => {
  async function openPending(): Promise<string> {
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    return r.json.request_id as string;
  }

  it('lists pending requests for an admin (and filters with ?status=pending)', async () => {
    await openPending();
    const all = await get('/teams/dawn/requests', nickCred);
    expect(all.json.requests.length).toBe(1);
    const pending = await get('/teams/dawn/requests?status=pending', nickCred);
    expect(pending.json.requests.length).toBe(1);
  });

  it('approve mints a grant, settles the request, and audits the decision', async () => {
    const id = await openPending();
    const r = await post(
      `/teams/dawn/requests/${id}/decide`,
      { decision: 'approve', lifetime: 'ttl' },
      nickCred,
    );
    expect(r.status).toBe(200);
    expect(r.json.decision).toBe('approve');
    // A ttl (resume-token) grant is echoed for a stateless claimer.
    expect(r.json.grant).toBeTruthy();

    const after = await get('/teams/dawn/requests', nickCred);
    expect(after.json.requests.find((rq: any) => rq.id === id)?.status).toBe('approved');

    // ADR 127: decide + minted grant both carry authorized_by.
    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    const decide = listAudit(server.db, teamId).find((a) => a.action === 'request.decide')!;
    expect(JSON.parse(decide.detail!).authorized_by).toBe('nick');
    const grantIssue = listAudit(server.db, teamId).find(
      (a) => a.action === 'grant.issue' && JSON.parse(a.detail!).via === 'request.decide',
    )!;
    expect(JSON.parse(grantIssue.detail!).authorized_by).toBe('nick');
  });

  it('approve with lifetime "once" does not echo a resume token', async () => {
    const id = await openPending();
    const r = await post(
      `/teams/dawn/requests/${id}/decide`,
      { decision: 'approve', lifetime: 'once' },
      nickCred,
    );
    expect(r.status).toBe(200);
    expect(r.json.grant).toBeUndefined();
  });

  it('deny settles the request and pushes a refusal', async () => {
    const id = await openPending();
    const r = await post(`/teams/dawn/requests/${id}/decide`, { decision: 'deny' }, nickCred);
    expect(r.status).toBe(200);
    expect(r.json.decision).toBe('deny');
    const after = await get('/teams/dawn/requests', nickCred);
    expect(after.json.requests.find((rq: any) => rq.id === id)?.status).toBe('denied');
  });

  it('404s an unknown request id', async () => {
    const r = await post(
      '/teams/dawn/requests/req_missing/decide',
      { decision: 'approve', lifetime: 'once' },
      nickCred,
    );
    expect(r.status).toBe(404);
  });

  it('conflicts on deciding an already-settled request', async () => {
    const id = await openPending();
    await post(`/teams/dawn/requests/${id}/decide`, { decision: 'deny' }, nickCred);
    const again = await post(`/teams/dawn/requests/${id}/decide`, { decision: 'deny' }, nickCred);
    expect(again.status).toBe(409);
  });

  it('refuses a non-admin caller', async () => {
    const id = await openPending();
    const r = await post(
      `/teams/dawn/requests/${id}/decide`,
      { decision: 'approve', lifetime: 'once' },
      { key: agentKey, seat: 'Ada' },
    );
    expect(r.status).toBe(403);
  });
});
