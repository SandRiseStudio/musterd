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

/**
 * The genesis watermark (2026-09-04, lane 01M1NFHEKT): a team that had lanes BEFORE `lane.opened`
 * began replicating hands every new machine an event it can never apply — a transition for a lane
 * whose birth is not in the log and never will be. Block-don't-skip then retries forever and the
 * joiner's fold stops dead, which is exactly what happened to the first real cloud seat: 9,393 of
 * 22,496 events folded, then `sync_fold_lane_unborn` on lane 01M1HJTF0M, permanently.
 *
 * The discriminator is the log's own beginning. Lane ids are ULIDs, so they sort by birth time: the
 * earliest lane the log holds a `lane.opened` for is the watermark, and anything older than it is
 * provably pre-history — the hub's log contains no birth for it by construction. Older than the
 * watermark skips (the audit row still lands, so the transition is not lost); anything else still
 * blocks, because a missing birth there is a hole or an open still in flight.
 */
describe('genesis watermark — pre-history lanes skip, holes still block', () => {
  /**
   * A lane that exists here with no replicated birth — the shape of every lane born before
   * `lane.opened` was carried on the wire. Inserted straight into `lanes`, deliberately: those
   * lanes were never stamped by the allocator, so there is no audit row to push and no gap in the
   * origin sequence. (Deleting a stamped birth instead would fabricate a gap, which the hub
   * rightly refuses — a different failure entirely.)
   */
  function bornBeforeReplication(laneId: string, title: string) {
    joiner.db
      .prepare(
        `INSERT INTO lanes (id, team_id, project, title, detail, kind, owner_seat, role,
                            surface_globs, depends_on, branch, goal_id, risk, stakes,
                            stakes_provenance, merged_json, state, created_by, created_at,
                            claimed_at, resolved_at, updated_at)
         VALUES (?, ?, 'default', ?, NULL, NULL, NULL, NULL, '[]', '[]', NULL, NULL, NULL, NULL,
                 NULL, NULL, 'open', 'nick', 1, NULL, NULL, 1)`,
      )
      .run(laneId, joinerTeam().id, title);
  }

  const edit = (laneId: string, branch: string) =>
    updateLane(joiner.db, joinerTeam().id, laneId, 'bravo', { branch }, 2, undefined, {
      actor: 'nick',
    });

  it('a transition for a lane older than the log advances the fold instead of wedging it', async () => {
    // The watermark: a normally-born lane, so the log holds one `lane.opened`. `ancient` sorts
    // before it, which is what makes it provably older than the log itself.
    const later = await post(
      joinerBase,
      '/teams/bravo/lanes',
      { title: 'watermark' },
      nickOnJoiner,
    );
    const laterId: string = later.json.lane.id;
    const ancientId = '01M0000000000000000000000A';
    expect(ancientId < laterId).toBe(true);
    bornBeforeReplication(ancientId, 'pre-history');
    edit(ancientId, 'nick/x');

    await replicate();

    // The fold got all the way through: the watermark lane landed, which it cannot do if the batch
    // stopped on the older lane's transition.
    expect(getLane(hub.db, hubTeam().id, laterId, 'bravo')).toMatchObject({ title: 'watermark' });
    // The pre-history lane is NOT invented here — a row with no title would be worse than no row.
    expect(getLane(hub.db, hubTeam().id, ancientId, 'bravo')).toBeNull();
    // The transition is not lost either: the audit row carries it, which is what makes this a skip
    // with evidence rather than a hole this daemon opened in its own trail.
    expect(
      hub.db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM audit WHERE action = 'lane.updated' AND target = ?")
        .get(ancientId),
    ).toEqual({ n: 1 });
  });

  it('a transition for a lane NEWER than the watermark still blocks — a hole is not pre-history', async () => {
    const first = await post(
      joinerBase,
      '/teams/bravo/lanes',
      { title: 'watermark' },
      nickOnJoiner,
    );
    const holeId = '01ZZZZZZZZZZZZZZZZZZZZZZZZ';
    expect(first.json.lane.id < holeId).toBe(true);
    bornBeforeReplication(holeId, 'hole');
    edit(holeId, 'nick/y');

    await replicate();

    expect(
      hub.db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM audit WHERE action = 'lane.updated' AND target = ?")
        .get(holeId),
    ).toEqual({ n: 0 });
  });
});
