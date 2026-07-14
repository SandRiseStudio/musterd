import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * Direct HTTP coverage for the increment-4 residency surfaces (ADR 131 §5): the resumable
 * attestation route (`POST /residency/session`) and the `deferred` branch of the wake report.
 * The privacy bar is structural (the schemas carry no id/path fields), so what's asserted here is
 * the behavioral half: agent-key auth, presence-neutrality, the audit verbs, and that a deferral
 * both settles the lease and snoozes the next derivation without burning attempt budget.
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let nickCred: string;

function authHeaders(auth?: string): Record<string, string> {
  return auth ? { authorization: `Bearer ${auth}` } : {};
}
async function post(path: string, body: unknown, auth?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // reason: route shapes vary per endpoint; each assertion narrows what it reads.

  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function get(path: string, auth?: string) {
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

const audits = (action: string) => {
  const team = getTeamBySlug(server.db, 'dawn')!;
  return listAudit(server.db, team.id).filter((r) => r.action === action);
};

async function enrollAda(): Promise<void> {
  const r = await post(
    '/teams/dawn/residency/enroll',
    { seat: 'Ada', harness: 'claude-code', host: 'laptop.local' },
    nickCred,
  );
  expect(r.status).toBe(201);
}

describe('POST /teams/:slug/residency/session — the resumable attestation', () => {
  it('start on an enrolled seat: records harness class + timestamp, audits session_captured', async () => {
    await enrollAda();
    const r = await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start' },
      agentKey,
    );
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, enrolled: true });

    const list = await get('/teams/dawn/residency', nickCred);
    expect(list.json.residency[0].resumable_at).toBeGreaterThan(0);

    const captured = audits('residency.session_captured');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.target).toBe('Ada');
    expect(JSON.parse(captured[0]!.detail as string)).toEqual({
      harness: 'claude-code',
      enrolled: true,
    });
  });

  it('is presence-neutral and never claims: the seat stays offline on the roster', async () => {
    await enrollAda();
    await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start' },
      agentKey,
    );
    const status = await get('/teams/dawn/members', nickCred);
    const ada = status.json.members.find((m: { name: string }) => m.name === 'Ada');
    expect(ada.presence).toBe('offline');
  });

  it('an unenrolled capture still audits (enrolled:false), updates nothing', async () => {
    const r = await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'end' },
      agentKey,
    );
    expect(r.json).toEqual({ ok: true, enrolled: false });
    expect(audits('residency.session_ended')).toHaveLength(1);
  });

  it('refuses a bad key and an unknown seat', async () => {
    const bad = await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start' },
      'mskey_bogus',
    );
    expect(bad.status).toBeGreaterThanOrEqual(401);
    const ghost = await post(
      '/teams/dawn/residency/session',
      { seat: 'Ghost', harness: 'claude-code', event: 'start' },
      agentKey,
    );
    expect(ghost.status).toBe(404);
  });
});

describe('wake-report deferred:true — the local-session guard settles honestly (inc 4)', () => {
  async function leaseForUrgentAct(): Promise<string> {
    await enrollAda();
    const send = await post(
      '/teams/dawn/messages',
      {
        envelope: makeEnvelope({
          id: 'u1',
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'Ada' },
          act: 'message',
          body: 'need you',
          meta: { urgent: true, urgent_reason: 'wake me' },
        }),
      },
      nickCred,
    );
    expect(send.status).toBe(201);
    const leases = await post(
      '/teams/dawn/residency/wake-leases',
      { host: 'laptop.local' },
      agentKey,
    );
    expect(leases.json.orders).toHaveLength(1);
    return leases.json.orders[0].lease_id as string;
  }

  it('audits residency.wake_deferred (never wake_failed), then snoozes the next derivation', async () => {
    const leaseId = await leaseForUrgentAct();
    const r = await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: false, deferred: true, reason: 'local-session-live' },
      agentKey,
    );
    expect(r.status).toBe(200);

    expect(audits('residency.wake_deferred')).toHaveLength(1);
    expect(audits('residency.wake_failed')).toHaveLength(0);
    expect(
      JSON.parse(audits('residency.wake_deferred')[0]!.detail as string) as Record<string, unknown>,
    ).toMatchObject({ reason: 'local-session-live' });

    // The act is still due — but the deferral snoozes derivation (WAKE_DEFER_SNOOZE_MS), so a
    // working human doesn't generate a lease+defer pair every poll tick.
    const again = await post(
      '/teams/dawn/residency/wake-leases',
      { host: 'laptop.local' },
      agentKey,
    );
    expect(again.json.orders).toHaveLength(0);
  });
});

