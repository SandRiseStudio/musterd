import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { routeEnvelope } from '../protocol/route.js';
import { appendReplicatedEvent } from '../store/audit.js';
import { incidentReporters, openIncidents } from '../store/incidents.js';
import { addMember, getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { askSeedClarification, claimSeed, createSeedFromRelay, getSeed } from '../store/seeds.js';
import { getTeamBySlug } from '../store/teams.js';
import { deriveToolCallMetrics, recordToolCalls } from '../store/toolCalls.js';
import { Hub } from '../transport/hub.js';
import { foldBatch } from './fold.js';
import { readStaged } from './log.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

/**
 * The record kind (ADR 371, residence-2 census gap 3) between two real daemons.
 *
 * The census measured the gap: `tool_call_stats`, `seed_thread_entries` and `incident_reports` were
 * local writes with no stamp, so `musterd report` counted one machine, a brief written on one
 * machine was absent from the seed everywhere else, and three seats blocked on one gate across two
 * machines never reached a threshold anywhere. These are the ADR's falsifiers: a tool-call batch
 * crosses and is counted once under the origin's hour; a thread entry crosses by relay id and
 * member NAME and blocks until the relay seed is here; the incident pool is the hub's — a joiner's
 * report counts when its status_update folds on the hub, the lane opens exactly once, the pool
 * mirrors back so resolve fan-out answers on the joiner, and a joiner-minted pool row is refused at
 * ingest; and the raw primitives still ship nothing.
 *
 * Harness copied from continuity.test.ts so this file stands alone.
 */

let hub: RunningServer;
let joiner: RunningServer;
let hubBase: string;
let joinerBase: string;
let nickOnHub: string;
let nickOnJoiner: string;
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

async function enrollSecondNode(label: string): Promise<{ credential: string; nodeId: string }> {
  const { json: minted } = await post(hubBase, '/teams/bravo/nodes/invite', { label }, nickOnHub);
  const nodeId = `node-${label.replace(/\W+/g, '-')}`;
  const { status, json } = await post(hubBase, '/teams/bravo/nodes/join', {
    code: minted.invite,
    node_id: nodeId,
    label,
  });
  expect(status).toBe(200);
  return { credential: json.node_credential, nodeId: json.node_id };
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

const GATE = 'ci:gates/A11y contrast';
const blocked = (over: Record<string, unknown> = {}) => ({
  blocked_by: { gate: GATE, sig: 'lc 2.83', ref: 'pr#828', ...over },
});

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
  nickOnJoiner = (
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

describe('record.tool_calls (ADR 371 §1)', () => {
  it('a flush on the joiner is counted by the hub’s report, once, under the origin’s hour', async () => {
    const flushed = await post(
      joinerBase,
      '/teams/bravo/telemetry/tool-calls',
      {
        events: [
          {
            tool: 'team_send',
            outcome: 'ok',
            calls: 3,
            total_duration_ms: 30,
            max_duration_ms: 20,
          },
          {
            tool: 'team_send',
            outcome: 'invalid_input',
            calls: 1,
            total_duration_ms: 5,
            max_duration_ms: 5,
          },
        ],
      },
      nickOnJoiner,
    );
    expect(flushed.status).toBe(200);
    expect(deriveToolCallMetrics(hub.db, hubTeam().id).calls).toBe(0);

    await roundTrip();

    const onHub = deriveToolCallMetrics(hub.db, hubTeam().id);
    const teamSend = onHub.tools.find((t) => t.tool === 'team_send');
    expect(teamSend?.calls).toBe(4);
    expect(teamSend?.bounces).toBe(1);
    // The origin's bucket, not the fold's clock: both rows sit in the joiner's hour.
    const joinerBucket = joiner.db
      .prepare<[], { bucket_start: number }>('SELECT bucket_start FROM tool_call_stats LIMIT 1')
      .get()!.bucket_start;
    expect(
      hub.db
        .prepare<[], { bucket_start: number }>('SELECT DISTINCT bucket_start FROM tool_call_stats')
        .all()
        .map((r) => r.bucket_start),
    ).toEqual([joinerBucket]);

    // Re-delivering the whole staged log applies nothing: Rule 2 (the held pair) runs before the
    // additive UPSERT, which is what makes at-least-once delivery exactly-once for a counter.
    const replay = foldBatch(hub.db, hubTeam().id, readStaged(hub.db, hubTeam().id, 0, 100));
    expect(replay.applied).toBe(0);
    expect(deriveToolCallMetrics(hub.db, hubTeam().id).calls).toBe(4);
  });

  it('the raw primitive still ships nothing — the seam is the stamped writer', async () => {
    recordToolCalls(joiner.db, joinerTeam().id, 'nick', null, [
      { tool: 'team_send', outcome: 'ok', calls: 7, total_duration_ms: 70, max_duration_ms: 10 },
    ]);
    await roundTrip();
    expect(deriveToolCallMetrics(hub.db, hubTeam().id).calls).toBe(0);
    expect(
      count(hub.db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'record.tool_calls'"),
    ).toBe(0);
  });
});

describe('record.seed_thread (ADR 371 §3)', () => {
  it('a clarification asked on the joiner appears in the hub’s seed thread, same entry id, by NAME', async () => {
    const jt = joinerTeam();
    const ht = hubTeam();
    const seedJ = createSeedFromRelay(joiner.db, jt.id, RELAY);
    const seedH = createSeedFromRelay(hub.db, ht.id, RELAY);
    expect(seedJ.id).not.toBe(seedH.id); // daemon-private ids — the reason the event carries relay_id

    claimSeed(joiner.db, jt.id, seedJ.id, member(joiner.db, jt, 'ada'));
    askSeedClarification(joiner.db, jt.id, seedJ.id, member(joiner.db, jt, 'ada'), 'why this?');
    const entryOnJoiner = getSeed(joiner.db, jt.id, seedJ.id)!.thread[0]!;
    expect(getSeed(hub.db, ht.id, seedH.id)!.thread).toHaveLength(0);

    await roundTrip();

    const onHub = getSeed(hub.db, ht.id, seedH.id)!;
    expect(onHub.thread).toHaveLength(1);
    expect(onHub.thread[0]).toMatchObject({
      id: entryOnJoiner.id,
      kind: 'clarification',
      body: 'why this?',
      by: 'ada',
    });
    // Lifecycle state did NOT cross (§3): the hub's seed is still where the hub last moved it.
    expect(onHub.state).toBe('open');
    expect(getSeed(joiner.db, jt.id, seedJ.id)!.state).toBe('needs_clarification');
  });

  it('an entry for a seed the hub has not relay-ingested yet BLOCKS as seed_unborn, then applies after ingest', async () => {
    const jt = joinerTeam();
    const ht = hubTeam();
    const seedJ = createSeedFromRelay(joiner.db, jt.id, RELAY);
    claimSeed(joiner.db, jt.id, seedJ.id, member(joiner.db, jt, 'ada'));
    askSeedClarification(joiner.db, jt.id, seedJ.id, member(joiner.db, jt, 'ada'), 'why?');

    await roundTrip();
    expect(count(hub.db, 'SELECT COUNT(*) AS n FROM seed_thread_entries')).toBe(0);
    expect(
      count(hub.db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'record.seed_thread'"),
    ).toBe(0);

    // The relay delivers the seed to the hub (every daemon ingests the relay, index.ts); next tick
    // the entry lands under the hub's own seed id.
    const seedH = createSeedFromRelay(hub.db, ht.id, RELAY);
    await roundTrip();
    expect(getSeed(hub.db, ht.id, seedH.id)!.thread).toMatchObject([{ body: 'why?', by: 'ada' }]);
  });
});

describe('record.incident_report — the pool is the hub’s (ADR 371 §2)', () => {
  const report = (from: string, id: string, over: Record<string, unknown> = {}) =>
    makeEnvelope({
      id,
      team: 'bravo',
      from,
      to: { kind: 'team' },
      act: 'status_update',
      body: 'blocked on the gate',
      meta: blocked(over),
    });

  it('two seats on two machines open exactly ONE incident lane, on the hub; the pool mirrors back so reporters resolve on the joiner', async () => {
    const ht = hubTeam();
    const jt = joinerTeam();
    // Report 1 routes on the hub (ada is hub-resident by loopback). Below the threshold: recorded.
    routeEnvelope(
      hubCtx(),
      ht,
      member(hub.db, ht, 'ada'),
      report('ada', 'r-ada', { ref: 'pr#829' }),
    );
    expect(openIncidents(hub.db, ht.id, 'bravo')).toHaveLength(0);
    expect(count(hub.db, 'SELECT COUNT(*) AS n FROM incident_reports')).toBe(1);

    // Report 2 posts to the JOINER, through the route — and the joiner writes NOTHING: the pool is
    // the hub's, and the report crosses on the status_update it rides.
    const second = await post(
      joinerBase,
      '/teams/bravo/messages',
      { envelope: report('nick', 'r-nick') },
      nickOnJoiner,
    );
    expect(second.status).toBe(201);
    expect(count(joiner.db, 'SELECT COUNT(*) AS n FROM incident_reports')).toBe(0);
    expect(openIncidents(joiner.db, jt.id, 'bravo')).toHaveLength(0);

    await roundTrip();

    // The hub folded nick's status_update and pooled it: threshold met, one lane, on the hub.
    const onHub = openIncidents(hub.db, ht.id, 'bravo');
    expect(onHub).toHaveLength(1);
    expect(onHub[0]!.title).toBe(`incident: ${GATE}`);
    expect(incidentReporters(hub.db, ht.id, onHub[0]!.id).sort()).toEqual(['ada', 'nick']);

    await roundTrip(); // the lane's birth and the pool rows (with lane_id) cross back
    const onJoiner = openIncidents(joiner.db, jt.id, 'bravo');
    expect(onJoiner).toHaveLength(1);
    expect(onJoiner[0]!.id).toBe(onHub[0]!.id); // one lane, not one per machine
    expect(incidentReporters(joiner.db, jt.id, onJoiner[0]!.id).sort()).toEqual(['ada', 'nick']);
    expect(count(joiner.db, 'SELECT COUNT(*) AS n FROM incident_reports')).toBe(2);
    // Mirrored verbatim: the hub's ids and the hub's created_at.
    expect(
      joiner.db
        .prepare('SELECT id, seat, lane_id, created_at FROM incident_reports ORDER BY id')
        .all(),
    ).toEqual(
      hub.db
        .prepare('SELECT id, seat, lane_id, created_at FROM incident_reports ORDER BY id')
        .all(),
    );
  });

  it('a joiner folding the same status_update does not count it — the pool exists on one machine', async () => {
    // Both reports originate on the joiner and cross to the hub; nothing pools on the joiner until
    // the hub's mirror rows come back, and the joiner never opens a lane of its own.
    messageOnJoiner('ada', 'r-ada', 2000, 'status_update', blocked({ ref: 'pr#829' }));
    messageOnJoiner('nick', 'r-nick', 2001, 'status_update', blocked());
    await roundTrip();
    expect(openIncidents(hub.db, hubTeam().id, 'bravo')).toHaveLength(1);
    await roundTrip();
    const lanes = openIncidents(joiner.db, joinerTeam().id, 'bravo');
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.id).toBe(openIncidents(hub.db, hubTeam().id, 'bravo')[0]!.id);
    expect(
      count(
        joiner.db,
        "SELECT COUNT(*) AS n FROM audit WHERE action = 'record.incident_report' AND origin_node = (SELECT node_id FROM local_node LIMIT 1)",
      ),
    ).toBe(0);
  });

  it('a joiner-minted record.incident_report is refused at ingest, as a policy event is', async () => {
    const evil = await enrollSecondNode('a CI box');
    const res = await post(
      hubBase,
      '/teams/bravo/sync/push',
      {
        events: [
          {
            kind: 'record',
            team: 'bravo',
            origin_node: evil.nodeId,
            origin_seq: 1,
            event: {
              id: 'forged-report-1',
              ts: Date.now(),
              actor: 'nick',
              action: 'record.incident_report',
              target: GATE,
              result: 'allow',
              detail: { report_id: 'forged', gate: GATE, seat: 'nick', created_at: Date.now() },
            },
          },
        ],
      },
      evil.credential,
    );
    expect(res.status).toBe(403);
    expect(res.json.error.message).toMatch(/incident report is the hub's to record/);
    expect(count(hub.db, 'SELECT COUNT(*) AS n FROM incident_reports')).toBe(0);
    expect(count(hub.db, "SELECT COUNT(*) AS n FROM sync_log WHERE id = 'forged-report-1'")).toBe(
      0,
    );
  });

  it('the same forgery stamped through the joiner’s own writer is refused too — the batch, not just the row', async () => {
    const jt = joinerTeam();
    appendReplicatedEvent(joiner.db, jt.id, {
      actor: 'nick',
      action: 'record.incident_report',
      target: GATE,
      result: 'allow',
      detail: { report_id: 'forged-2', gate: GATE, seat: 'nick', created_at: Date.now() },
    });
    // The pusher reports every 403 under one label; the hub's own wording is asserted above.
    await expect(pushTeam(joinerCtx, jt)).rejects.toThrow(/403/);
    expect(count(hub.db, 'SELECT COUNT(*) AS n FROM incident_reports')).toBe(0);
  });
});
