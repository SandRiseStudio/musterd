import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { getLane, updateLane } from '../store/lanes.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

/**
 * The lane-replication slice's falsifier (spec 2026-09-01 §"Falsifier to write first"), between two
 * real daemons: a lane opened and claimed on a JOINER becomes visible, with its owner and scope
 * intact, on the HUB — not merely announced as a `[lane]` sentence in the message log.
 *
 * The wire is the `lane.*` audit row (spec §"The wire, decided"): stamped from the same allocator
 * as messages, pushed beside them, folded into the peer's `audit` and projected into its `lanes`.
 *
 * Harness copied from pull.test.ts so this file stands alone.
 */

let hub: RunningServer;
let joiner: RunningServer;
let hubBase: string;
let joinerBase: string;
let nickOnHub: string;
let nickOnJoiner: string;
let dir: string;
let joinerCtx: Ctx;

async function post(base: string, path: string, body?: unknown, auth?: string) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
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

const hubCtx = (): Ctx => ({
  db: hub.db,
  hub: new Hub(),
  config: resolveConfig(),
  rosterRoots: [],
});
const hubTeam = () => getTeamBySlug(hub.db, 'bravo')!;
const joinerTeam = () => getTeamBySlug(joiner.db, 'bravo')!;

/** Joiner pushes to the hub; the hub folds its own staged log (the loopback of pull.ts). */
async function replicate() {
  await pushTeam(joinerCtx, joinerTeam());
  await pullTeam(hubCtx(), hubTeam());
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-lanes-'));
  process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');

  hub = createServer({ db: openDb(':memory:'), port: 0 });
  hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
  joiner = createServer({ db: openDb(':memory:'), port: 0 });
  joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
  joinerCtx = { db: joiner.db, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };

  const onHub = await post(hubBase, '/teams', {
    slug: 'bravo',
    creator: { name: 'nick', kind: 'human' },
  });
  nickOnHub = onHub.json.human_credential;
  const onJoiner = await post(joinerBase, '/teams', {
    slug: 'bravo',
    creator: { name: 'nick', kind: 'human' },
  });
  nickOnJoiner = onJoiner.json.human_credential;
  // The joiner's node row is minted on its first logged act; enrollment needs it to exist.
  const jt = joinerTeam();
  const nick = joiner.db
    .prepare<[string], { id: string }>('SELECT id FROM members WHERE team_id = ? LIMIT 1')
    .get(jt.id)!;
  insertMessage(
    joiner.db,
    jt.id,
    nick.id,
    null,
    makeEnvelope({
      id: 'j-0',
      team: 'bravo',
      from: 'nick',
      to: { kind: 'team' },
      act: 'message',
      body: 'hi',
      ts: 1000,
    }),
  );
  await enrollJoiner();
});

afterEach(async () => {
  await hub.close();
  await joiner.close();
  delete process.env['MUSTERD_NODE_STATE'];
  rmSync(dir, { recursive: true, force: true });
});

describe('lane replication (spec 2026-09-01) — the falsifier', () => {
  it('a lane opened and claimed on the joiner is visible on the hub with owner and scope intact', async () => {
    const opened = await post(
      joinerBase,
      '/teams/bravo/lanes',
      { title: 'born on the joiner', scope: ['packages/server/**'], claim: true, stakes: 'high' },
      nickOnJoiner,
    );
    expect(opened.status).toBe(201);
    const laneId: string = opened.json.lane.id;

    await replicate();

    const onHub = getLane(hub.db, hubTeam().id, laneId, 'bravo');
    expect(onHub).toMatchObject({
      id: laneId,
      title: 'born on the joiner',
      scope: ['packages/server/**'],
      owner_seat: 'nick',
      state: 'claimed',
      stakes: 'high',
      created_by: 'nick',
    });
  });

  it('later transitions on the joiner reach the hub in order: edit, move, release', async () => {
    const opened = await post(
      joinerBase,
      '/teams/bravo/lanes',
      { title: 'moving', claim: true },
      nickOnJoiner,
    );
    const laneId: string = opened.json.lane.id;
    const jt = joinerTeam();
    const audit = { actor: 'nick' };
    updateLane(
      joiner.db,
      jt.id,
      laneId,
      'bravo',
      { branch: 'nick/x', scope: ['a/**'] },
      2,
      undefined,
      audit,
    );
    updateLane(joiner.db, jt.id, laneId, 'bravo', { state: 'active' }, 3, undefined, audit);

    await replicate();
    expect(getLane(hub.db, hubTeam().id, laneId, 'bravo')).toMatchObject({
      branch: 'nick/x',
      scope: ['a/**'],
      state: 'active',
      owner_seat: 'nick',
    });

    updateLane(joiner.db, jt.id, laneId, 'bravo', { state: 'open' }, 4, undefined, audit);
    await replicate();
    expect(getLane(hub.db, hubTeam().id, laneId, 'bravo')).toMatchObject({
      state: 'open',
      owner_seat: null,
    });
  });

  it('replicating twice applies nothing twice — the fold is idempotent on the origin pair', async () => {
    const opened = await post(joinerBase, '/teams/bravo/lanes', { title: 'once' }, nickOnJoiner);
    const laneId: string = opened.json.lane.id;
    await replicate();
    await replicate();
    const rows = hub.db
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM audit WHERE action = 'lane.opened' AND target = ?")
      .get(laneId)!;
    expect(rows.n).toBe(1);
    expect(
      hub.db
        .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM lanes WHERE id = ?')
        .get(laneId),
    ).toEqual({ n: 1 });
  });

  it("the hub's own lanes never fold back into itself, and the joiner's allocator is untouched by the fold", async () => {
    // Hub-side birth: the hub stages its own history through loopback and must skip it on fold.
    const onHub = await post(joinerBase, '/teams/bravo/lanes', { title: 'j' }, nickOnJoiner);
    await replicate();
    const before = joiner.db
      .prepare<
        [],
        { next_seq: number }
      >('SELECT next_seq FROM nodes ORDER BY next_seq DESC LIMIT 1')
      .get()!.next_seq;
    // Pull the hub's log into the joiner: its own lane comes back and must be skipped, not re-applied.
    await pullTeam(joinerCtx, joinerTeam());
    const after = joiner.db
      .prepare<
        [],
        { next_seq: number }
      >('SELECT next_seq FROM nodes ORDER BY next_seq DESC LIMIT 1')
      .get()!.next_seq;
    expect(after).toBe(before);
    expect(
      joiner.db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM audit WHERE action = 'lane.opened' AND target = ?")
        .get(onHub.json.lane.id),
    ).toEqual({ n: 1 });
  });
});
