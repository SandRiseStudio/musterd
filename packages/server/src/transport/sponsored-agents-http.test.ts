import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { SPONSORED_AGENT_CAP, redeemAgentConnectNonce } from '../store/sponsoredAgents.js';
import { requireTeam } from '../store/teams.js';

/**
 * ADR 449 §3–4 through HTTP: `POST /teams/:slug/members/agents` (a human member mints an agent they
 * sponsor, getting a connect link and no secret) and `POST …/members/agents/:name/connect` (the
 * sponsor re-issues that link). Removing the sponsor takes the agent with it (§2's cascade, already
 * on the remove route) — asserted here end to end because this is the first route that makes one.
 */
let server: RunningServer;
let base: string;
let nick: string;

async function post(path: string, body: unknown, bearer?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

async function addHuman(name: string): Promise<string> {
  const r = await post('/teams/sponsor-t/members', { name, kind: 'human' }, nick);
  return r.json.human_credential as string;
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const r = await post('/teams', { slug: 'sponsor-t', creator: { name: 'nick', kind: 'human' } });
  nick = r.json.human_credential;
});

afterEach(async () => {
  await server.close();
});

describe('POST /teams/:slug/members/agents', () => {
  it('a human member mints a sponsored agent and gets a fragment connect link — no secret', async () => {
    const dana = await addHuman('dana');
    const r = await post(
      '/teams/sponsor-t/members/agents',
      { name: 'dana-scout', role: 'research' },
      dana,
    );
    expect(r.status).toBe(201);
    expect(r.json.member.name).toBe('dana-scout');
    expect(r.json.member.kind).toBe('agent');
    expect(r.json.connect_url).toMatch(
      new RegExp(`^${base}/join/sponsor-t/agent#[A-Za-z0-9_-]{43}$`),
    );
    expect(r.json.connect_expires_at).toBeGreaterThan(Date.now());
    expect(JSON.stringify(r.json)).not.toMatch(/ms(cr|ac|at|kd)_/);

    const nonce = (r.json.connect_url as string).split('#')[1]!;
    const team = requireTeam(server.db, 'sponsor-t');
    expect(redeemAgentConnectNonce(server.db, team.id, nonce)?.name).toBe('dana-scout');
  });

  it('writes the audit row naming sponsor and agent', async () => {
    const dana = await addHuman('dana');
    await post('/teams/sponsor-t/members/agents', { name: 'dana-scout' }, dana);
    const row = server.db
      .prepare("SELECT actor, target FROM audit WHERE action = 'member.sponsored_agent_created'")
      .get() as { actor: string; target: string };
    expect(row).toEqual({ actor: 'dana', target: 'dana-scout' });
  });

  it('refuses without a credential', async () => {
    const r = await post('/teams/sponsor-t/members/agents', { name: 'x' });
    expect(r.status).toBe(401);
  });

  it('refuses past the per-sponsor cap', async () => {
    const dana = await addHuman('dana');
    for (let i = 0; i < SPONSORED_AGENT_CAP; i++)
      expect((await post('/teams/sponsor-t/members/agents', { name: `a${i}` }, dana)).status).toBe(
        201,
      );
    const r = await post('/teams/sponsor-t/members/agents', { name: 'extra' }, dana);
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/cap of/);
  });

  it('removing the sponsor disables the agent (§2 cascade)', async () => {
    const dana = await addHuman('dana');
    await post('/teams/sponsor-t/members/agents', { name: 'dana-scout' }, dana);
    expect((await post('/teams/sponsor-t/members/dana/remove', {}, nick)).status).toBe(200);
    const row = server.db
      .prepare("SELECT account_status FROM members WHERE name = 'dana-scout'")
      .get() as { account_status: string };
    expect(row.account_status).toBe('disabled');
  });
});

describe('POST /teams/:slug/members/agents/:name/connect', () => {
  it('the sponsor re-issues the link, and the old one dies', async () => {
    const dana = await addHuman('dana');
    const made = await post('/teams/sponsor-t/members/agents', { name: 'dana-scout' }, dana);
    const oldNonce = (made.json.connect_url as string).split('#')[1]!;
    const r = await post('/teams/sponsor-t/members/agents/dana-scout/connect', {}, dana);
    expect(r.status).toBe(200);
    const team = requireTeam(server.db, 'sponsor-t');
    expect(redeemAgentConnectNonce(server.db, team.id, oldNonce)).toBeNull();
    const newNonce = (r.json.connect_url as string).split('#')[1]!;
    expect(redeemAgentConnectNonce(server.db, team.id, newNonce)?.name).toBe('dana-scout');
  });

  it("refuses anyone but the sponsor — another member cannot mint a link to dana's agent", async () => {
    const dana = await addHuman('dana');
    const eve = await addHuman('eve');
    await post('/teams/sponsor-t/members/agents', { name: 'dana-scout' }, dana);
    const r = await post('/teams/sponsor-t/members/agents/dana-scout/connect', {}, eve);
    expect(r.status).toBe(404);
  });
});
