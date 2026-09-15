import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { appendReplicatedEvent } from '../store/audit.js';
import { addMember, getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { claimSeed, createSeedFromRelay, getSeed } from '../store/seeds.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { foldBatch } from './fold.js';
import { readStaged } from './log.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

/**
 * The seed kind (ADR 399) between two real daemons.
 *
 * ADR 371 §3 decided a seed reaches a second machine by that machine polling the relay itself, and
 * `seed_unborn` covered the window. Measured 2026-09-14/15 the premise did not hold: the ingest
 * loop is gated on `policy.seeds_relay_url` + `seeds_relay_token`, so a joiner without the relay's
 * bearer token never ingests, and its `seeds` table stays empty forever while the hub's fills. The
 * team was already shipping the COMMENTS on seeds (`record.seed_thread`) across machines while the
 * seeds themselves stayed put.
 *
 * So the capture crosses as its own kind, hub-minted: the joiner holds the team's ideation without
 * holding the relay credential — which is the constraint ADR 390 and 344 set. These are the ADR's
 * falsifiers: a capture ingested at the hub appears on the joiner under the same `relay_id`; a
 * joiner-minted `seed` is refused at ingest as a policy event is; lifecycle state does not ride
 * along; and re-delivery does not duplicate.
 *
 * Harness copied from record.test.ts so this file stands alone.
 */

let hub: RunningServer;
let joiner: RunningServer;
let hubBase: string;
let joinerBase: string;
let nickOnHub: string;
let _nickOnJoiner: string;
let dir: string;
let joinerCtx: Ctx;

async function call(
  method: 'POST' | 'PUT' | 'DELETE' | 'GET',
  base: string,
  path: string,
  body?: unknown,
  auth?: string,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
}
const post = (base: string, path: string, body?: unknown, auth?: string) =>
  call('POST', base, path, body, auth);

const hubCtx = (): Ctx => ({
  db: hub.db,
  hub: new Hub(),
  config: resolveConfig(),
  rosterRoots: [],
});
const hubTeam = () => getTeamBySlug(hub.db, 'bravo')!;
const joinerTeam = () => getTeamBySlug(joiner.db, 'bravo')!;
const member = (db: RunningServer['db'], team: { id: string }, name: string) =>
  getMemberByName(db, team.id, name)!;

async function roundTrip() {
  await pushTeam(joinerCtx, joinerTeam());
  await pullTeam(hubCtx(), hubTeam());
  await pushTeam(hubCtx(), hubTeam());
  await pullTeam(joinerCtx, joinerTeam());
}

async function enrollJoiner() {
  const { json: minted } = await post(
    hubBase,
    '/teams/bravo/nodes/invite',
    { label: 'joiner laptop' },
    nickOnHub,
  );
  const res = await post(joinerBase, '/node/enroll', {
    hub_url: hubBase,
    code: minted.invite,
    team: 'bravo',
  });
  expect(res.status).toBe(200);
}

/** A message on the joiner FROM a seat, inserted directly — no route-time hooks run. */
function messageOnJoiner(
  from: string,
  id: string,
  ts: number,
  act: 'message' | 'status_update' = 'message',
  meta: Record<string, unknown> | null = null,
) {
  const jt = joinerTeam();
  insertMessage(
    joiner.db,
    jt.id,
    member(joiner.db, jt, from).id,
    null,
    makeEnvelope({
      id,
      team: 'bravo',
      from,
      to: { kind: 'team' },
      act,
      body: id,
      ts,
      ...(meta ? { meta } : {}),
    }),
  );
}

const RELAY = {
  id: 'relay-1',
  source: 'slack',
  body: 'A raw idea',
  ts: 1,
  meta: { user: 'U123' },
} as const;

const count = (db: RunningServer['db'], sql: string): number =>
  (db.prepare<[], { n: number }>(sql).get() as { n: number }).n;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-record-sync-'));
  process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
  hub = createServer({ db: openDb(':memory:'), port: 0 });
  hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
  joiner = createServer({ db: openDb(':memory:'), port: 0 });
  joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
  joinerCtx = { db: joiner.db, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };
  nickOnHub = (
    await post(hubBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
  ).json.human_credential;
  _nickOnJoiner = (
    await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
  ).json.human_credential;
  // The same roster on both machines (git-replicated in life, ADR 058): an agent seat and a human
  // with a Slack id, so the seed relay accepts a submitter and an agent can explore.
  addMember(hub.db, hubTeam(), { name: 'ada', kind: 'agent' });
  addMember(hub.db, hubTeam(), { name: 'sam', kind: 'human', slackUserId: 'U123' });
  addMember(joiner.db, joinerTeam(), { name: 'ada', kind: 'agent' });
  addMember(joiner.db, joinerTeam(), { name: 'sam', kind: 'human', slackUserId: 'U123' });
  // The joiner's node row is minted on its first logged act, and enrollment needs one. This also
  // makes nick resident on the joiner (the first pushed act binds), so nick acts from there below.
  messageOnJoiner('nick', 'j-0', 1000);
  await enrollJoiner();
});

