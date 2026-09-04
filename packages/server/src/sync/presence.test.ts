import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_PRESENCE_TTL_MS, resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb, type Database } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState } from '../node/state.js';
import { getLane, updateLane } from '../store/lanes.js';
import { addMember, getMemberByName, mintCredential } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { unbindSeat } from '../store/nodes.js';
import {
  attach,
  clearMemberPresence,
  detach,
  hasLivePresence,
  listPresence,
  reapStale,
  reattestModel,
  reattestSurface,
  touchAmbientPresence,
} from '../store/presence.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

/**
 * Presence replication (spec 2026-09-02, ADR 356): `presence.*` is the third replicated kind, so
 * every machine's roster shows every seat on every machine and the hub's displacement rule sees
 * remote seats. These are the spec's falsifiers 1–7, run between two real daemons; falsifier 8 is
 * the store suite's "a remote row is never the subject of a locally emitted transition".
 *
 * Harness copied from claim.test.ts so this file stands alone.
 */

let hub: RunningServer;
let joiner: RunningServer;
let hubBase: string;
let joinerBase: string;
let nickOnHub: string;
let nickOnJoiner: string;
/** A hub-resident seat that opens the shared lanes, so nick's residence stays the tests' to decide. */
let hanaOnHub: string;
let dir: string;
let joinerCtx: Ctx;

