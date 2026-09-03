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
 * Policy replication (ADR 367, residence-2 census gap 1) between two real daemons.
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

/**
 * A SECOND enrolled node — a real machine credential for this team, held by neither the hub nor the
 * first joiner. This is the attacker's actual position in gptbot's review of #1228: not an outsider
 * guessing a token, but an admitted machine (an agent's laptop, a CI box, a node whose human is an
 * ordinary member) doing something its enrollment never entitled it to.
 *
 * It needs no daemon of its own, which is why it can live in this file: `/nodes/join` is the hub's
 * half of enrollment and hands back the credential directly. Standing up a second `RunningServer`
 * would not work here anyway — `MUSTERD_NODE_STATE` is one file keyed by slug, so a second daemon
 * enrolling as `bravo` overwrites the first joiner's entry and breaks `roundTrip`.
 */
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

/**
 * Make nick resident on the joiner as far as the HUB is concerned — one ordinary act, replicated.
 * Every forwarded policy change needs this, and every real admin already has it: the seat lives on
 * the machine its human works from, and the first thing it does there binds it.
 */
async function residentOnJoiner() {
  const opened = await post(
    joinerBase,
    '/teams/bravo/lanes',
    { title: 'nick works from this laptop', claim: true },
    nickOnJoiner,
  );
  expect(opened.status).toBe(201);
  await roundTrip();
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

describe('policy replication (ADR 367)', () => {
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
    // The seat has to be resident on this machine first — the strict residence check the forward
    // gained from gptbot's review of #1228. Nick's ordinary work is what establishes that, so this
    // line is not test scaffolding: it is the state any real admin is already in.
    await residentOnJoiner();

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

  /**
   * The two holes gptbot's review of #1228 found, each with the machine that would have walked
   * through it. Both are about the same confusion: a node credential proves WHICH MACHINE is
   * speaking and never WHO it may speak for.
   */
  describe('an enrolled node that is not the hub cannot set policy (gptbot, 2026-09-03)', () => {
    it('the forward is refused when the actor lives on a DIFFERENT machine', async () => {
      // nick's ordinary work on the joiner replicates, and binds the seat to that node on the hub.
      await residentOnJoiner();
      const before = getStoredPolicy(hub.db, hubTeam().id);

      const evil = await enrollSecondNode('someone elses laptop');
      const res = await post(
        hubBase,
        '/teams/bravo/sync/policy',
        { actor: 'nick', policy: { residency: { hourly_cap: 19 } } },
        evil.credential,
      );

      // Before the fix this was a 200: the node authenticated, `actor: 'nick'` was taken at its
      // word, and nick's hub capabilities did the rest — so any enrolled machine could set the
      // team's wake caps by naming an admin it had never been.
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('bound_elsewhere');
      expect(res.json.error.message).toMatch(/lives on/);
      expect(getStoredPolicy(hub.db, hubTeam().id)).toEqual(before);
      expect(
        hub.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'policy.change'").get(),
      ).toEqual({ n: 0 });
    });

    it('an UNBOUND admin seat is not up for grabs — the forward refuses instead of claiming it', async () => {
      // The sharper half, and the reason this route uses the strict residence check rather than the
      // first-writer-wins one the lane routes use. Nobody has spoken for `ada` on any machine yet.
      // Under `assertSeatResident` the forward below would have BOUND the seat to the caller in the
      // same call that used it, and the policy would have landed.
      await post(
        hubBase,
        '/teams/bravo/members',
        { name: 'ada', kind: 'human', role: 'admin' },
        nickOnHub,
      );
      const before = getStoredPolicy(hub.db, hubTeam().id);

      const evil = await enrollSecondNode('a CI box');
      const res = await post(
        hubBase,
        '/teams/bravo/sync/policy',
        { actor: 'ada', policy: { residency: { hourly_cap: 19 } } },
        evil.credential,
      );

      expect(res.status).toBe(403);
      expect(res.json.error.message).toMatch(/not resident on any machine yet/);
      expect(getStoredPolicy(hub.db, hubTeam().id)).toEqual(before);
      // The refusal must not have created the binding it refused for want of.
      expect(
        hub.db
          .prepare<
            [string],
            { n: number }
          >("SELECT COUNT(*) AS n FROM seat_nodes WHERE member_id = (SELECT id FROM members WHERE team_id = ? AND name = 'ada')")
          .get(hubTeam().id),
      ).toEqual({ n: 0 });
    });

    it('a hand-built policy event pushed straight into the log is refused at ingest', async () => {
      const before = getStoredPolicy(hub.db, hubTeam().id);
      const evil = await enrollSecondNode('a CI box');

      // The forward above is the front door; this is the window beside it. `SyncPushRequestSchema`
      // admits `kind:'policy'` (it must — the hub's own loopback push carries them), and the kind
      // is exempt from residence, so without an origin check this event lands in `sync_log` and the
      // fold's REPLACE semantics install it as the team's policy on every machine.
      const res = await post(
        hubBase,
        '/teams/bravo/sync/push',
        {
          events: [
            {
              kind: 'policy',
              team: 'bravo',
              origin_node: evil.nodeId,
              origin_seq: 1,
              event: {
                id: 'forged-policy-1',
                ts: Date.now(),
                actor: 'nick',
                action: 'policy.change',
                target: null,
                result: 'allow',
                detail: { residency: { hourly_cap: 19 } },
              },
            },
          ],
        },
        evil.credential,
      );

      expect(res.status).toBe(403);
      expect(res.json.error.message).toMatch(/policy event is the hub's to mint/);
      expect(getStoredPolicy(hub.db, hubTeam().id)).toEqual(before);
      expect(
        hub.db.prepare("SELECT COUNT(*) AS n FROM sync_log WHERE id = 'forged-policy-1'").get(),
      ).toEqual({ n: 0 });
    });

    it('the hub’s OWN loopback push still carries policy events — the exemption is not switched off', async () => {
      // The positive control for the check above. A test that only ever refuses would have passed
      // just as happily against a build that dropped the policy kind altogether.
      await post(hubBase, '/teams/bravo/policy', { residency: { hourly_cap: 7 } }, nickOnHub);
      await roundTrip();
      expect(getPolicy(joiner.db, joinerTeam().id).residency.hourly_cap).toBe(7);
    });
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
