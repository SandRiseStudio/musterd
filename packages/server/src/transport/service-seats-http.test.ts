import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';

/**
 * ADR 232 increment 1 — ledger seats (`kind: 'service'`), through HTTP.
 *
 * Each exclusion here was a live bug under the rejected "just reuse kind: agent" option, so each
 * gets its own refusal test rather than one happy path: the service token is kind-bound (an agent's
 * stored `mskd_` hash must NOT become a usable credential just because the prefix path returned),
 * the shared agent key can never act as a service, lanes refuse ledger seats on every ownership
 * edge, and residency enrollment refuses them (you cannot wake a LaunchAgent).
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let nickCred: string;
let serviceToken: string;

function authHeaders(auth?: string): Record<string, string> {
  return auth ? { authorization: `Bearer ${auth}` } : {};
}
async function post(path: string, body: unknown, auth?: string, seat?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(auth),
      ...(seat ? { 'x-musterd-seat': seat } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // reason: route shapes vary per endpoint; each assertion narrows what it reads.

  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function patch(path: string, body: unknown, auth?: string, seat?: string) {
  const res = await fetch(base + path, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(auth),
      ...(seat ? { 'x-musterd-seat': seat } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function get(path: string, auth?: string, seat?: string) {
  const res = await fetch(base + path, {
    headers: { ...authHeaders(auth), ...(seat ? { 'x-musterd-seat': seat } : {}) },
  });
  const text = await res.text();

  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

function envelope(from: string, body: string, act = 'status_update' as const) {
  return makeEnvelope({
    id: `sv-${Math.random().toString(36).slice(2, 10)}`,
    team: 'dawn',
    from,
    to: { kind: 'team' },
    act,
    body,
  });
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  agentKey = team.json.agent_key;
  nickCred = team.json.human_credential;
  await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
  const svc = await post(
    '/teams/dawn/members',
    { name: 'autorefresh', kind: 'service', role: 'platform' },
    nickCred,
  );
  expect(svc.status).toBe(201);
  serviceToken = svc.json.token;
  expect(serviceToken.startsWith('mskd_')).toBe(true);
  // A service holds no human credential — the ledger seat authenticates with its token alone.
  expect(svc.json.human_credential).toBeUndefined();
});

afterEach(async () => {
  await server.close();
});

describe('service-token auth (ADR 232 §5)', () => {
  it('the minted mskd_ token sends an attributed in-band status_update and derives ambient presence', async () => {
    const sent = await post(
      '/teams/dawn/messages',
      { envelope: envelope('autorefresh', 'bounced the daemon on 322cd28, 5 live sessions notified') },
      serviceToken,
    );
    expect(sent.status).toBe(201);

    const all = await get('/teams/dawn/messages', nickCred);
    const mine = all.json.messages.filter((m: { from: string }) => m.from === 'autorefresh');
    expect(mine).toHaveLength(1);
    expect(mine[0].act).toBe('status_update');

    // Ambient presence (ADR 232 §3): the authenticated send is a real action, so the roster reads
    // the seat fresh — silence-is-signal needs no new machinery, just this to be true.
    const roster = await get('/teams/dawn', nickCred);
    const row = roster.json.members.find((m: { name: string }) => m.name === 'autorefresh');
    expect(row.kind).toBe('service');
  });

  it('kind-bound: an AGENT seat’s stored mskd_ token is not a usable credential', async () => {
    // Ada’s provisioning also returned a token (the legacy shape) — reviving the mskd_ prefix for
    // services must not quietly re-open the v0.2 per-seat auth path for peers (ADR 069 decision 2).
    const ada = await post('/teams/dawn/members', { name: 'Bo', kind: 'agent' }, nickCred);
    const agentMskd = ada.json.token as string;
    expect(agentMskd.startsWith('mskd_')).toBe(true);
    const r = await post('/teams/dawn/messages', { envelope: envelope('Bo', 'hi') }, agentMskd);
    expect(r.status).toBe(401);
  });

  it('self-identifying: the token cannot act as another seat', async () => {
    const r = await post(
      '/teams/dawn/messages',
      { envelope: envelope('Ada', 'impersonation') },
      serviceToken,
    );
    expect([401, 403]).toContain(r.status);
  });

  it('the shared agent key can never act as a service seat, and says so by kind', async () => {
    const r = await post(
      '/teams/dawn/messages',
      { envelope: envelope('autorefresh', 'spoofed') },
      agentKey,
      'autorefresh',
    );
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).toMatch(/service seat/);
  });
});

describe('ledger-seat exclusions (ADR 232 §1)', () => {
  it('a service seat cannot open a lane', async () => {
    const r = await post(
      '/teams/dawn/lanes',
      { title: 'sneaky work', claim: true },
      serviceToken,
      'autorefresh',
    );
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).toMatch(/ledger seats never open/);
  });

  it('a service seat cannot claim a lane, and a lane cannot be handed to one', async () => {
    const opened = await post('/teams/dawn/lanes', { title: 'real work' }, nickCred);
    expect(opened.status).toBe(201);
    const laneId = opened.json.lane.id;

    const claim = await patch(
      `/teams/dawn/lanes/${laneId}`,
      { owner_seat: 'autorefresh' },
      serviceToken,
      'autorefresh',
    );
    expect(claim.status).toBe(403);

    const handoff = await patch(
      `/teams/dawn/lanes/${laneId}`,
      { owner_seat: 'autorefresh' },
      nickCred,
    );
    expect(handoff.status).toBe(403);
    expect(JSON.stringify(handoff.json)).toMatch(/cannot be handed to a ledger seat/);
  });

  it('residency refuses to enroll a service seat — you cannot wake a LaunchAgent', async () => {
    const r = await post(
      '/teams/dawn/residency/enroll',
      { seat: 'autorefresh', harness: 'claude-code', host: 'laptop.local' },
      nickCred,
    );
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).toMatch(/residency enrolls agent seats/);
  });

  // The ADR 172 admin clamp on service seats is covered where the clamp lives:
  // projection/reconcile.test.ts ("clamps is_admin on a SERVICE seat…").

  it('infra-gate audience widens to non-human seats (ADR 232): a roleless service is warned, a platform one is silent', async () => {
    // Pre-232 the gate went silent for every non-agent caller — a service was structurally
    // invisible to the one check aimed at unattended infra touchers.
    const platform = await get('/teams/dawn/infra-gate?verb=restart', serviceToken, 'autorefresh');
    expect(platform.status).toBe(200);
    expect(platform.json.warn).toBeNull(); // holds `platform` — silent by role, not by kind

    const sw = await post('/teams/dawn/members', { name: 'sweeper', kind: 'service' }, nickCred);
    expect(sw.status).toBe(201);
    const warned = await get('/teams/dawn/infra-gate?verb=restart', sw.json.token, 'sweeper');
    expect(warned.status).toBe(200);
    expect(warned.json.warn).not.toBeNull();
  });
});