async function call(base: string, method: string, path: string, body?: unknown, auth?: string) {
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
  call(base, 'POST', path, body, auth);
const patch = (base: string, path: string, body?: unknown, auth?: string) =>
  call(base, 'PATCH', path, body, auth);

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
const joinerNode = () => readNodeState().nodes['bravo']!.node_id;

const memberId = (db: Database, teamId: string, name: string) =>
  getMemberByName(db, teamId, name)!.id;

/** joiner → hub → joiner: push, the hub folds its staging, the hub stages its own, the joiner pulls. */
async function roundTrip() {
  await pushTeam(joinerCtx, joinerTeam());
  await pullTeam(hubCtx(), hubTeam());
  await pushTeam(hubCtx(), hubTeam());
  await pullTeam(joinerCtx, joinerTeam());
}

const presenceOf = (db: Database, teamId: string, name: string) =>
  listPresence(db, teamId, 45_000).find((s) => s.member.name === name)!;

/** A lane born on the hub, unowned, visible on both machines. */
async function laneOnBoth(title = 'shared'): Promise<string> {
  // Opened by hana, not nick: since push-level residence (2026-09-02) every kind binds at ingest,
  // so a lane nick opened here would bind nick to the hub at the loopback push and the joiner's
  // claim as nick would be `bound_elsewhere` — the rule working, against a premise these cases
  // set differently (nick lives on the joiner).
  const opened = await post(hubBase, '/teams/bravo/lanes', { title }, hanaOnHub);
  expect(opened.status).toBe(201);
  const id: string = opened.json.lane.id;
  await pushTeam(hubCtx(), hubTeam());
  await pullTeam(joinerCtx, joinerTeam());
  expect(getLane(joiner.db, joinerTeam().id, id, 'bravo')).toMatchObject({ id, owner_seat: null });
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-presence-'));
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
  // Roster identity replicates via git (ADR 058): the same second seat exists on both.
  addMember(hub.db, hubTeam(), { name: 'ada', kind: 'agent' });
  addMember(joiner.db, joinerTeam(), { name: 'ada', kind: 'agent' });
  hanaOnHub = mintCredential(
    hub.db,
    addMember(hub.db, hubTeam(), { name: 'hana', kind: 'human' }).row.id,
  ).credential;
  addMember(joiner.db, joinerTeam(), { name: 'hana', kind: 'human' });
  // The joiner's node row is minted on its first logged act; enrollment needs it to exist.
  const jt = joinerTeam();
  insertMessage(
    joiner.db,
    jt.id,
    memberId(joiner.db, jt.id, 'nick'),
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
  // nick's first authenticated touch on the hub attaches an ambient presence there, and the hub's
  // own staging binds nick to the hub's node at ingest (§2). The claim cases below have nick
  // living on the joiner, so take that touch now, stage it, and release the fixture's binding.
  const nickOnHubRow = getMemberByName(hub.db, hubTeam().id, 'nick')!;
  touchAmbientPresence(hub.db, nickOnHubRow.id, 'cli', 45_000);
  await pushTeam(hubCtx(), hubTeam());
  unbindSeat(hub.db, nickOnHubRow.id);
});

afterEach(async () => {
  await hub.close().catch(() => undefined);
  await joiner.close();
  delete process.env['MUSTERD_NODE_STATE'];
  rmSync(dir, { recursive: true, force: true });
});

describe('presence replication — every machine sees every seat', () => {
  it('1. a seat attached on the joiner is live on the hub with its facets and its node', async () => {
    const row = attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1', {
      model: 'gpt-5',
      model_source: 'observed',
      driver: 'nick',
      workspace: '~/b',
    });
    await roundTrip();
    const onHub = presenceOf(hub.db, hubTeam().id, 'ada');
    expect(onHub.status).toBe('online');
    expect(onHub.presences[0]).toMatchObject({
      surface: 'codex',
      model: 'gpt-5',
      driver: 'nick',
      workspace: '~/b',
      node: joinerNode(),
      // The node's label is the machine's own name, stamped at enrollment — not the invite's.
      node_label: hostname(),
    });
    expect(hasLivePresence(hub.db, memberId(hub.db, hubTeam().id, 'ada'), 45_000)).toBe(true);
    expect(row.node).toBeNull();
  });

  it("2. a claim against a lane held by a seat live on the joiner is refused naming the holder — ADR 355 §4's hole, closed", async () => {
    const laneId = await laneOnBoth();
    updateLane(hub.db, hubTeam().id, laneId, 'bravo', { owner_seat: 'ada' }, 5, undefined, {
      actor: 'ada',
    });
    attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1');
    await roundTrip();
    const res = await patch(
      joinerBase,
      `/teams/bravo/lanes/${laneId}`,
      { owner_seat: 'nick' },
      nickOnJoiner,
    );
    expect(res.status).toBe(409);
    expect(res.json.holder).toBe('ada');
    expect(res.json.error.message).toContain('live');
  });

  it('3. after the joiner goes quiet past the TTL the same claim succeeds, the row is gone, and nothing wrote a detached', async () => {
    const laneId = await laneOnBoth();
    updateLane(hub.db, hubTeam().id, laneId, 'bravo', { owner_seat: 'ada' }, 5, undefined, {
      actor: 'ada',
    });
    attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1');
    await roundTrip();
    hub.db
      .prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ?')
      .run(Date.now() - REMOTE_PRESENCE_TTL_MS - 1, joinerNode());
    reapStale(hub.db, 45_000);
    expect(presenceOf(hub.db, hubTeam().id, 'ada').status).toBe('offline');
    const res = await patch(
      joinerBase,
      `/teams/bravo/lanes/${laneId}`,
      { owner_seat: 'nick' },
      nickOnJoiner,
    );
    // The claim route itself touches the node; the rule ran against the swept table first.
    expect(res.status).toBe(200);
    expect(
      hub.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.detached'").get(),
    ).toEqual({ n: 0 });
  });

  it("4. a detach on the joiner removes the row on the hub; the hub holds the joiner's detached row and wrote none of its own", async () => {
    const row = attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1');
    await roundTrip();
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM presence WHERE id = ?').get(row.id)).toEqual({
      n: 1,
    });
    detach(joiner.db, row.id);
    await roundTrip();
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM presence WHERE id = ?').get(row.id)).toEqual({
      n: 0,
    });
    const det = hub.db
      .prepare<
        [],
        { origin_node: string }
      >("SELECT origin_node FROM audit WHERE action = 'presence.detached'")
      .all();
    expect(det).toEqual([{ origin_node: joinerNode() }]);
  });

  it('5. a reattest on the joiner changes model and surface on the hub', async () => {
    const row = attach(joiner.db, memberId(joiner.db, joinerTeam().id, 'ada'), 'codex', 'c1', {
      model: 'gpt-5',
      model_source: 'observed',
    });
    await roundTrip();
    reattestModel(joiner.db, row.id, 'gpt-5-mini', 'observed');
    reattestSurface(joiner.db, row.id, 'cli');
    await roundTrip();
    expect(hub.db.prepare('SELECT model, surface FROM presence WHERE id = ?').get(row.id)).toEqual({
      model: 'gpt-5-mini',
      surface: 'cli',
    });
  });

  it('6. a reattested whose attach never folded stops the fold; a detached for one is a no-op that advances', async () => {
    // Drain the joiner's j-0 first so the ghost is the next seq and the only thing the fold meets.
    await pushTeam(joinerCtx, joinerTeam());
    await pullTeam(hubCtx(), hubTeam());
    const enrolled = readNodeState().nodes['bravo']!;
    const head = hub.db
      .prepare<
        [string],
        { high: number }
      >('SELECT MAX(origin_seq) AS high FROM sync_log WHERE origin_node = ?')
      .get(enrolled.node_id)!.high;
    const ghost = (id: string, seq: number, action: string, detail: Record<string, unknown>) => ({
      kind: 'presence',
      team: 'bravo',
      origin_node: enrolled.node_id,
      origin_seq: seq,
      event: { id, ts: 1, actor: 'ada', action, target: 'ada', result: 'allow', detail },
    });
    const re = await post(
      hubBase,
      '/teams/bravo/sync/push',
      {
        events: [
          ghost('ghost-re', head + 1, 'presence.reattested', {
            presence: 'ghost',
            model: 'x',
            model_source: null,
            surface: 'cli',
          }),
        ],
      },
      enrolled.credential,
    );
    expect(re.status).toBe(200);
    expect(re.json.accepted).toBe(1);
    expect(await pullTeam(hubCtx(), hubTeam())).toBe(0);
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE id = 'ghost-re'").get()).toEqual({
      n: 0,
    });
    // The stop is per event, not per origin: a detached for the ghost, staged AFTER the blocker,
    // still waits behind it — everything up to N is applied means exactly that.
    const cursorBefore = hub.db
      .prepare<
        [string],
        { last_hub_seq: number }
      >('SELECT last_hub_seq FROM sync_pull_cursor WHERE team_id = ?')
      .get(hubTeam().id)!.last_hub_seq;
    expect(await pullTeam(hubCtx(), hubTeam())).toBe(0);
    expect(
      hub.db
        .prepare<
          [string],
          { last_hub_seq: number }
        >('SELECT last_hub_seq FROM sync_pull_cursor WHERE team_id = ?')
        .get(hubTeam().id)!.last_hub_seq,
    ).toBe(cursorBefore);
  });

  /**
   * ADR 382, found by the first real joiner: a `presence.attached` for a seat the receiving roster
   * does not hold used to stop the fold as `unresolved_seat` and retry forever. For a seat git will
   * never carry — a web sign-in, minted db-only — that wait never ends, and the cloud seat stopped
   * dead on one at hub_seq 9657. Presence for a seat we do not hold projects into nothing, so it
   * advances with its audit row; a MESSAGE from the same seat still blocks, because an inbox counts
   * it.
   */
  it('8. presence for a seat this roster does not hold advances with its audit row; a message from it still blocks', async () => {
    await pushTeam(joinerCtx, joinerTeam());
    await pullTeam(hubCtx(), hubTeam());
    const enrolled = readNodeState().nodes['bravo']!;
    const head = hub.db
      .prepare<
        [string],
        { high: number }
      >('SELECT MAX(origin_seq) AS high FROM sync_log WHERE origin_node = ?')
      .get(enrolled.node_id)!.high;
    // `web-ghost` exists on neither roster: the shape of a db-only web seat, which no git pull can
    // ever deliver.
    expect(getMemberByName(hub.db, hubTeam().id, 'web-ghost')).toBeUndefined();
    const staged = await post(
      hubBase,
      '/teams/bravo/sync/push',
      {
        events: [
          {
            kind: 'presence',
            team: 'bravo',
            origin_node: enrolled.node_id,
            origin_seq: head + 1,
            event: {
              id: 'web-ghost-attach',
              ts: 1,
              actor: 'web-ghost',
              action: 'presence.attached',
              target: 'web-ghost',
              result: 'allow',
              detail: { presence: 'p-web-ghost', surface: 'web', provenance: 'session' },
            },
          },
        ],
      },
      enrolled.credential,
    );
    expect(staged.status).toBe(200);

    expect(await pullTeam(hubCtx(), hubTeam())).toBe(1);
    // The transition is kept as evidence — a skip with a record, not a hole in the trail.
    expect(
      hub.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE id = 'web-ghost-attach'").get(),
    ).toEqual({ n: 1 });
    // And nothing was invented: no presence row, because there is no member to hang one on.
    expect(
      hub.db.prepare("SELECT COUNT(*) AS n FROM presence WHERE id = 'p-web-ghost'").get(),
    ).toEqual({ n: 0 });

    // The control. A message from the same unheld seat must still stop the fold: the inbox counts
    // messages, so an unresolved seat there is a gap worth finding rather than a fact that decides
    // nothing. Without it, "skip what cannot arrive" would quietly become "skip".
    const msg = await post(
      hubBase,
      '/teams/bravo/sync/push',
      {
        events: [
          {
            kind: 'message',
            team: 'bravo',
            origin_node: enrolled.node_id,
            origin_seq: head + 2,
            from_provenance: 'session',
            envelope: makeEnvelope({
              id: 'web-ghost-msg',
              team: 'bravo',
              from: 'web-ghost',
              to: { kind: 'team' },
              act: 'message',
              body: 'from a seat nobody holds',
              ts: 2,
            }),
          },
        ],
      },
      enrolled.credential,
    );
    expect(msg.status).toBe(200);
    expect(await pullTeam(hubCtx(), hubTeam())).toBe(0);
    expect(
      hub.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = 'web-ghost-msg'").get(),
    ).toEqual({ n: 0 });
  });

  it('7. a fresh hello for a seat on the joiner clears its local rows with reason cleared and leaves the hub-origin row alone', async () => {
    const hubAda = attach(hub.db, memberId(hub.db, hubTeam().id, 'ada'), 'claude-code', 'h1');
    await roundTrip();
    expect(
      joiner.db.prepare('SELECT node FROM presence WHERE id = ?').get(hubAda.id),
    ).toMatchObject({ node: expect.any(String) });
    const adaJ = memberId(joiner.db, joinerTeam().id, 'ada');
    const local = attach(joiner.db, adaJ, 'codex', 'c1');
    clearMemberPresence(joiner.db, adaJ);
    expect(
      joiner.db.prepare('SELECT COUNT(*) AS n FROM presence WHERE id = ?').get(local.id),
    ).toEqual({ n: 0 });
    expect(
      joiner.db.prepare('SELECT COUNT(*) AS n FROM presence WHERE id = ?').get(hubAda.id),
    ).toEqual({ n: 1 });
    expect(
      joiner.db
        .prepare<[string], { detail: string }>(
          "SELECT detail FROM audit WHERE action = 'presence.detached' AND origin_node = ?",
        )
        .all(joinerNode())
        .map((r) => JSON.parse(r.detail)),
    ).toEqual([{ presence: local.id, reason: 'cleared' }]);
  });
});
