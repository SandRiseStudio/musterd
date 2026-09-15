import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { upsertRole } from '../store/roles.js';
import { getTeamBySlug, mintBootstrapCredential } from '../store/teams.js';

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

type Auth = string | { key: string; seat: string; sessionLease?: string };
function authHeaders(auth?: Auth): Record<string, string> {
  if (!auth) return {};
  if (typeof auth === 'string') return { authorization: `Bearer ${auth}` };
  return {
    authorization: `Bearer ${auth.key}`,
    'x-musterd-seat': auth.seat,
    ...(auth.sessionLease ? { 'x-musterd-session-lease': auth.sessionLease } : {}),
  };
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
async function del(path: string, auth?: Auth) {
  const res = await fetch(base + path, { method: 'DELETE', headers: authHeaders(auth) });
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
  await post('/teams/dawn/members', { name: 'Ada', kind: 'agent', role: 'backend' }, nickCred);
  const teamRow = getTeamBySlug(server.db, 'dawn')!;
  upsertRole(server.db, teamRow.id, 'backend', {}, 'Own the rails.', null);
});

afterEach(async () => {
  await server.close();
});

async function grantFor(seat: string, lifetime = 'standing'): Promise<string> {
  const r = await post('/teams/dawn/grants', { scope: 'seat', target: seat, lifetime }, nickCred);
  return r.json.token as string;
}

