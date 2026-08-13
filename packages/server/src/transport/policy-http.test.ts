import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * The ADR 185 round-trip. Storing sparsely in `setPolicy` is not enough on its own: `GET /policy`
 * used to return only the defaults-applied policy, the CLI merged its flags into *that*, and the very
 * next write re-froze every default into the row. These assertions pin the wire shape that makes the
 * read-merge-write loop keep a row sparse across repeated writes.
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

const storedRow = (): unknown => {
  const team = getTeamBySlug(server.db, 'dawn')!;
  const row = server.db
    .prepare<[string], { policy: string | null }>('SELECT policy FROM teams WHERE id = ?')
    .get(team.id);
  return row?.policy ? JSON.parse(row.policy) : null;
};

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  nickCred = team.json.human_credential;
});

afterEach(async () => {
  await server.close();
});

describe('GET /policy returns both halves (ADR 185)', () => {
  it('an untouched team: everything effective, nothing stored', async () => {
    const r = await get('/teams/dawn/policy', bearer(nickCred));
    expect(r.status).toBe(200);
    expect(r.json.stored).toEqual({});
    expect(r.json.policy.residency.hourly_cap).toBe(2); // the shipped default, unfrozen
  });

  it('after one write, `stored` names exactly the chosen knob', async () => {
    await post('/teams/dawn/policy', { standing_reseat_known_agents: true }, bearer(nickCred));
    const r = await get('/teams/dawn/policy', bearer(nickCred));
    expect(r.json.stored).toEqual({ standing_reseat_known_agents: true });
    expect(r.json.policy.standing_reseat_known_agents).toBe(true);
    expect(r.json.policy.residency.transcript_max_bytes).toBe(262_144);
  });
});

describe('the read-merge-write loop keeps the row sparse', () => {
  it('three successive one-knob writes leave three keys, not the whole schema', async () => {
    // Exactly what the CLI does — and the loop that used to re-materialize every default each time.
    for (const knob of [
      { standing_reseat_known_agents: true },
      { ask_fallback_to_nonadmin: true },
      { residency: { hourly_cap: 5 } },
    ]) {
      const { json } = await get('/teams/dawn/policy', bearer(nickCred));
      await post('/teams/dawn/policy', { ...json.stored, ...knob }, bearer(nickCred));
    }
    expect(storedRow()).toEqual({
      standing_reseat_known_agents: true,
      ask_fallback_to_nonadmin: true,
      residency: { hourly_cap: 5 },
    });
  });

  it('omitting a key unsets it — the webhook `off` path restores the real default', async () => {
    await post(
      '/teams/dawn/policy',
      { ask_slack_webhook: 'https://hooks.slack.test/x', residency: { hourly_cap: 5 } },
      bearer(nickCred),
    );
    const { json } = await get('/teams/dawn/policy', bearer(nickCred));
    const { ask_slack_webhook: _dropped, ...rest } = json.stored;
    await post('/teams/dawn/policy', rest, bearer(nickCred));

    expect(storedRow()).toEqual({ residency: { hourly_cap: 5 } });
    const after = await get('/teams/dawn/policy', bearer(nickCred));
    expect(after.json.policy.ask_slack_webhook).toBeUndefined();
  });
});

describe('the policy.change audit records the request, not the parsed result', () => {
  it('one chosen knob ⇒ a one-key audit detail (intent is recoverable going forward)', async () => {
    await post('/teams/dawn/policy', { residency: { cooldown_ms: 60_000 } }, bearer(nickCred));
    const team = getTeamBySlug(server.db, 'dawn')!;
    const rows = listAudit(server.db, team.id).filter((r) => r.action === 'policy.change');
    expect(rows).toHaveLength(1);
    // The old row wrote the post-parse policy here, which is why nothing could later say whether a
    // stored value had been chosen or baked in.
    expect(JSON.parse(rows[0]!.detail as string)).toEqual({ residency: { cooldown_ms: 60_000 } });
  });
});

describe('GET /guardian-tiers — the scoped member read (ADR 263 follow-up)', () => {
  it('a service seat reads the tier map without admin visibility; the webhook never rides along', async () => {
    await post(
      '/teams/dawn/policy',
      { guardian_tiers: { daemon_down: 'auto' }, ask_slack_webhook: 'https://hooks.example.com/s' },
      bearer(nickCred),
    );
    const minted = await post(
      '/teams/dawn/members',
      { name: 'guardian', kind: 'service', role: 'platform' },
      bearer(nickCred),
    );
    const token = minted.json.token as string;

    // The full policy stays admin-only for this seat…
    expect((await get('/teams/dawn/policy', bearer(token))).status).toBe(403);
    // …but the scoped read answers, tiers only (the /enforcement precedent).
    const tiers = await get('/teams/dawn/guardian-tiers', bearer(token));
    expect(tiers.status).toBe(200);
    expect(tiers.json).toEqual({ guardian_tiers: { daemon_down: 'auto' } });
  });

  it('an untouched team answers the empty map, not an error', async () => {
    const tiers = await get('/teams/dawn/guardian-tiers', bearer(nickCred));
    expect(tiers.status).toBe(200);
    expect(tiers.json).toEqual({ guardian_tiers: {} });
  });
});
