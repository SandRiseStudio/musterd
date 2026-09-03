import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getPolicy, getStoredPolicy, getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { foldBatch } from './fold.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

/**
 * Policy replication (ADR 365, residence-2 census gap 1) between two real daemons.
 *
 * The census measured the gap: `setPolicy` wrote a local blob and nothing shipped it, so a joiner's
 * host actuator ran different `hourly_cap`/`cooldown`/`loops` than the hub after every `policy set`
 * — the one policy input to the wake ledger, forked silently per machine. These are the lane's
 * falsifiers: the hub's change reaches the joiner, the joiner's own change is decided by the hub,
 * and a joiner that cannot reach the hub refuses rather than forking.
 *
 * Harness copied from census.test.ts so this file stands alone.
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

const hubCtx = (): Ctx => ({
  db: hub.db,
  hub: new Hub(),
  config: resolveConfig(),
  rosterRoots: [],
});
const hubTeam = () => getTeamBySlug(hub.db, 'bravo')!;
const joinerTeam = () => getTeamBySlug(joiner.db, 'bravo')!;

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-policy-sync-'));
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
  // The joiner's node row is minted on its first logged act, and enrollment needs one.
  const jt = joinerTeam();
  insertMessage(
    joiner.db,
    jt.id,
    getMemberByName(joiner.db, jt.id, 'nick')!.id,
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

describe('policy replication (ADR 365)', () => {
  it('the hub sets a wake cap and the joiner runs it after one round trip', async () => {
    const set = await post(
      hubBase,
      '/teams/bravo/policy',
      { residency: { hourly_cap: 1 } },
      nickOnHub,
    );
    expect(set.status).toBe(200);
    expect(getPolicy(joiner.db, joinerTeam().id).residency.hourly_cap).not.toBe(1);

    await roundTrip();

    // The census's measured gap, now closed: the joiner's host caps wakes by the HUB's number.
    expect(getPolicy(joiner.db, joinerTeam().id).residency.hourly_cap).toBe(1);
  });

  it('the folded row is the SPARSE doc — a knob nobody chose keeps this build’s default alive', async () => {
    await post(hubBase, '/teams/bravo/policy', { residency: { hourly_cap: 1 } }, nickOnHub);
    await roundTrip();
    // ADR 185's whole point, carried across the wire: only the chosen key is stored. Shipping the
    // effective policy would bake the hub build's defaults into this row and kill the schema
    // default here for every other knob — the #530 failure, replicated.
    expect(getStoredPolicy(joiner.db, joinerTeam().id)).toEqual({ residency: { hourly_cap: 1 } });
  });

  it('replace semantics survive the fold: a knob cleared on the hub is cleared on the joiner', async () => {
    await post(hubBase, '/teams/bravo/policy', { residency: { hourly_cap: 1 } }, nickOnHub);
    await roundTrip();
    expect(getPolicy(joiner.db, joinerTeam().id).residency.hourly_cap).toBe(1);

    const cleared = getPolicy(hub.db, hubTeam().id); // the default the reset must restore
    await post(hubBase, '/teams/bravo/policy', {}, nickOnHub);
    await roundTrip();
    expect(getStoredPolicy(joiner.db, joinerTeam().id)).toEqual({});
    expect(getPolicy(joiner.db, joinerTeam().id).residency.hourly_cap).not.toBe(1);
    expect(getPolicy(joiner.db, joinerTeam().id).residency.hourly_cap).toBe(
      getPolicy(hub.db, hubTeam().id).residency.hourly_cap,
    );
    expect(cleared.residency.hourly_cap).toBe(1); // the read above was taken BEFORE the reset
  });

  it("an admin's change on the JOINER is decided by the hub and comes back through the fold", async () => {
    const set = await post(
      joinerBase,
      '/teams/bravo/policy',
      { residency: { cooldown_ms: 2_400_000 } },
      nickOnJoiner,
    );
    expect(set.status).toBe(200);
    expect(set.json.policy.residency.cooldown_ms).toBe(2_400_000);

    // The hub decided it — the event is the hub's, and the joiner minted nothing.
    expect(getPolicy(hub.db, hubTeam().id).residency.cooldown_ms).toBe(2_400_000);
    const hubStamped = hub.db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM audit WHERE action = 'policy.change' AND origin_seq > 0")
      .get();
    expect(hubStamped).toEqual({ n: 1 });
    expect(
      joiner.db
        .prepare<[string], { n: number }>(
          `SELECT COUNT(*) AS n FROM audit WHERE action = 'policy.change'
             AND origin_node = (SELECT node_id FROM local_node WHERE team_id = ?)`,
        )
        .get(joinerTeam().id),
    ).toEqual({ n: 0 });

    await roundTrip();
    expect(getPolicy(joiner.db, joinerTeam().id).residency.cooldown_ms).toBe(2_400_000);
  });

  it('a joiner-side change with the hub down REFUSES hub_unreachable and changes nothing', async () => {
    const before = getStoredPolicy(joiner.db, joinerTeam().id);
    await hub.close();

    const res = await post(
      joinerBase,
      '/teams/bravo/policy',
      { residency: { hourly_cap: 9 } },
      nickOnJoiner,
    );
    // ADR 325 §Offline semantics: policy is not an act that may fork, so the refusal is the answer.
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe('hub_unreachable');
    expect(getStoredPolicy(joiner.db, joinerTeam().id)).toEqual(before);
    expect(
      joiner.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'policy.change'").get(),
    ).toEqual({ n: 0 });

    hub = createServer({ db: openDb(':memory:'), port: 0 }); // afterEach closes a live server
    await hub.listen();
  });

  it('setting policy never binds the admin to the hub — the seat still speaks from its own machine', async () => {
    // Residence binds who may speak AS a seat; a policy change is a fact about the TEAM, minted by
    // the hub on a joiner admin's behalf. Binding nick to the hub here would refuse nick's next
    // push from the laptop the seat actually lives on.
    await post(joinerBase, '/teams/bravo/policy', { residency: { hourly_cap: 3 } }, nickOnJoiner);
    await roundTrip();
    const opened = await post(
      joinerBase,
      '/teams/bravo/lanes',
      { title: 'work from the laptop', claim: true },
      nickOnJoiner,
    );
    expect(opened.status).toBe(201);
    await roundTrip();
    expect(
      hub.db.prepare("SELECT COUNT(*) AS n FROM lanes WHERE title = 'work from the laptop'").get(),
    ).toEqual({ n: 1 });
  });

  it('a policy verb this build cannot project STOPS the fold rather than storing it', async () => {
    // The discipline every kind shares: an unknown verb from a newer origin blocks at that event,
    // retried each tick, instead of landing a transition nothing can apply.
    const result = foldBatch(joiner.db, joinerTeam().id, [
      {
        kind: 'policy',
        team: 'bravo',
        hub_seq: 9_000,
        origin_node: 'node-from-the-future',
        origin_seq: 1,
        event: {
          id: 'a-future-verb',
          ts: Date.now(),
          actor: 'nick',
          action: 'policy.rotated',
          target: null,
          result: 'allow',
          detail: {},
        },
      },
    ]);
    expect(result.stop).toEqual({
      kind: 'unknown_policy_event',
      action: 'policy.rotated',
      hub_seq: 9_000,
    });
    expect(result.applied).toBe(0);
  });
});
