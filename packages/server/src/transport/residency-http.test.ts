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
