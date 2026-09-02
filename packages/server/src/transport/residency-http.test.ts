import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { openLane, updateLane } from '../store/lanes.js';
import { getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { listWakeTurns } from '../store/residency.js';
import { getTeamBySlug, mintBootstrapCredential, setPolicy } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

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
let adaAuth: AgentHttpAuth;
let nickCred: string;

function authHeaders(auth?: string | AgentHttpAuth): Record<string, string> {
  if (!auth) return {};
  if (typeof auth === 'string') return { authorization: `Bearer ${auth}` };
  return {
    authorization: `Bearer ${auth.key}`,
    'x-musterd-seat': auth.seat,
    'x-musterd-session-lease': auth.sessionLease,
  };
}
async function post(path: string, body: unknown, auth?: string | AgentHttpAuth) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // reason: route shapes vary per endpoint; each assertion narrows what it reads.

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

async function claimAda(): Promise<void> {
  adaAuth = await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Ada');
}

describe('host-scoped bootstrap credentials', () => {
  it.each([
    ['/teams/dawn/residency/wake-leases', { host: 'laptop.local' }],
    ['/teams/dawn/residency/wake-progress', { lease_id: 'missing' }],
    [
      '/teams/dawn/residency/wake-turn',
      { lease_id: 'missing', turn: 1, usage: { input_tokens: 1, output_tokens: 1 } },
    ],
    [
      '/teams/dawn/residency/wake-report',
      { lease_id: 'missing', occupied: false, reason: 'failed' },
    ],
  ] as const)(
    'rejects the retired legacy key on %s before residency effects (ADR 350)',
    async (path, body) => {
      const before = server.db
        .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM wake_leases')
        .get()!.count;
      const cutover = await post('/teams/dawn/agent-bootstrap-cutover', { force: true }, nickCred);
      expect(cutover.status).toBe(200);

      const refused = await post(path, body, agentKey);
      expect(refused.status).toBe(401);
      expect(refused.json.error.message).toContain('musterd team bootstrap mint --seat <name>');
      expect(
        server.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM wake_leases').get()!
          .count,
      ).toBe(before);
    },
  );

  it('accepts only its recorded host label for wake lease polling', async () => {
    const team = getTeamBySlug(server.db, 'dawn')!;
    const hostKey = mintBootstrapCredential(server.db, {
      teamId: team.id,
      useKind: 'host',
      target: 'laptop.local',
    });

    const allowed = await post(
      '/teams/dawn/residency/wake-leases',
      { host: 'laptop.local' },
      hostKey.agent_key,
    );
    expect(allowed.status).toBe(200);
    expect(
      server.db
        .prepare<
          [string],
          { first_used_at: number | null }
        >('SELECT first_used_at FROM agent_bootstrap_credentials WHERE id = ?')
        .get(hostKey.credential.id)?.first_used_at,
    ).toEqual(expect.any(Number));

    const refused = await post(
      '/teams/dawn/residency/wake-leases',
      { host: 'other-host.local' },
      hostKey.agent_key,
    );
    expect(refused.status).toBe(401);
  });
});

describe('POST /teams/:slug/residency/session — the resumable attestation', () => {
  beforeEach(async () => {
    await claimAda();
  });

  it('start on an enrolled seat: records harness class + timestamp, audits session_captured', async () => {
    await enrollAda();
    const r = await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start' },
      adaAuth,
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

  // ADR 131 Consequences, follow-up note 2026-08-05: the row must be able to name its own subject. Two events carrying the
  // same digest are one session; the same two without it are indistinguishable from two sessions,
  // which is the ambiguity that made 48 same-seat captured→ended pairs unreadable on 2026-08-05.
  it('carries the correlation digest through to the audit row, and never anything id-shaped', async () => {
    await enrollAda();
    for (const event of ['start', 'end'] as const) {
      const r = await post(
        '/teams/dawn/residency/session',
        { seat: 'Ada', harness: 'claude-code', event, session_digest: 'a1b2c3d4e5f6' },
        adaAuth,
      );
      expect(r.status).toBe(200);
    }
    for (const action of ['residency.session_captured', 'residency.session_ended'] as const) {
      const rows = audits(action);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.detail as string)).toEqual({
        harness: 'claude-code',
        enrolled: true,
        session_digest: 'a1b2c3d4e5f6',
      });
    }
  });

  // Presence-honesty §2.3: a clean session exit is the one goodbye the daemon actually hears, so
  // `end` stamps the sticky reason — a normally-finished session must not wear crash clothing.
  // The route stays presence-neutral: only the sticky member stamp moves, no presence row.
  it('end stamps session_ended as the sticky offline reason; start does not', async () => {
    await enrollAda();
    const team = getTeamBySlug(server.db, 'dawn')!;
    const ada = () => getMemberByName(server.db, team.id, 'Ada')!;

    await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start' },
      adaAuth,
    );
    expect(ada().last_offline_reason).toBeNull();

    await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'end' },
      adaAuth,
    );
    expect(ada().last_offline_reason).toBe('session_ended');

    const roster = await get('/teams/dawn/members', nickCred);
    // The claimed Presence is still live, so the roster correctly suppresses an offline-only label.
    expect(roster.json.members.find((m: any) => m.name === 'Ada').offline_reason).toBeUndefined();
  });

  // ADR 252: the identity join between a wake and the session it paid for. `wake_cost` exists only
  // on the report path, so without this token a lease that spawns a session and then expires is
  // free as far as the ledger can tell.
  it('carries the attested wake lease onto the captured/ended rows, and omits it when unstamped', async () => {
    await enrollAda();
    for (const event of ['start', 'end'] as const) {
      const r = await post(
        '/teams/dawn/residency/session',
        { seat: 'Ada', harness: 'claude-code', event, wake_lease: 'L-42' },
        adaAuth,
      );
      expect(r.status).toBe(200);
    }
    for (const action of ['residency.session_captured', 'residency.session_ended'] as const) {
      expect(JSON.parse(audits(action)[0]!.detail as string)).toMatchObject({ wake_lease: 'L-42' });
    }

    // An ordinary session carries no token and asserts nothing (ADR 236) — the field is absent,
    // never a placeholder that would let an unwoken session join a lease it knows nothing about.
    await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start' },
      adaAuth,
    );
    const captured = audits('residency.session_captured').map(
      (r) => JSON.parse(r.detail as string) as Record<string, unknown>,
    );
    expect(captured).toHaveLength(2);
    expect(captured.filter((d) => 'wake_lease' in d)).toHaveLength(1);
  });

  it('rejects a session_digest that is not a digest — the field cannot become an id smuggler', async () => {
    await enrollAda();
    const r = await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start', session_digest: 'sid-1234-abcd' },
      adaAuth,
    );
    expect(r.status).toBe(400);
    expect(audits('residency.session_captured')).toHaveLength(0);
  });

  it('is presence-neutral and never changes the claimed Presence', async () => {
    await enrollAda();
    const before = await get('/teams/dawn/members', nickCred);
    const beforeAda = before.json.members.find((m: { name: string }) => m.name === 'Ada');
    await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start' },
      adaAuth,
    );
    const status = await get('/teams/dawn/members', nickCred);
    const ada = status.json.members.find((m: { name: string }) => m.name === 'Ada');
    expect(ada.presences).toEqual(beforeAda.presences);
  });

  it('an unenrolled capture still audits (enrolled:false), updates nothing', async () => {
    const r = await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'end' },
      adaAuth,
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
      adaAuth,
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
    await claimAda();
    await enrollAda();
    // Give Ada a live ambient presence via an authenticated read as the seat.
    const touched = await fetch(base + '/teams/dawn/inbox', {
      headers: authHeaders(adaAuth),
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
    await claimAda();
    const read = async (provenance?: string) => {
      const res = await fetch(base + '/teams/dawn/inbox?seat=Ada', {
        headers: {
          ...authHeaders(adaAuth),
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

describe('x-musterd-wake-lease — the ambient touch carries the correlation token (ADR 241)', () => {
  it('an agent-key touch stamps the lease; a human credential can never stamp one', async () => {
    await claimAda();
    const adaLease = async () => {
      const status = await get('/teams/dawn/members', nickCred);
      return status.json.members.find((m: { name: string }) => m.name === 'Ada').presences[0]
        .wake_lease;
    };
    const read = async (lease?: string) => {
      const res = await fetch(base + '/teams/dawn/inbox?seat=Ada', {
        headers: {
          ...authHeaders(adaAuth),
          'x-musterd-provenance': 'wake',
          ...(lease ? { 'x-musterd-wake-lease': lease } : {}),
        },
      });
      expect(res.status).toBe(200);
    };
    await read('L-77');
    expect(await adaLease()).toBe('L-77');

    // The woken session's later touches keep carrying it; a touch that carries none clears it,
    // travelling with provenance rather than sticking like model/build (ADR 241).
    await read();
    expect(await adaLease()).toBeNull();

    // A human credential stamps nothing — same gate as model and provenance (ADR 121). A lease
    // token in a human's shell must never let that shell pose as a machine's wake.
    const res = await fetch(base + '/teams/dawn/inbox', {
      headers: { ...authHeaders(nickCred), 'x-musterd-wake-lease': 'L-99' },
    });
    expect(res.status).toBe(200);
    const status = await get('/teams/dawn/members', nickCred);
    const nick = status.json.members.find((m: { name: string }) => m.name === 'nick');
    expect(nick.presences.every((p: { wake_lease: string | null }) => p.wake_lease === null)).toBe(
      true,
    );
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
      {
        lease_id: leaseId,
        occupied: true,
        session: 'fresh',
        delivery_outcome: 'fresh',
        transcript_bytes: 4096,
        transcript_age_ms: 12_000,
      },
      agentKey,
    );
    expect(primary.status).toBe(200);
    return leaseId;
  }

  /** Enroll + one urgent act + claim the lease, without reporting it. */
  async function freshLease(actId: string): Promise<string> {
    await enrollAda();
    await post(
      '/teams/dawn/messages',
      {
        envelope: makeEnvelope({
          id: actId,
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
    return leases.json.orders[0].lease_id as string;
  }

  // ADR 210's Eval splits the eligible cohort by exact-match result, so the result has to survive
  // the wire onto BOTH audit rows the Eval reads. Before this it existed only in a host log line.
  it('carries the exact-match result onto residency.woke and residency.wake_cost', async () => {
    const leaseId = await freshLease('em1');
    const primary = await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: true, session: 'fresh', exact_match: 'stale' },
      agentKey,
    );
    expect(primary.status).toBe(200);
    expect(JSON.parse(audits('residency.woke')[0]!.detail as string)).toMatchObject({
      exact_match: 'stale',
    });

    const supplement = await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: true, cost_usd: 0.1, exact_match: 'stale' },
      agentKey,
    );
    expect(supplement.status).toBe(200);
    expect(JSON.parse(audits('residency.wake_cost')[0]!.detail as string)).toMatchObject({
      exact_match: 'stale',
    });
  });

  it('a report with no exact_match records none — absent means never considered', async () => {
    const leaseId = await freshLease('em2');
    await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: true, session: 'fresh' },
      agentKey,
    );
    expect(JSON.parse(audits('residency.woke')[0]!.detail as string)).not.toHaveProperty(
      'exact_match',
    );
  });

  it('a second report carrying cost lands as residency.wake_cost (200 cost_recorded)', async () => {
    const leaseId = await reportedLease();
    const supplement = await post(
      '/teams/dawn/residency/wake-report',
      {
        lease_id: leaseId,
        occupied: true,
        cost_usd: 0.42,
        duration_ms: 34_000,
        delivery_outcome: 'fresh',
        transcript_bytes: 4096,
        transcript_age_ms: 12_000,
      },
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
      delivery_outcome: 'fresh',
      transcript_bytes: 4096,
      transcript_age_ms: 12_000,
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

  // ADR 273. The ledger could not say "I refused this", and that silence — not the type error —
  // is why ADR 269's defect ran ~3 weeks and cost $22.54: 48 refused reports, zero audit rows, so
  // the gap read as "the host never answered" on rows that said `lease_expired`. Two seats read
  // the write path correctly and both concluded nothing was lying, because absence of a cost row
  // is indistinguishable from absence of a cost when the refusal writes nothing.
  describe('a refused wake report leaves a ledger trace (ADR 273)', () => {
    it('audits the refusal against the lease, naming the field and not the value', async () => {
      const leaseId = await freshLease('u9');
      const bad = await post(
        '/teams/dawn/residency/wake-report',
        // Negative age: the one shape ADR 269 still refuses on purpose.
        { lease_id: leaseId, occupied: true, transcript_age_ms: -1 },
        agentKey,
      );
      expect(bad.status).toBe(400);
      const rows = audits('residency.wake_report_rejected');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result).toBe('deny');
      expect(rows[0]!.target).toBe('Ada');
      expect(JSON.parse(rows[0]!.detail as string)).toMatchObject({
        lease_id: leaseId,
        fields: [{ path: 'transcript_age_ms', code: 'too_small' }],
      });
    });

    it('records type NAMES, never the offending value (ADR 128 stays narrow)', async () => {
      const leaseId = await freshLease('u9');
      await post(
        '/teams/dawn/residency/wake-report',
        { lease_id: leaseId, occupied: true, reason: 12345, transcript_bytes: 'sk-secret-value' },
        agentKey,
      );
      const detail = audits('residency.wake_report_rejected')[0]!.detail as string;
      expect(detail).not.toContain('sk-secret-value');
      expect(detail).not.toContain('12345');
      expect(detail).toContain('transcript_bytes');
      // The ADR 269 signature has to survive: which field, and which types were involved.
      expect(JSON.parse(detail).fields).toContainEqual(
        expect.objectContaining({
          path: 'transcript_bytes',
          expected: 'number',
          received: 'string',
        }),
      );
    });

    it('audits even when the body cannot name its own lease — the refusal is never silent', async () => {
      await enrollAda();
      const bad = await post('/teams/dawn/residency/wake-report', { occupied: true }, agentKey);
      expect(bad.status).toBe(400);
      const rows = audits('residency.wake_report_rejected');
      expect(rows).toHaveLength(1);
      const detail = JSON.parse(rows[0]!.detail as string);
      expect(detail).not.toHaveProperty('lease_id');
      expect(detail.fields).toContainEqual(expect.objectContaining({ path: 'lease_id' }));
    });

    it('a lease id that names nothing is still audited, with no seat invented', async () => {
      await enrollAda();
      await post(
        '/teams/dawn/residency/wake-report',
        { lease_id: 'nosuchlease', occupied: 'yes' },
        agentKey,
      );
      const rows = audits('residency.wake_report_rejected');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.target).toBe('?');
      expect(JSON.parse(rows[0]!.detail as string).lease_id).toBe('nosuchlease');
    });

    it('a report the schema accepts writes no rejection row', async () => {
      await reportedLease();
      expect(audits('residency.wake_report_rejected')).toHaveLength(0);
    });

    it('the wake report counts refusals so the ledger says it out loud', async () => {
      const leaseId = await freshLease('u9');
      await post(
        '/teams/dawn/residency/wake-report',
        { lease_id: leaseId, occupied: true, transcript_age_ms: -1 },
        agentKey,
      );
      const report = await get('/teams/dawn/report', nickCred);
      expect(report.json.wake.reports_rejected).toBe(1);
    });
  });
});

describe('roster resumable_at (ADR 131 inc 5, finding b)', () => {
  it('projects the capture timestamp for enrolled seats; null before any capture', async () => {
    await claimAda();
    await enrollAda();
    let status = await get('/teams/dawn/members', nickCred);
    let ada = status.json.members.find((m: { name: string }) => m.name === 'Ada');
    expect(ada.wakeable).toBe(true);
    expect(ada.resumable_at).toBeNull();

    await post(
      '/teams/dawn/residency/session',
      { seat: 'Ada', harness: 'claude-code', event: 'start' },
      adaAuth,
    );
    status = await get('/teams/dawn/members', nickCred);
    ada = status.json.members.find((m: { name: string }) => m.name === 'Ada');
    expect(ada.resumable_at).toBeGreaterThan(0);
  });
});

describe('POST /wake-context — residency.context_read audit (ADR 209 follow-up)', () => {
  async function postAsAda(path: string, body: unknown) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(adaAuth),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  async function directedToAda(id = 'wc1'): Promise<void> {
    const send = await post(
      '/teams/dawn/messages',
      {
        envelope: makeEnvelope({
          id,
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'Ada' },
          act: 'message',
          body: 'orient from the packet',
        }),
      },
      nickCred,
    );
    expect(send.status).toBe(201);
  }

  it('allow path records kind, version, bytes, fetch categories/count, and delivery', async () => {
    await claimAda();
    await directedToAda();
    const r = await postAsAda('/teams/dawn/wake-context', { act_id: 'wc1' });
    expect(r.status).toBe(200);
    expect(r.json.context.wake.kind).toBe('reply');

    const rows = audits('residency.context_read');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('Ada');
    expect(rows[0]!.target).toBe('wc1');
    expect(rows[0]!.result).toBe('allow');
    const detail = JSON.parse(rows[0]!.detail as string);
    expect(detail).toMatchObject({
      kind: 'reply',
      version: 1,
      fetch: ['inbox_thread', 'seat_memory'],
      fetch_count: 2,
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(detail.bytes).toBeGreaterThan(0);
    // Never a body — categories and counts only.
    expect(JSON.stringify(detail)).not.toContain('orient from the packet');
  });

  it('forbidden path audits deny without disclosing whether the target exists', async () => {
    await directedToAda('secret-act');
    // Bob is not a member yet — use a second agent who is not the recipient.
    await post('/teams/dawn/members', { name: 'Bob', kind: 'agent' }, nickCred);
    const bobAuth = await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Bob');
    const res = await fetch(base + '/teams/dawn/wake-context', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(bobAuth),
      },
      body: JSON.stringify({ act_id: 'secret-act' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code ?? body.code).toBe('forbidden');

    const rows = audits('residency.context_read');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('Bob');
    expect(rows[0]!.target).toBe('secret-act');
    expect(rows[0]!.result).toBe('deny');
    expect(JSON.parse(rows[0]!.detail as string)).toEqual({
      reason: 'forbidden',
      target_kind: 'act',
    });
  });

  it('forbidden for a missing target looks identical in the audit (no existence leak)', async () => {
    await claimAda();
    const r = await postAsAda('/teams/dawn/wake-context', { act_id: 'no-such-act' });
    expect(r.status).toBe(403);
    const rows = audits('residency.context_read');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe('deny');
    expect(JSON.parse(rows[0]!.detail as string)).toEqual({
      reason: 'forbidden',
      target_kind: 'act',
    });
  });
});

describe('POST /teams/:slug/residency/wake-turn — per-turn telemetry + capture (ADR 251 §7)', () => {
  async function leaseForUrgentAct(): Promise<string> {
    await enrollAda();
    const send = await post(
      '/teams/dawn/messages',
      {
        envelope: makeEnvelope({
          id: 'u9',
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

  const turnBody = (leaseId: string, turn: number, cost: number) => ({
    lease_id: leaseId,
    turn,
    usage: { input_tokens: 1000 * turn, output_tokens: 100 * turn },
    cost_usd: cost,
    stop_reason: turn === 2 ? 'end_turn' : 'tool_use',
    transcript: { assistant: [{ type: 'text', text: `turn ${turn}` }], tool_results: null },
  });

  it('appends turn rows against a live lease, idempotent per (lease, turn)', async () => {
    const leaseId = await leaseForUrgentAct();
    const team = getTeamBySlug(server.db, 'dawn')!;

    const r1 = await post(
      '/teams/dawn/residency/wake-turn',
      turnBody(leaseId, 1, 0.0075),
      agentKey,
    );
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ ok: true, lease_id: leaseId, turn: 1 });
    await post('/teams/dawn/residency/wake-turn', turnBody(leaseId, 2, 0.015), agentKey);
    // A retried post of turn 2 overwrites — never a duplicate row.
    const retry = await post(
      '/teams/dawn/residency/wake-turn',
      { ...turnBody(leaseId, 2, 0.016) },
      agentKey,
    );
    expect(retry.status).toBe(200);

    const rows = listWakeTurns(server.db, team.id, leaseId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.turn)).toEqual([1, 2]);
    expect(rows[1]!.cost_usd).toBeCloseTo(0.016, 9);
    expect(rows[0]!.usage.input_tokens).toBe(1000);
    expect(rows[0]!.transcript).toMatchObject({ assistant: [{ type: 'text', text: 'turn 1' }] });
  });

  it('accepts turns after the lease settled — outcome resolves at verify, the loop runs on', async () => {
    const leaseId = await leaseForUrgentAct();
    const settle = await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: true },
      agentKey,
    );
    expect(settle.status).toBe(200);
    const r = await post('/teams/dawn/residency/wake-turn', turnBody(leaseId, 1, 0.01), agentKey);
    expect(r.status).toBe(200);
    const team = getTeamBySlug(server.db, 'dawn')!;
    expect(listWakeTurns(server.db, team.id, leaseId)).toHaveLength(1);
  });

  it('404s an unknown lease and rejects a missing key', async () => {
    await enrollAda();
    const missing = await post(
      '/teams/dawn/residency/wake-turn',
      { lease_id: 'nope', turn: 1, usage: { input_tokens: 1, output_tokens: 1 } },
      agentKey,
    );
    expect(missing.status).toBe(404);
    const unauthed = await post('/teams/dawn/residency/wake-turn', {
      lease_id: 'nope',
      turn: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(unauthed.status).toBeGreaterThanOrEqual(401);
  });
});

describe('POST /teams/:slug/residency/wake-progress (ADR 262)', () => {
  async function leaseReviewOrder(): Promise<string> {
    const enroll = await post(
      '/teams/dawn/residency/enroll',
      {
        seat: 'Ada',
        harness: 'claude-code',
        host: 'laptop.local',
        policy: { flow: 'auto' },
      },
      nickCred,
    );
    expect(enroll.status).toBe(201);
    const team = getTeamBySlug(server.db, 'dawn')!;
    setPolicy(server.db, team.id, { loops: { review: true } });
    const nick = getMemberByName(server.db, team.id, 'nick')!;
    const ada = getMemberByName(server.db, team.id, 'Ada')!;
    const lane = openLane(server.db, team.id, team.slug, nick.name, {
      title: 'a change',
      claim: true,
    });
    updateLane(server.db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    insertMessage(
      server.db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: 'ask1',
        team: team.slug,
        from: nick.name,
        to: { kind: 'member', name: ada.name },
        act: 'ask',
        body: 'x',
        meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
        ts: 1_000,
      }),
    );
    const leased = await post(
      '/teams/dawn/residency/wake-leases',
      { host: 'laptop.local' },
      agentKey,
    );
    expect(leased.status).toBe(200);
    expect(leased.json.orders).toHaveLength(1);
    return leased.json.orders[0].lease_id as string;
  }

  it('stamps spawned_at, does not settle, idempotent, 404 unknown, agent-key auth', async () => {
    const leaseId = await leaseReviewOrder();

    const unauth = await post('/teams/dawn/residency/wake-progress', { lease_id: leaseId });
    expect(unauth.status).toBe(401);

    const first = await post(
      '/teams/dawn/residency/wake-progress',
      { lease_id: leaseId },
      agentKey,
    );
    expect(first.status).toBe(200);
    expect(first.json.ok).toBe(true);
    expect(first.json.lease_id).toBe(leaseId);
    expect(typeof first.json.spawned_at).toBe('number');

    const again = await post(
      '/teams/dawn/residency/wake-progress',
      { lease_id: leaseId },
      agentKey,
    );
    expect(again.status).toBe(200);
    expect(again.json.spawned_at).toBe(first.json.spawned_at);

    const missing = await post(
      '/teams/dawn/residency/wake-progress',
      { lease_id: 'nope' },
      agentKey,
    );
    expect(missing.status).toBe(404);

    const report = await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: true, session: 'fresh' },
      agentKey,
    );
    expect(report.status).toBe(200);
  });

  it('accepts a host credential across the lifecycle of a lease assigned to its recorded host', async () => {
    const leaseId = await leaseReviewOrder();
    const team = getTeamBySlug(server.db, 'dawn')!;
    const hostKey = mintBootstrapCredential(server.db, {
      teamId: team.id,
      useKind: 'host',
      target: 'laptop.local',
    });
    expect(hostKey.credential.first_used_at).toBeNull();

    const allowed = await post(
      '/teams/dawn/residency/wake-progress',
      { lease_id: leaseId },
      hostKey.agent_key,
    );
    expect(allowed.status).toBe(200);
    expect(
      server.db
        .prepare<
          [string],
          { first_used_at: number | null }
        >('SELECT first_used_at FROM agent_bootstrap_credentials WHERE id = ?')
        .get(hostKey.credential.id)?.first_used_at,
    ).toEqual(expect.any(Number));

    const turn = await post(
      '/teams/dawn/residency/wake-turn',
      { lease_id: leaseId, turn: 1, usage: { input_tokens: 1, output_tokens: 1 } },
      hostKey.agent_key,
    );
    expect(turn.status).toBe(200);

    const report = await post(
      '/teams/dawn/residency/wake-report',
      { lease_id: leaseId, occupied: true, session: 'fresh' },
      hostKey.agent_key,
    );
    expect(report.status).toBe(200);
  });
});

describe('roster wakeability (ADR 357) — the wake-leases poll is the host heartbeat', () => {
  const adaRow = async () => {
    const roster = await get('/teams/dawn/members', nickCred);
    return roster.json.members.find((m: { name: string }) => m.name === 'Ada');
  };

  it('an enrolled seat on a host this daemon has never heard from is wakeable — unknown never demotes', async () => {
    await enrollAda();
    const ada = await adaRow();
    expect(ada.wakeable).toBe(true);
    expect(ada.wakeability).toBe('wakeable');
  });

  it('the poll records the host; silence past HOST_STALE_MS reads enrolled_host_stale while `wakeable` stays true', async () => {
    await enrollAda();
    const polled = await post(
      '/teams/dawn/residency/wake-leases',
      { host: 'laptop.local' },
      agentKey,
    );
    expect(polled.status).toBe(200);
    const team = getTeamBySlug(server.db, 'dawn')!;
    const seen = server.db
      .prepare<
        [string, string],
        { seen_at: number }
      >('SELECT seen_at FROM host_liveness WHERE team_id = ? AND host = ?')
      .get(team.id, 'laptop.local');
    expect(seen?.seen_at).toEqual(expect.any(Number));
    expect((await adaRow()).wakeability).toBe('wakeable');

    // The actuator goes quiet: age the sighting past the line instead of waiting a minute.
    server.db
      .prepare('UPDATE host_liveness SET seen_at = ? WHERE team_id = ? AND host = ?')
      .run(Date.now() - 61_000, team.id, 'laptop.local');
    const stale = await adaRow();
    expect(stale.wakeability).toBe('enrolled_host_stale');
    expect(stale.wakeable).toBe(true); // enrolment is a different fact, and it did not change

    // One more poll and it is reachable again.
    await post('/teams/dawn/residency/wake-leases', { host: 'laptop.local' }, agentKey);
    expect((await adaRow()).wakeability).toBe('wakeable');
  });

  it('a seat that is not enrolled reads not_enrolled and wakeable=false', async () => {
    const ada = await adaRow();
    expect(ada.wakeable).toBe(false);
    expect(ada.wakeability).toBe('not_enrolled');
  });
});
