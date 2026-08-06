import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { upsertRole } from '../store/roles.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * `GET /members?role=` (ADR 227 close-out): the discovery filter moves server-side so the daemon
 * can SEE role queries — each authenticated filtered read writes a `roster.role_query` audit row
 * ({role, holders}), the signal the inc-1 eval and the role-addressed-send reopening trigger both
 * join on. The contract asserted here: filter correctness, the audit row's exact shape, a miss
 * still audited (a miss is signal), the anonymous read filtering WITHOUT auditing (no seat to join
 * a send to), and the no-param read byte-compatible with the pre-close-out route (no filter, no
 * row). The roles library additionally carries charter + capabilities (additive).
 */
let server: RunningServer;
let base: string;
let nickCred: string;

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

const auditRows = () => {
  const team = getTeamBySlug(server.db, 'dawn')!;
  return server.db
    .prepare<[string], { actor: string | null; detail: string | null }>(
      `SELECT actor, detail FROM audit WHERE team_id = ? AND action = 'roster.role_query' ORDER BY ts`,
    )
    .all(team.id);
};

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  nickCred = team.json.human_credential;
  // One holder, one roleless generalist — the legacy single-`role` field is enough (parseRoles
  // derives `roles: ['platform']` from it, the ADR 227 back-compat read).
  await post('/teams/dawn/members', { name: 'izzo', kind: 'agent', role: 'platform' }, bearer(nickCred));
  await post('/teams/dawn/members', { name: 'kimi', kind: 'agent' }, bearer(nickCred));
  // The role library entry (normally projected from roles/<name>.toml by reconcile).
  const teamRow = getTeamBySlug(server.db, 'dawn')!;
  upsertRole(server.db, teamRow.id, 'platform', {}, 'You touch infra.', 'infra toucher');
});

afterEach(async () => {
  await server.close();
});

describe('GET /members?role= (ADR 227 close-out) — server-side filter + audit', () => {
  it('filters members to holders of the role and returns the full role library', async () => {
    const res = await get('/teams/dawn/members?role=platform', bearer(nickCred));
    expect(res.status).toBe(200);
    expect(res.json.members.map((m: { name: string }) => m.name)).toEqual(['izzo']);
    const platform = res.json.roles.find((r: { name: string }) => r.name === 'platform');
    expect(platform.summary).toBe('infra toucher');
    // Library entries now carry charter + capabilities (additive).
    expect(platform.charter).toBe('You touch infra.');
    expect(platform.capabilities).toEqual({});
  });

  it('writes a roster.role_query audit row for an authenticated filtered read', async () => {
    await get('/teams/dawn/members?role=platform', bearer(nickCred));
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('nick');
    expect(JSON.parse(rows[0].detail!)).toEqual({ role: 'platform', holders: ['izzo'] });
  });

  it('unknown role: empty members, full library, audit row still written (a miss is signal)', async () => {
    const res = await get('/teams/dawn/members?role=nonesuch', bearer(nickCred));
    expect(res.status).toBe(200);
    expect(res.json.members).toEqual([]);
    expect(res.json.roles.length).toBeGreaterThan(0);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail!)).toEqual({ role: 'nonesuch', holders: [] });
  });

  it('unauthenticated filtered read: filters but writes NO audit row (no seat to join to)', async () => {
    const res = await get('/teams/dawn/members?role=platform');
    expect(res.status).toBe(200);
    expect(res.json.members.map((m: { name: string }) => m.name)).toEqual(['izzo']);
    expect(auditRows()).toHaveLength(0);
  });

  it('no ?role= param: identical to today — no filter, no audit row', async () => {
    const res = await get('/teams/dawn/members', bearer(nickCred));
    expect(res.status).toBe(200);
    expect(res.json.members.length).toBe(3); // nick + izzo + kimi
    expect(auditRows()).toHaveLength(0);
  });
});
