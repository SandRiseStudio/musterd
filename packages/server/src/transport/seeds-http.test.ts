import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listLanes } from '../store/lanes.js';
import { createSeedFromRelay } from '../store/seeds.js';
import { getTeamBySlug } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

type Auth = string | AgentHttpAuth;

let server: RunningServer;
let base: string;
let agentKey: string;
let nickCredential: string;
let seedId: string;
let adaAuth: AgentHttpAuth;
let linAuth: AgentHttpAuth;

const brief = {
  problem: 'A problem',
  context: 'Relevant Team and code context',
  external_evidence: ['External evidence'],
  approaches: [{ approach: 'Build it', tradeoffs: 'Capability versus surface area' }],
  constraints: ['No new dependency'],
  risks: ['Low adoption'],
  unknowns: ['Exact demand'],
  recommendation: 'Run the smallest useful experiment',
  proposed_lane: { title: 'Test the idea', detail: 'Ship one bounded experiment' },
};

function headers(auth?: Auth): Record<string, string> {
  if (!auth) return {};
  if (typeof auth === 'string') return { authorization: `Bearer ${auth}` };
  return {
    authorization: `Bearer ${auth.key}`,
    'x-musterd-seat': auth.seat,
    'x-musterd-session-lease': auth.sessionLease,
  };
}

async function request(method: string, path: string, body: unknown, auth?: Auth) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers(auth) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;

  const created = await request('POST', '/teams', {
    slug: 'bravo',
    creator: { name: 'nick', kind: 'human' },
  });
  agentKey = created.json.agent_key;
  nickCredential = created.json.human_credential;
  await request('POST', '/teams/bravo/members', { name: 'Ada', kind: 'agent' }, nickCredential);
  await request('POST', '/teams/bravo/members', { name: 'Lin', kind: 'agent' }, nickCredential);
  adaAuth = await claimAgentHttp(base, 'bravo', agentKey, nickCredential, 'Ada');
  linAuth = await claimAgentHttp(base, 'bravo', agentKey, nickCredential, 'Lin');

  const team = getTeamBySlug(server.db, 'bravo')!;
  server.db
    .prepare("UPDATE members SET slack_user_id = 'U123' WHERE team_id = ? AND name = 'nick'")
    .run(team.id);
  seedId = createSeedFromRelay(server.db, team.id, {
    id: 'relay-1',
    source: 'slack',
    body: 'Which Surface should own this?',
    ts: 1_785_979_000_000,
    meta: { user: 'U123' },
  }).id;
});

afterEach(async () => {
  await server.close();
});