afterEach(async () => {
  await hub.close();
  await joiner.close();
  delete process.env['MUSTERD_NODE_STATE'];
  rmSync(dir, { recursive: true, force: true });
});

const seedRow = (db: RunningServer['db'], teamId: string, relayId: string) =>
  db
    .prepare<
      [string, string],
      { id: string; body: string; source: string; state: string; submitted_by: string }
    >('SELECT id, body, source, state, submitted_by FROM seeds WHERE team_id = ? AND relay_id = ?')
    .get(teamId, relayId);

describe('the seed kind (ADR 399)', () => {
  it('a capture ingested at the hub reaches the joiner under the same relay_id', async () => {
    const ht = hubTeam();
    const jt = joinerTeam();
    expect(count(joiner.db, 'SELECT COUNT(*) AS n FROM seeds')).toBe(0);

    const onHub = createSeedFromRelay(hub.db, ht.id, RELAY);
    await roundTrip();

    const onJoiner = seedRow(joiner.db, jt.id, RELAY.id)!;
    expect(onJoiner).toBeTruthy();
    expect(onJoiner.body).toBe('A raw idea');
    expect(onJoiner.source).toBe('slack');
    // Daemon-private ids — which is exactly why the event is keyed by relay_id.
    expect(onJoiner.id).not.toBe(onHub.id);
    // The submitter resolved to the joiner's OWN member row for the same human.
    expect(onJoiner.submitted_by).toBe(member(joiner.db, jt, 'sam').id);
  });

  it('re-delivering the same batch does not duplicate the seed', async () => {
    const ht = hubTeam();
    const jt = joinerTeam();
    createSeedFromRelay(hub.db, ht.id, RELAY);
    await roundTrip();
    expect(count(joiner.db, 'SELECT COUNT(*) AS n FROM seeds')).toBe(1);

    const replay = foldBatch(joiner.db, jt.id, readStaged(joiner.db, jt.id, 0, 200));
    expect(replay.applied).toBe(0);
    expect(count(joiner.db, 'SELECT COUNT(*) AS n FROM seeds')).toBe(1);
  });

  it('lifecycle does NOT cross with the capture — the claim stays where it was made', async () => {
    const ht = hubTeam();
    const jt = joinerTeam();
    const onHub = createSeedFromRelay(hub.db, ht.id, RELAY);
    await roundTrip();

    // Claim it on the HUB. The explorer claim is "exactly one holder", a residence-1 question this
    // ADR deliberately leaves to the federation increment (ADR 371 §3 stands).
    claimSeed(hub.db, ht.id, onHub.id, member(hub.db, ht, 'ada'));
    await roundTrip();

    expect(getSeed(hub.db, ht.id, onHub.id)!.state).toBe('exploring');
    expect(seedRow(joiner.db, jt.id, RELAY.id)!.state).toBe('open');
  });

  it('a joiner-minted seed event is refused at ingest, as a policy event is', async () => {
    const jt = joinerTeam();
    // Stamped through the joiner's OWN writer, so the batch is well-formed and the refusal is the
    // origin rule rather than a validation accident.
    appendReplicatedEvent(joiner.db, jt.id, {
      actor: 'sam',
      action: 'seed.captured',
      target: 'relay-forged',
      result: 'allow',
      detail: {
        relay_id: 'relay-forged',
        source: 'slack',
        body: 'not the hub to mint',
        captured_at: 1,
        slack_user_id: 'U123',
        by: 'sam',
        linked_lane_id: null,
        promotion_kind: null,
      },
    });

    await expect(pushTeam(joinerCtx, joinerTeam())).rejects.toThrow();
    expect(count(hub.db, "SELECT COUNT(*) AS n FROM seeds WHERE relay_id = 'relay-forged'")).toBe(
      0,
    );
  });
});