describe('wake policy knobs over HTTP (ADR 131 inc 5)', () => {
  it('enroll stores + audits a sparse policy; re-enroll preserves; {} clears; bad range 400s', async () => {
    const first = await post(
      '/teams/dawn/residency/enroll',
      { seat: 'Ada', harness: 'claude-code', host: 'laptop.local', policy: { hourly_cap: 4 } },
      nickCred,
    );
    expect(first.status).toBe(201);
    expect(first.json.residency.policy).toEqual({ hourly_cap: 4 });
    const enrolled = audits('residency.enrolled');
    expect(JSON.parse(enrolled[0]!.detail as string)).toMatchObject({
      policy: { hourly_cap: 4 },
    });

    // A drift-fixing re-enroll without `policy` must not nuke the tuning.
    await enrollAda();
    const list = await get('/teams/dawn/residency', nickCred);
    expect(list.json.residency[0].policy).toEqual({ hourly_cap: 4 });

    // `{}` is the explicit clear.
    const cleared = await post(
      '/teams/dawn/residency/enroll',
      { seat: 'Ada', harness: 'claude-code', host: 'laptop.local', policy: {} },
      nickCred,
    );
    expect(cleared.json.residency.policy ?? null).toBeNull();

    const bad = await post(
      '/teams/dawn/residency/enroll',
      { seat: 'Ada', harness: 'claude-code', host: 'laptop.local', policy: { attempt_cap: 99 } },
      nickCred,
    );
    expect(bad.status).toBe(400);
  });

  it('names a live seat at enroll time (the grant-rotation warning input)', async () => {
    await enrollAda();
    // Give Ada a live ambient presence via an authenticated read as the seat.
    const touched = await fetch(base + '/teams/dawn/inbox', {
      headers: { authorization: `Bearer ${agentKey}`, 'x-musterd-seat': 'Ada' },
    });
    expect(touched.status).toBe(200);
    const hdrs = { 'content-type': 'application/json', authorization: `Bearer ${nickCred}` };
    const res = await fetch(base + '/teams/dawn/residency/enroll', {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ seat: 'Ada', harness: 'claude-code', host: 'laptop.local' }),
    });
    const json = (await res.json()) as { seat_live?: boolean };
    expect(json.seat_live).toBe(true);
  });

  it('GET /policy round-trips the residency defaults; GET /residency carries policy_defaults', async () => {
    const before = await get('/teams/dawn/policy', nickCred);
    expect(before.status).toBe(200);
    expect(before.json.policy.residency.cooldown_ms).toBe(30 * 60_000);

    const set = await post(
      '/teams/dawn/policy',
      { ...before.json.policy, residency: { ...before.json.policy.residency, hourly_cap: 6 } },
      nickCred,
    );
    expect(set.status).toBe(200);

    const after = await get('/teams/dawn/policy', nickCred);
    expect(after.json.policy.residency.hourly_cap).toBe(6);

    await enrollAda();
    const list = await get('/teams/dawn/residency', nickCred);
    expect(list.json.policy_defaults.hourly_cap).toBe(6);
  });
});

describe('x-musterd-provenance — the ambient touch attests the animation source (inc 5)', () => {
  it('an agent-key read with the header labels the ambient presence `wake`; junk is ignored', async () => {
    const read = async (provenance?: string) => {
      const res = await fetch(base + '/teams/dawn/inbox?seat=Ada', {
        headers: {
          authorization: `Bearer ${agentKey}`,
          'x-musterd-seat': 'Ada',
          ...(provenance ? { 'x-musterd-provenance': provenance } : {}),
        },
      });
      expect(res.status).toBe(200);
    };
    await read('wake');
    let status = await get('/teams/dawn/members', nickCred);
    let ada = status.json.members.find((m: { name: string }) => m.name === 'Ada');
    expect(ada.presences[0].provenance).toBe('wake');

    // Newest-wins (owner call 2026-07-14): a later human-driven touch flips it back to session…
    await read();
    status = await get('/teams/dawn/members', nickCred);
    ada = status.json.members.find((m: { name: string }) => m.name === 'Ada');
    expect(ada.presences[0].provenance).toBe('session');

    // …and an unknown value never lands (enum-validated, silently dropped).
    await read('root');
    status = await get('/teams/dawn/members', nickCred);
    ada = status.json.members.find((m: { name: string }) => m.name === 'Ada');
    expect(ada.presences[0].provenance).toBe('session');
  });
});

describe('supplementary wake-cost report (ADR 131 inc 5)', () => {
  async function reportedLease(): Promise<string> {
    await enrollAda();
    await post(
      '/teams/dawn/messages',
      {
        envelope: makeEnvelope({
          id: 'u2',
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'Ada' },
          act: 'message',
          body: 'need you',
          meta: { urgent: true, urgent_reason: 'wake me' },
        }),
      },
      nickCred,
    );
    const leases = await post(
      '/teams/dawn/residency/wake-leases',
      { host: 'laptop.local' },
      agentKey,
    );
    const leaseId = leases.json.orders[0].lease_id as string;
    const primary = await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: true, session: 'fresh' },
      agentKey,
    );
    expect(primary.status).toBe(200);
    return leaseId;
  }

  it('a second report carrying cost lands as residency.wake_cost (200 cost_recorded)', async () => {
    const leaseId = await reportedLease();
    const supplement = await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: true, cost_usd: 0.42, duration_ms: 34_000 },
      agentKey,
    );
    expect(supplement.status).toBe(200);
    expect(supplement.json.status).toBe('cost_recorded');
    const rows = audits('residency.wake_cost');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.detail as string)).toMatchObject({
      lease_id: leaseId,
      cost_usd: 0.42,
      duration_ms: 34_000,
    });
    // The wake report projection folds it in.
    const report = await get('/teams/dawn/report', nickCred);
    expect(report.json.wake.cost_usd_total).toBeCloseTo(0.42);
    expect(report.json.wake.cost_reported).toBe(1);
  });

  it('a cost-less duplicate still 409s — the double-report guard stays intact', async () => {
    const leaseId = await reportedLease();
    const dup = await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: true },
      agentKey,
    );
    expect(dup.status).toBe(409);
    expect(audits('residency.wake_cost')).toHaveLength(0);
  });
});

describe('roster resumable_at (ADR 131 inc 5, finding b)', () => {
  it('projects the capture timestamp for enrolled seats; null before any capture', async () => {
    await enrollAda();
    let status = await get('/teams/dawn/members', nickCred);
    let ada = status.json.members.find((m: { name: string }) => m.name === 'Ada');
    expect(ada.wakeable).toBe(true);
    expect(ada.resumable_at).toBeNull();

    await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start' },
      agentKey,
    );
    status = await get('/teams/dawn/members', nickCred);
    ada = status.json.members.find((m: { name: string }) => m.name === 'Ada');
    expect(ada.resumable_at).toBeGreaterThan(0);
  });
});