describe('Seed lifecycle HTTP authorization', () => {
  it('allows the explorer to ask and only the submitting Member to answer', async () => {
    const ada = adaAuth;
    const lin = linAuth;

    const claimed = await request('POST', `/teams/bravo/seeds/${seedId}/claim`, {}, ada);
    expect(claimed.status).toBe(200);
    expect(claimed.json.seed).toMatchObject({ state: 'exploring', explorer: 'Ada' });

    const asked = await request(
      'POST',
      `/teams/bravo/seeds/${seedId}/clarification`,
      { body: 'Which Surface?' },
      ada,
    );
    expect(asked.status).toBe(200);
    expect(asked.json.seed).toMatchObject({ state: 'needs_clarification', explorer: null });

    const refused = await request(
      'POST',
      `/teams/bravo/seeds/${seedId}/answer`,
      { body: 'CLI' },
      lin,
    );
    expect(refused.status).toBe(403);

    const answered = await request(
      'POST',
      `/teams/bravo/seeds/${seedId}/answer`,
      { body: 'CLI' },
      nickCredential,
    );
    expect(answered.status).toBe(200);
    expect(answered.json.seed).toMatchObject({ state: 'clarified' });
    expect(answered.json.seed.thread).toMatchObject([
      { kind: 'clarification', body: 'Which Surface?', by: 'Ada' },
      { kind: 'answer', body: 'CLI', by: 'nick' },
    ]);
  });

  it('captures a document-recorded intention as a repo Seed, idempotent on ref, linked when a lane is named (ADR 373 inc 2)', async () => {
    const body = {
      ref: 'docs/decisions/354-wake-lease-file-channel.md#left-for-a-sibling-lane',
      body: 'Left for a sibling lane; this ADR fixes the attestation, not the judgement.',
    };
    const first = await request('POST', '/teams/bravo/seeds/repo', body, adaAuth);
    expect(first.status).toBe(201);
    expect(first.json.seed).toMatchObject({
      source: 'repo',
      slack_user_id: null,
      submitted_by: 'Ada',
      state: 'open',
      relay_id: 'repo:' + body.ref,
    });

    const again = await request('POST', '/teams/bravo/seeds/repo', { ...body, body: 'x' }, linAuth);
    expect(again.status).toBe(200);
    expect(again.json.seed.id).toBe(first.json.seed.id);
    expect(again.json.seed.body).toBe(body.body);

    const lane = await request(
      'POST',
      '/teams/bravo/lanes',
      { title: 'the sibling lane' },
      adaAuth,
    );
    expect(lane.status).toBe(201);
    const linked = await request(
      'POST',
      '/teams/bravo/seeds/repo',
      { ...body, lane_id: lane.json.lane.id },
      adaAuth,
    );
    expect(linked.status).toBe(200);
    expect(linked.json.seed).toMatchObject({
      state: 'promoted',
      linked_lane_id: lane.json.lane.id,
    });

    // The Slack relay boundary is unchanged (ADR 311): the stored source widened, the ingest did not.
    const badRef = await request(
      'POST',
      '/teams/bravo/seeds/repo',
      { ref: ' ', body: 'x' },
      adaAuth,
    );
    expect(badRef.status).toBe(400);
    const badLane = await request(
      'POST',
      '/teams/bravo/seeds/repo',
      { ref: 'a.md#b', body: 'x', lane_id: '01M1MMHJP3PQY1QWNJCHV3XEMA' },
      adaAuth,
    );
    expect(badLane.status).toBe(400);
    const anonymous = await request('POST', '/teams/bravo/seeds/repo', body);
    expect(anonymous.status).toBe(401);

    const listed = await request('GET', '/teams/bravo/seeds', undefined, nickCredential);
    expect(listed.json.seeds.map((s: { source: string }) => s.source).sort()).toEqual([
      'repo',
      'slack',
    ]);
  });

  it('requires membership to list/read and returns the Team-visible Seed', async () => {
    const unauthenticated = await request('GET', '/teams/bravo/seeds', undefined);
    expect(unauthenticated.status).toBe(401);

    const listed = await request('GET', '/teams/bravo/seeds', undefined, nickCredential);
    expect(listed.status).toBe(200);
    expect(listed.json.seeds).toMatchObject([
      { id: seedId, state: 'open', submitted_by: 'nick', body: 'Which Surface should own this?' },
    ]);

    const read = await request('GET', `/teams/bravo/seeds/${seedId}`, undefined, adaAuth);
    expect(read.status).toBe(200);
    expect(read.json.seed.id).toBe(seedId);
  });

  it('keeps an inert seat from reading or mutating Seeds', async () => {
    const team = getTeamBySlug(server.db, 'bravo')!;
    server.db
      .prepare("UPDATE members SET account_status = 'disabled' WHERE team_id = ? AND name = 'Ada'")
      .run(team.id);
    const ada = adaAuth;

    expect((await request('GET', '/teams/bravo/seeds', undefined, ada)).status).toBe(403);
    expect((await request('GET', `/teams/bravo/seeds/${seedId}`, undefined, ada)).status).toBe(403);
    expect((await request('POST', `/teams/bravo/seeds/${seedId}/claim`, {}, ada)).status).toBe(403);
  });

  it('parses path ids and mutation bodies, then refuses a human exploration claim', async () => {
    const malformedId = await request('GET', '/teams/bravo/seeds/%', undefined, nickCredential);
    expect(malformedId.status).toBe(400);

    const malformed = await request(
      'POST',
      `/teams/bravo/seeds/${seedId}/clarification`,
      { body: '' },
      adaAuth,
    );
    expect(malformed.status).toBe(400);

    const humanClaim = await request(
      'POST',
      `/teams/bravo/seeds/${seedId}/claim`,
      {},
      nickCredential,
    );
    expect(humanClaim.status).toBe(403);
  });

  it('submits one exhaustive brief and promotes retry-safely with body-free audit evidence', async () => {
    const ada = adaAuth;
    await request('POST', `/teams/bravo/seeds/${seedId}/claim`, {}, ada);

    const first = await request(
      'POST',
      `/teams/bravo/seeds/${seedId}/brief`,
      { result: 'promote', brief },
      ada,
    );
    expect(first.status).toBe(200);
    expect(first.json.seed).toMatchObject({
      state: 'promoted',
      final_brief: brief,
      promotion: { kind: 'automatic', research_skipped: false },
    });

    const replay = await request(
      'POST',
      `/teams/bravo/seeds/${seedId}/brief`,
      { result: 'promote', brief },
      ada,
    );
    expect(replay.status).toBe(200);
    expect(replay.json.seed.linked_lane_id).toBe(first.json.seed.linked_lane_id);

    const team = getTeamBySlug(server.db, 'bravo')!;
    expect(listLanes(server.db, team.id, team.slug)).toHaveLength(1);
    const audit = server.db
      .prepare<
        [string],
        { action: string; detail: string | null }
      >("SELECT action, detail FROM audit WHERE team_id = ? AND action LIKE 'seed.%' ORDER BY ts, id")
      .all(team.id);
    expect(audit).toHaveLength(3);
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['seed.claimed', 'seed.brief_submitted', 'seed.promoted']),
    );
    expect(JSON.stringify(audit)).not.toContain(brief.problem);
    expect(JSON.stringify(audit)).not.toContain(brief.recommendation);

    const activity = server.db
      .prepare<
        [string],
        { body: string; meta: string }
      >("SELECT body, meta FROM messages WHERE team_id = ? AND json_extract(meta, '$.lane_open.seed_id') IS NOT NULL")
      .all(team.id);
    expect(activity).toHaveLength(1);
    expect(JSON.parse(activity[0]!.meta)).toMatchObject({
      lane_open: {
        lane: first.json.seed.linked_lane_id,
        seed_id: seedId,
        brainstorm_recommended: true,
      },
    });
    expect(activity[0]!.body).toContain('human brainstorm recommended');
  });

  it('rolls promotion back when its Lane-open activity cannot persist, then retries cleanly', async () => {
    const ada = adaAuth;
    await request('POST', `/teams/bravo/seeds/${seedId}/claim`, {}, ada);
    server.db.exec(`
      CREATE TRIGGER refuse_seed_lane_activity BEFORE INSERT ON messages
      WHEN json_extract(NEW.meta, '$.lane_open.seed_id') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'seed lane activity refused'); END;
    `);

    const failed = await request(
      'POST',
      `/teams/bravo/seeds/${seedId}/brief`,
      { result: 'promote', brief },
      ada,
    );
    expect(failed.status).toBe(500);
    const team = getTeamBySlug(server.db, 'bravo')!;
    expect(listLanes(server.db, team.id, team.slug)).toHaveLength(0);
    expect(
      (await request('GET', `/teams/bravo/seeds/${seedId}`, undefined, ada)).json.seed,
    ).toMatchObject({ state: 'exploring', linked_lane_id: null });

    server.db.exec('DROP TRIGGER refuse_seed_lane_activity');
    const retried = await request(
      'POST',
      `/teams/bravo/seeds/${seedId}/brief`,
      { result: 'promote', brief },
      ada,
    );
    expect(retried.status).toBe(200);
    expect(listLanes(server.db, team.id, team.slug)).toHaveLength(1);
  });

  it('lets the submitting Member manually promote an open Seed', async () => {
    const promoted = await request(
      'POST',
      `/teams/bravo/seeds/${seedId}/promote`,
      {},
      nickCredential,
    );
    expect(promoted.status).toBe(200);
    expect(promoted.json.seed).toMatchObject({
      state: 'promoted',
      promotion: { kind: 'manual', research_skipped: true },
    });
  });
});
