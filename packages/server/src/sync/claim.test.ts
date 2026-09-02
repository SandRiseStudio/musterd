import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState } from '../node/state.js';
import { getLane, updateLane } from '../store/lanes.js';
import { addMember, getMemberByName } from '../store/members.js';
import { insertMessage, localNodeForTeam } from '../store/messages.js';
import { unbindSeat } from '../store/nodes.js';
import { touchAmbientPresence } from '../store/presence.js';
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
  // nick's first authenticated touch on the hub attaches an ambient presence there, and the hub's
  // own staging binds nick to the hub's node the moment that `presence.attached` is ingested
  // (presence replication §2). These cases are about the CLAIM edge with nick living on the
  // joiner, so take that first touch now, stage it, and release the fixture's binding — the same
  // admin unbind a human on two machines uses. Later touches refresh the row and emit nothing, so
  // nothing re-binds behind the tests' backs.
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

  it('a claim binds the seat to the claiming node; a claim for a seat bound elsewhere is refused 403 naming that node (ADR 328 §4)', async () => {
    const laneA = await laneOnBoth('a');
    const laneB = await laneOnBoth('b');
    // nick claims locally on the hub first: nick now lives on the hub's node.
    const onHub = await patch(
      hubBase,
      `/teams/bravo/lanes/${laneA}`,
      { owner_seat: 'nick' },
      nickOnHub,
    );
    expect(onHub.status).toBe(200);
    // The joiner, an admitted node, asks to claim AS nick. Before this fix the hub said yes.
    const res = await patch(
      joinerBase,
      `/teams/bravo/lanes/${laneB}`,
      { owner_seat: 'nick' },
      nickOnJoiner,
    );
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('bound_elsewhere');
    expect(res.json.node_label).toBe(hostname());
    expect(getLane(hub.db, hubTeam().id, laneB, 'bravo')!.owner_seat).toBeNull();
    // The binding is a hub fact, and the ledger says so.
    expect(
      hub.db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM audit WHERE action = 'seat.bound_elsewhere'")
        .get(),
    ).toEqual({ n: 1 });
  });

  it('unbinding (the explicit re-bind act, admin-only) lets the seat move: the next claim binds it to the joiner', async () => {
    const laneA = await laneOnBoth('a');
    const laneB = await laneOnBoth('b');
    await patch(hubBase, `/teams/bravo/lanes/${laneA}`, { owner_seat: 'nick' }, nickOnHub);
    const unbound = await call(
      hubBase,
      'DELETE',
      '/teams/bravo/nodes/bindings/nick',
      undefined,
      nickOnHub,
    );
    expect(unbound.status).toBe(200);
    const res = await patch(
      joinerBase,
      `/teams/bravo/lanes/${laneB}`,
      { owner_seat: 'nick' },
      nickOnJoiner,
    );
    expect(res.status).toBe(200);
    const joinerNode = readNodeState().nodes['bravo']!.node_id;
    const nick = hub.db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM members WHERE team_id = ? AND name = 'nick'")
      .get(hubTeam().id)!;
    expect(
      hub.db
        .prepare<
          [string],
          { node_id: string }
        >('SELECT node_id FROM seat_nodes WHERE member_id = ?')
        .get(nick.id),
    ).toEqual({ node_id: joinerNode });
    // Now the hub's own local claim as nick is the one refused.
    const laneC = await laneOnBoth('c');
    const local = await patch(
      hubBase,
      `/teams/bravo/lanes/${laneC}`,
      { owner_seat: 'nick' },
      nickOnHub,
    );
    expect(local.status).toBe(403);
    expect(local.json.error.code).toBe('bound_elsewhere');
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

describe('ADR 358 — a human seat trusts a set of machines by an explicit act from a bound session', () => {
  const bindingsOf = (name: string) =>
    hub.db
      .prepare<[string, string], { node_id: string }>(
        `SELECT s.node_id FROM seat_nodes s JOIN members m ON m.id = s.member_id
          WHERE m.team_id = ? AND m.name = ? ORDER BY s.bound_at, s.node_id`,
      )
      .all(hubTeam().id, name)
      .map((r) => r.node_id);

  it('a fresh machine cannot self-trust: the joiner asking for itself is refused with the bound node named, and nothing changes', async () => {
    const laneA = await laneOnBoth('a');
    await patch(hubBase, `/teams/bravo/lanes/${laneA}`, { owner_seat: 'nick' }, nickOnHub);
    const hubNode = localNodeForTeam(hub.db, hubTeam().id).id;
    const joinerNode = readNodeState().nodes['bravo']!.node_id;
    expect(bindingsOf('nick')).toEqual([hubNode]);

    const res = await post(
      joinerBase,
      '/teams/bravo/nodes/trust',
      { node_id: joinerNode },
      nickOnJoiner,
    );
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('bound_elsewhere');
    expect(res.json.node_id).toBe(hubNode);
    expect(bindingsOf('nick')).toEqual([hubNode]);
    const denied = hub.db
      .prepare<
        [],
        { detail: string }
      >("SELECT detail FROM audit WHERE action = 'seat.bound_elsewhere' AND result = 'deny' ORDER BY rowid DESC LIMIT 1")
      .get()!;
    expect(JSON.parse(denied.detail)).toMatchObject({
      act: 'trust',
      node: joinerNode,
      bound_to: hubNode,
    });
  });

  it('from the bound machine the seat trusts the joiner; both then claim as it, and the act forwarded from the joiner is idempotent', async () => {
    const laneA = await laneOnBoth('a');
    await patch(hubBase, `/teams/bravo/lanes/${laneA}`, { owner_seat: 'nick' }, nickOnHub);
    const hubNode = localNodeForTeam(hub.db, hubTeam().id).id;
    const joinerNode = readNodeState().nodes['bravo']!.node_id;

    const trusted = await post(
      hubBase,
      '/teams/bravo/nodes/trust',
      { node_id: joinerNode },
      nickOnHub,
    );
    expect(trusted.status).toBe(200);
    expect(trusted.json).toEqual({ seat: 'nick', node_id: joinerNode, already: false });
    expect(bindingsOf('nick')).toEqual([hubNode, joinerNode]);
    expect(
      hub.db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM audit WHERE action = 'seat.node_trusted'")
        .get(),
    ).toEqual({ n: 1 });

    // The joiner now speaks for nick — and so does the hub still.
    const laneB = await laneOnBoth('b');
    const fromJoiner = await patch(
      joinerBase,
      `/teams/bravo/lanes/${laneB}`,
      { owner_seat: 'nick' },
      nickOnJoiner,
    );
    expect(fromJoiner.status).toBe(200);
    const laneC = await laneOnBoth('c');
    const fromHub = await patch(
      hubBase,
      `/teams/bravo/lanes/${laneC}`,
      { owner_seat: 'nick' },
      nickOnHub,
    );
    expect(fromHub.status).toBe(200);

    // Forwarded: a session on the joiner (now in the set) vouches for the hub's node — already there.
    const again = await post(
      joinerBase,
      '/teams/bravo/nodes/trust',
      { node_id: hubNode },
      nickOnJoiner,
    );
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ seat: 'nick', node_id: hubNode, already: true });
    expect(bindingsOf('nick')).toEqual([hubNode, joinerNode]);
  });

  it('a node the hub does not know is refused 404, and the admin unbind clears the whole set', async () => {
    const laneA = await laneOnBoth('a');
    await patch(hubBase, `/teams/bravo/lanes/${laneA}`, { owner_seat: 'nick' }, nickOnHub);
    const unknown = await post(hubBase, '/teams/bravo/nodes/trust', { node_id: 'nope' }, nickOnHub);
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe('not_found');
    const joinerNode = readNodeState().nodes['bravo']!.node_id;
    await post(hubBase, '/teams/bravo/nodes/trust', { node_id: joinerNode }, nickOnHub);
    expect(bindingsOf('nick')).toHaveLength(2);
    const unbound = await call(
      hubBase,
      'DELETE',
      '/teams/bravo/nodes/bindings/nick',
      undefined,
      nickOnHub,
    );
    expect(unbound.status).toBe(200);
    expect(bindingsOf('nick')).toEqual([]);
  });
});
