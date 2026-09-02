import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState } from '../node/state.js';
import { getLane, updateLane } from '../store/lanes.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

/**
 * Federation increment 3c (ADR 325 §Authority split, residence 1): a lane claim is hub-authoritative.
 * On a joiner a self-claim goes to the hub, which runs the CAS and answers with the lane or a
 * DISTINGUISHABLE conflict naming the holder; while the hub is unreachable the claim refuses with
 * its own error rather than landing provisionally.
 *
 * The lane's falsifier, verbatim: "a claim minted on a joiner reaches the hub and a competing claim
 * for the same lane is refused with a distinguishable error, not silently dropped."
 *
 * Harness copied from lanes.test.ts so this file stands alone.
 */

let hub: RunningServer;
let joiner: RunningServer;
let hubBase: string;
let joinerBase: string;
let nickOnHub: string;
let nickOnJoiner: string;
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

/** Hub → joiner: the hub stages its own history (loopback), the joiner folds it. */
async function hubToJoiner() {
  await pushTeam(hubCtx(), hubTeam());
  await pullTeam(joinerCtx, joinerTeam());
}

/** A lane born on the hub, unowned, visible on both machines. */
async function laneOnBoth(title = 'shared'): Promise<string> {
  const opened = await post(hubBase, '/teams/bravo/lanes', { title }, nickOnHub);
  expect(opened.status).toBe(201);
  const id: string = opened.json.lane.id;
  await hubToJoiner();
  expect(getLane(joiner.db, joinerTeam().id, id, 'bravo')).toMatchObject({ id, owner_seat: null });
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-claim-'));
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
  await hub.close().catch(() => undefined);
  await joiner.close();
  delete process.env['MUSTERD_NODE_STATE'];
  rmSync(dir, { recursive: true, force: true });
});

describe('federation 3c — the hub arbitrates a claim', () => {
  it('a claim on the joiner is decided by the hub, whose row names the node the seat resides on', async () => {
    const laneId = await laneOnBoth();
    const res = await patch(
      joinerBase,
      `/teams/bravo/lanes/${laneId}`,
      { owner_seat: 'nick' },
      nickOnJoiner,
    );
    expect(res.status).toBe(200);
    expect(res.json.lane).toMatchObject({ id: laneId, owner_seat: 'nick', state: 'claimed' });

    // The hub holds the decision.
    expect(getLane(hub.db, hubTeam().id, laneId, 'bravo')).toMatchObject({
      owner_seat: 'nick',
      state: 'claimed',
    });
    // Seat→node residence binding, in the log: the hub's claimed row names the joiner's node.
    const joinerNode = readNodeState().nodes['bravo']!.node_id;
    const claimed = hub.db
      .prepare<
        [string],
        { actor: string; detail: string }
      >("SELECT actor, detail FROM audit WHERE action = 'lane.claimed' AND target = ?")
      .get(laneId)!;
    expect(claimed.actor).toBe('nick');
    expect(JSON.parse(claimed.detail)).toMatchObject({ owner: 'nick', node: joinerNode });
    // The joiner converges from the hub's log, not from a local write of its own.
    expect(
      joiner.db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM audit WHERE action = 'lane.claimed' AND target = ?")
        .get(laneId),
    ).toEqual({ n: 1 });
    await hubToJoiner();
    expect(getLane(joiner.db, joinerTeam().id, laneId, 'bravo')).toMatchObject({
      owner_seat: 'nick',
      state: 'claimed',
    });
  });

  it("a competing claim is refused with a distinguishable error naming the holder, and the joiner's row is untouched", async () => {
    const laneId = await laneOnBoth();
    // ada takes it on the hub first; the joiner has not yet seen that.
    updateLane(hub.db, hubTeam().id, laneId, 'bravo', { owner_seat: 'ada' }, 5, undefined, {
      actor: 'ada',
    });
    const res = await patch(
      joinerBase,
      `/teams/bravo/lanes/${laneId}`,
      { owner_seat: 'nick' },
      nickOnJoiner,
    );
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
    expect(res.json.error.message).toContain('ada');
    expect(res.json.holder).toBe('ada');
    expect(getLane(hub.db, hubTeam().id, laneId, 'bravo')!.owner_seat).toBe('ada');
    expect(getLane(joiner.db, joinerTeam().id, laneId, 'bravo')!.owner_seat).toBeNull();
  });

  it('refuses, with its own error, while the hub is unreachable — never a provisional claim', async () => {
    const laneId = await laneOnBoth();
    await hub.close();
    const res = await patch(
      joinerBase,
      `/teams/bravo/lanes/${laneId}`,
      { owner_seat: 'nick' },
      nickOnJoiner,
    );
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe('hub_unreachable');
    expect(getLane(joiner.db, joinerTeam().id, laneId, 'bravo')!.owner_seat).toBeNull();
  });

  it('a handoff to someone else stays local — only a self-claim is arbitrated', async () => {
    const laneId = await laneOnBoth();
    await hub.close();
    const res = await patch(
      joinerBase,
      `/teams/bravo/lanes/${laneId}`,
      { owner_seat: 'ada' },
      nickOnJoiner,
    );
    expect(res.status).toBe(200);
    expect(getLane(joiner.db, joinerTeam().id, laneId, 'bravo')!.owner_seat).toBe('ada');
  });

  it('the hub refuses a claim from a node for a lane it has not yet folded, so the joiner retries after sync', async () => {
    const opened = await post(
      joinerBase,
      '/teams/bravo/lanes',
      { title: 'unsynced' },
      nickOnJoiner,
    );
    const laneId: string = opened.json.lane.id;
    const res = await patch(
      joinerBase,
      `/teams/bravo/lanes/${laneId}`,
      { owner_seat: 'nick' },
      nickOnJoiner,
    );
    expect(res.status).toBe(409);
    expect(res.json.error.message).toMatch(/not yet replicated|sync/);
  });
});
