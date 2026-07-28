import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { __resetHandoffs } from '../store/signinHandoff.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * The sign-in handoff over HTTP (ADR 170) — `musterd board`'s two ends.
 *
 * What's asserted is the security contract the ADR trades on, because it is the reason a nonce may
 * ride a URL at all: the relay grants no authority the caller did not already hold, the nonce is
 * single-use, and every refusal is recorded with a reason (the `off_machine` series being the datum
 * that would earn the cross-device thread).
 */
let server: RunningServer;
let base: string;
let nickCred: string;
let adaCred: string;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
const bearer = (auth: string) => ({ authorization: `Bearer ${auth}` });

const audits = (action: string) => {
  const team = getTeamBySlug(server.db, 'dawn')!;
  return listAudit(server.db, team.id).filter((r) => r.action === action);
};

beforeEach(async () => {
  __resetHandoffs();
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  nickCred = team.json.human_credential;
  const ada = await post('/teams/dawn/members', { name: 'ada', kind: 'human' }, bearer(nickCred));
  adaCred = ada.json.human_credential;
});

afterEach(async () => {
  await server.close();
});

describe('POST /signin-handoff — staging (ADR 170)', () => {
  it('stages with the caller’s own credential and returns a nonce + the TTL it applied', async () => {
    const res = await post('/teams/dawn/signin-handoff', {
      member: 'nick',
      credential: nickCred,
    });
    expect(res.status).toBe(201);
    expect(typeof res.json.nonce).toBe('string');
    expect(res.json.nonce.length).toBeGreaterThanOrEqual(24);
    expect(res.json.expires_in_ms).toBeGreaterThan(0);
    // The nonce is a handle, never a derivation of the secret.
    expect(res.json.nonce).not.toContain(nickCred);
    expect(audits('signin.handoff_staged')).toHaveLength(1);
  });

  it('refuses to launder an identity — ada’s credential cannot stage a handoff for nick', async () => {
    const res = await post('/teams/dawn/signin-handoff', {
      member: 'nick',
      credential: adaCred,
    });
    // 403, not 401: the credential authenticates fine, it simply may not act as another seat — the
    // acting-seat check inside authByCredential is what makes this route a courier, not an issuer.
    expect(res.status).toBe(403);
    expect(audits('signin.handoff_staged')).toHaveLength(0);
  });

  it('refuses an unknown credential outright', async () => {
    const res = await post('/teams/dawn/signin-handoff', {
      member: 'nick',
      credential: 'mscr_not_a_real_credential',
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /signin-handoff/:nonce — redemption (ADR 170)', () => {
  const stage = async (member = 'nick', credential = () => nickCred) => {
    const res = await post('/teams/dawn/signin-handoff', { member, credential: credential() });
    return res.json.nonce as string;
  };

  it('redeems once, returning the identity the browser needs — and never the nonce', async () => {
    const nonce = await stage();
    const res = await get(`/teams/dawn/signin-handoff/${nonce}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ as: 'nick', credential: nickCred });
    const rows = audits('signin.handoff_redeemed');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(nonce);
  });

  it('is single-use: the second redemption 404s and records the miss', async () => {
    const nonce = await stage();
    expect((await get(`/teams/dawn/signin-handoff/${nonce}`)).status).toBe(200);
    const second = await get(`/teams/dawn/signin-handoff/${nonce}`);
    expect(second.status).toBe(404);
    expect(second.json.error.message).toMatch(/already used or has expired/);
    const missed = audits('signin.handoff_missed');
    expect(missed).toHaveLength(1);
    expect(JSON.parse(missed[0]!.detail!).reason).toBe('unknown_or_spent');
  });

  it('an unknown nonce answers exactly like a spent one (a holder learns nothing from the difference)', async () => {
    const res = await get('/teams/dawn/signin-handoff/never-staged-at-all');
    expect(res.status).toBe(404);
    expect(res.json.error.message).toMatch(/already used or has expired/);
  });

  it('is team-scoped — the nonce does not redeem on another team, and stays live for its own', async () => {
    await post('/teams', { slug: 'other', creator: { name: 'sam', kind: 'human' } });
    const nonce = await stage();
    expect((await get(`/teams/other/signin-handoff/${nonce}`)).status).toBe(404);
    expect((await get(`/teams/dawn/signin-handoff/${nonce}`)).status).toBe(200);
  });

  it('requires no bearer — possession of the fresh nonce IS the authorization, by design', async () => {
    const nonce = await stage();
    const res = await get(`/teams/dawn/signin-handoff/${nonce}`);
    expect(res.status).toBe(200);
  });
});