describe('agent bootstrap credential lifecycle', () => {
  it('exchanges legacy plus seat proofs without creating another Presence (ADR 350)', async () => {
    const occupied = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant: await grantFor('Ada'),
      surface: 'cli',
    });
    expect(occupied.status).toBe(200);
    const before = server.db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM presence')
      .get()!.count;

    const migrated = await post('/agent-bootstrap-migrations', {
      legacy_key: agentKey,
      seat_credential: occupied.json.seat_credential,
    });
    expect(migrated.status).toBe(201);
    expect(migrated.json.agent_key).toMatch(/^mskey_/);
    expect(migrated.json.credential).toMatchObject({
      use: 'claim_seat',
      target: 'Ada',
      state: 'active',
    });
    expect(migrated.json.credential).not.toHaveProperty('key_hash');
    expect(
      server.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM presence').get()!
        .count,
    ).toBe(before);

    const audit = listAudit(server.db, getTeamBySlug(server.db, 'dawn')!.id);
    expect(audit.map((row) => row.action)).toContain('bootstrap_credential.migrated');
    expect(JSON.stringify(audit)).not.toContain(agentKey);
    expect(JSON.stringify(audit)).not.toContain(occupied.json.seat_credential);
  });

  it('lets an admin mint, inventory, and revoke one scoped credential without exposing its hash', async () => {
    const minted = await post(
      '/teams/dawn/agent-bootstrap-credentials',
      {
        use: 'claim_seat',
        target: 'Ada',
        label: 'ada-workspace',
        expires_at: Date.now() + 60_000,
      },
      nickCred,
    );
    expect(minted.status).toBe(201);
    expect(minted.json.agent_key).toMatch(/^mskey_/);
    expect(minted.json.credential).toMatchObject({
      use: 'claim_seat',
      target: 'Ada',
      label: 'ada-workspace',
      state: 'active',
    });
    expect(minted.json.credential).not.toHaveProperty('key_hash');

    const successor = await post(
      '/teams/dawn/agent-bootstrap-credentials',
      { use: 'claim_seat', target: 'Ada', label: 'ada-successor' },
      nickCred,
    );
    expect(successor.status).toBe(201);

    const inventory = await get('/teams/dawn/agent-bootstrap-credentials', nickCred);
    expect(inventory.status).toBe(200);
    expect(inventory.json.credentials).toContainEqual({
      ...minted.json.credential,
      state: 'rotated',
      rotated_at: expect.any(Number),
    });
    expect(JSON.stringify(inventory.json)).not.toContain(minted.json.agent_key);
    expect(JSON.stringify(inventory.json)).not.toContain('key_hash');

    const revoked = await del(
      `/teams/dawn/agent-bootstrap-credentials/${minted.json.credential.id}`,
      nickCred,
    );
    expect(revoked.status).toBe(200);

    const claim = await post('/teams/dawn/claim', {
      key: minted.json.agent_key,
      target: { seat: 'Ada' },
      grant: await grantFor('Ada'),
      surface: 'cli',
    });
    expect(claim.status).toBe(403);

    const actions = listAudit(server.db, getTeamBySlug(server.db, 'dawn')!.id).map(
      (entry) => entry.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'bootstrap_credential.minted',
        'bootstrap_credential.rotated',
        'bootstrap_credential.revoked',
      ]),
    );
  });

  it('keeps bootstrap credential lifecycle admin-only and rejects an invalid target', async () => {
    const invalid = await post(
      '/teams/dawn/agent-bootstrap-credentials',
      { use: 'claim_seat', target: 'Missing' },
      nickCred,
    );
    expect(invalid.status).toBe(404);
    const expired = await post(
      '/teams/dawn/agent-bootstrap-credentials',
      { use: 'host', target: 'mac.local', expires_at: Date.now() - 1 },
      nickCred,
    );
    expect(expired.status).toBe(400);

    const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickCred);
    const denied = await post(
      '/teams/dawn/agent-bootstrap-credentials',
      { use: 'claim_seat', target: 'Ada' },
      bob.json.human_credential,
    );
    expect(denied.status).toBe(403);
  });

  it('reports readiness to admins and refuses incomplete cutover without force (ADR 350)', async () => {
    const occupied = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant: await grantFor('Ada'),
      surface: 'cli',
    });
    expect(occupied.status).toBe(200);
    const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickCred);

    expect((await get('/teams/dawn/agent-bootstrap-cutover')).status).toBe(401);
    expect(
      (await get('/teams/dawn/agent-bootstrap-cutover', bob.json.human_credential)).status,
    ).toBe(403);
    const readiness = await get('/teams/dawn/agent-bootstrap-cutover', nickCred);
    expect(readiness.status).toBe(200);
    expect(readiness.json).toEqual({
      already_cut_over: false,
      unmet_seats: [
        {
          member_id: expect.any(String),
          name: 'Ada',
        },
      ],
      unmet_hosts: [],
    });

    const refused = await post('/teams/dawn/agent-bootstrap-cutover', {}, nickCred);
    expect(refused.status).toBe(409);
  });

  it('forces cutover idempotently and rejects the old key before claim effects (ADR 350)', async () => {
    const occupied = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant: await grantFor('Ada'),
      surface: 'cli',
    });
    expect(occupied.status).toBe(200);

    const cutover = await post('/teams/dawn/agent-bootstrap-cutover', { force: true }, nickCred);
    expect(cutover.status).toBe(200);
    expect(cutover.json).toMatchObject({
      ok: true,
      already_cut_over: false,
      forced: true,
      readiness: {
        already_cut_over: false,
        unmet_seats: [{ member_id: expect.any(String), name: 'Ada' }],
        unmet_hosts: [],
      },
    });

    const beforeRequests = server.db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM requests')
      .get()!.count;
    const beforePresence = server.db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM presence')
      .get()!.count;
    const refused = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(refused.status).toBe(403);
    expect(refused.json.hint).toContain('musterd team bootstrap mint --seat <name>');
    expect(
      server.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM requests').get()!
        .count,
    ).toBe(beforeRequests);
    expect(
      server.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM presence').get()!
        .count,
    ).toBe(beforePresence);

    const repeated = await post('/teams/dawn/agent-bootstrap-cutover', {}, nickCred);
    expect(repeated.status).toBe(200);
    expect(repeated.json).toMatchObject({
      ok: true,
      already_cut_over: true,
      forced: false,
    });
  });
});

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

  it('refuses a seat-scoped bootstrap credential for a different seat without a request or Presence', async () => {
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickCred);
    const team = getTeamBySlug(server.db, 'dawn')!;
    const scoped = mintBootstrapCredential(server.db, {
      teamId: team.id,
      useKind: 'claim_seat',
      target: 'Ada',
    });
    expect(scoped.credential.first_used_at).toBeNull();

    const r = await post('/teams/dawn/claim', {
      key: scoped.agent_key,
      target: { seat: 'Lin' },
      surface: 'cli',
    });

    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ type: 'refused', code: 'forbidden' });
    expect(r.json.message).toMatch(/only claim.*Ada/i);
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual({ n: 0 });
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM presence').get()).toEqual({ n: 0 });
    const refusalAudit = listAudit(server.db, team.id).find(
      (entry) => entry.action === 'bootstrap_credential.refused',
    );
    expect(refusalAudit).toMatchObject({ target: scoped.credential.id });
    expect(JSON.parse(refusalAudit!.detail!)).toMatchObject({ reason: 'target_mismatch' });
    expect(
      server.db
        .prepare<
          [string],
          { first_used_at: number | null }
        >('SELECT first_used_at FROM agent_bootstrap_credentials WHERE id = ?')
        .get(scoped.credential.id)?.first_used_at,
    ).toBeNull();
  });

  it('accepts a seat-scoped bootstrap credential for its target', async () => {
    const team = getTeamBySlug(server.db, 'dawn')!;
    const scoped = mintBootstrapCredential(server.db, {
      teamId: team.id,
      useKind: 'claim_seat',
      target: 'Ada',
    });

    const r = await post('/teams/dawn/claim', {
      key: scoped.agent_key,
      target: { seat: 'Ada' },
      grant: await grantFor('Ada'),
      surface: 'cli',
    });

    expect(r.status).toBe(200);
    expect(
      server.db
        .prepare<
          [string],
          { first_used_at: number | null }
        >('SELECT first_used_at FROM agent_bootstrap_credentials WHERE id = ?')
        .get(scoped.credential.id)?.first_used_at,
    ).toEqual(expect.any(Number));
  });

  it('accepts a role credential only through its declared role pool and never as a seat key', async () => {
    const team = getTeamBySlug(server.db, 'dawn')!;
    const scoped = mintBootstrapCredential(server.db, {
      teamId: team.id,
      useKind: 'claim_role',
      target: 'backend',
    });
    const grant = await post(
      '/teams/dawn/grants',
      { scope: 'role', target: 'backend', lifetime: 'standing' },
      nickCred,
    );
    const roleClaim = await post('/teams/dawn/claim', {
      key: scoped.agent_key,
      target: { role: 'backend' },
      grant: grant.json.token,
      surface: 'cli',
    });
    expect(roleClaim.status).toBe(200);

    const seatClaim = await post('/teams/dawn/claim', {
      key: scoped.agent_key,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(seatClaim.status).toBe(403);
  });

  it('never accepts a host credential on a claim route', async () => {
    const team = getTeamBySlug(server.db, 'dawn')!;
    const host = mintBootstrapCredential(server.db, {
      teamId: team.id,
      useKind: 'host',
      target: 'mac.local',
    });
    const claim = await post('/teams/dawn/claim', {
      key: host.agent_key,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(claim.status).toBe(403);
  });

  it('audits an expired credential by opaque id without creating a request or Presence', async () => {
    const team = getTeamBySlug(server.db, 'dawn')!;
    const scoped = mintBootstrapCredential(server.db, {
      teamId: team.id,
      useKind: 'claim_seat',
      target: 'Ada',
      expiresAt: Date.now() + 60_000,
    });
    server.db
      .prepare('UPDATE agent_bootstrap_credentials SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, scoped.credential.id);

    const claim = await post('/teams/dawn/claim', {
      key: scoped.agent_key,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(claim.status).toBe(403);
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual({ n: 0 });
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM presence').get()).toEqual({ n: 0 });
    expect(listAudit(server.db, team.id)).toContainEqual(
      expect.objectContaining({
        action: 'bootstrap_credential.expired',
        target: scoped.credential.id,
      }),
    );
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
  it('mints a self-identifying credential and Presence-bound lease for agent HTTP authority', async () => {
    const grant = await grantFor('Ada');
    const claim = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant,
      surface: 'cli',
    });
    expect(claim.status).toBe(200);
    expect(claim.json.seat_credential).toMatch(/^msac_/);
    expect(claim.json.session_lease).toMatch(/^msls_/);

    const sharedKey = await get('/teams/dawn/inbox', { key: agentKey, seat: 'Ada' });
    expect(sharedKey.status).toBe(401);

    const noLease = await get('/teams/dawn/inbox', claim.json.seat_credential);
    expect(noLease.status).toBe(401);

    const valid = await fetch(base + '/teams/dawn/inbox', {
      headers: {
        authorization: `Bearer ${claim.json.seat_credential}`,
        'x-musterd-session-lease': claim.json.session_lease,
      },
    });
    expect(valid.status).toBe(200);

    const impersonation = await fetch(base + '/teams/dawn/inbox', {
      headers: {
        authorization: `Bearer ${claim.json.seat_credential}`,
        'x-musterd-seat': 'nick',
        'x-musterd-session-lease': claim.json.session_lease,
      },
    });
    expect(impersonation.status).toBe(403);

    server.db.prepare('UPDATE session_leases SET expires_at = ?').run(Date.now() - 1);
    const expired = await fetch(base + '/teams/dawn/inbox', {
      headers: {
        authorization: `Bearer ${claim.json.seat_credential}`,
        'x-musterd-session-lease': claim.json.session_lease,
      },
    });
    expect(expired.status).toBe(401);
  });

  it('rotation immediately invalidates an agent credential and all of its leases', async () => {
    const claim = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant: await grantFor('Ada'),
      surface: 'cli',
    });
    const rotated = await post(
      '/teams/dawn/members/Ada/agent-seat-credential/rotate',
      {},
      nickCred,
    );
    expect(rotated.status).toBe(200);
    expect(rotated.json.seat_credential).toMatch(/^msac_/);
    expect(rotated.json.seat_credential).not.toBe(claim.json.seat_credential);

    const old = await fetch(base + '/teams/dawn/inbox', {
      headers: {
        authorization: `Bearer ${claim.json.seat_credential}`,
        'x-musterd-session-lease': claim.json.session_lease,
      },
    });
    expect(old.status).toBe(401);

    const team = getTeamBySlug(server.db, 'dawn')!;
    const actions = listAudit(server.db, team.id).map((row) => row.action);
    expect(actions).toContain('agent_seat_credential.rotated');
    expect(actions).toContain('agent_session_lease.revoked');
  });

  it('uses claimed agent authority on the residency session route', async () => {
    const claim = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant: await grantFor('Ada'),
      surface: 'cli',
    });
    await post(
      '/teams/dawn/residency/enroll',
      { seat: 'Ada', harness: 'claude-code', host: 'laptop.local' },
      nickCred,
    );

    const session = await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start' },
      {
        key: claim.json.seat_credential,
        seat: 'Ada',
        sessionLease: claim.json.session_lease,
      },
    );
    expect(session.status).toBe(200);
  });

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
    expect(r.json).toMatchObject({ type: 'occupied', charter: 'Own the rails.' });
    expect(r.json.seat.name).toBe('Ada');
    expect(r.json.presence_id).toBeTruthy();

    const team = getTeamBySlug(server.db, 'dawn')!;
    const actions = listAudit(server.db, team.id).map((a) => a.action);
    expect(actions).toContain('claim.occupied');
    expect(actions).toContain('occupancy.model_attested');
  });

  /**
   * ADR 246, at the wire. A seat that HAS been attesting and then claims attesting nothing has left
   * the ADR 188 review pool, and until now that produced no ledger row of any kind — the claim path
   * audited only the attested case, so the loss was invisible even in hindsight. `new: null` is the
   * shape `review.ts` has always read and nothing had ever written.
   */
  it('a claim attesting nothing after an attested one records the de-attestation (ADR 246)', async () => {
    const grant = await grantFor('Ada');
    await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant,
      surface: 'cli',
      model: 'claude-opus-4-8',
    });
    const second = await grantFor('Ada');
    const r = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant: second,
      surface: 'cli', // no model — the harness attests nothing this time
    });
    expect(r.status).toBe(200);

    const team = getTeamBySlug(server.db, 'dawn')!;
    const drops = listAudit(server.db, team.id)
      .filter((a) => a.action === 'occupancy.model_attested')
      .map((a) => JSON.parse(a.detail ?? '{}') as { old: unknown; new: unknown });
    expect(drops).toContainEqual(
      expect.objectContaining({ old: 'claude-opus-4-8', new: null, source: 'claim' }),
    );
  });

  it('a seat that never attested claims silently — no de-attestation row (ADR 246)', async () => {
    // `unknown` from the start is not a loss. Emitting here would bury the real drops under rows
    // about harnesses that simply cannot attest yet (ADR 158: Codex, today).
    const grant = await grantFor('Ada');
    await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant,
      surface: 'cli',
    });
    const team = getTeamBySlug(server.db, 'dawn')!;
    expect(
      listAudit(server.db, team.id).filter((a) => a.action === 'occupancy.model_attested'),
    ).toHaveLength(0);
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
    // STRENGTHENED (install-topology L1): the intent here — "a human seat is never auto-occupiable
    // via the team key" — is unchanged, but falling through to the request lane was the weak way to
    // achieve it. That queued a poisoned claim for an admin to approve and left a pending row behind.
    // The seat-kind guard now refuses outright, before the grant/request branches.
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('forbidden');
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

  it('replaces the stateless Presence when approving a later HTTP claim', async () => {
    const first = await openPending();
    expect(
      (
        await post(
          `/teams/dawn/requests/${first}/decide`,
          { decision: 'approve', lifetime: 'standing' },
          nickCred,
        )
      ).status,
    ).toBe(200);

    const second = await openPending();
    expect(
      (
        await post(
          `/teams/dawn/requests/${second}/decide`,
          { decision: 'approve', lifetime: 'standing' },
          nickCred,
        )
      ).status,
    ).toBe(200);

    const roster = await get('/teams/dawn/members', nickCred);
    expect(roster.json.members.find((member: any) => member.name === 'Ada').presences).toHaveLength(
      1,
    );

    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    const eviction = listAudit(server.db, teamId).find(
      (row) =>
        row.action === 'claim.superseded' &&
        JSON.parse(row.detail ?? '{}').via === 'request.approve',
    )!;
    expect(JSON.parse(eviction.detail ?? '{}')).toMatchObject({ evicted: 1 });
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

  it('refuses the bootstrap team key on an admin decision route', async () => {
    const id = await openPending();
    const r = await post(
      `/teams/dawn/requests/${id}/decide`,
      { decision: 'approve', lifetime: 'once' },
      { key: agentKey, seat: 'Ada' },
    );
    expect(r.status).toBe(401);
  });
});
