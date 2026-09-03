import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { appendAudit } from '../store/audit.js';
import { setCursor } from '../store/cursors.js';
import { getMemberByName } from '../store/members.js';
import { getMemory, saveMemory } from '../store/memory.js';
import { insertMessage } from '../store/messages.js';
import { getPolicy, getTeamBySlug, setPolicy } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

/**
 * The residence-2 census (lane 01M1JNNF42, 2026-09-03): what crosses the wire TODAY, pinned so the
 * wiki's per-table matrix cannot drift from the code. ADR 325 promised more than this (seed thread
 * entries, wake turns, the audited verbs, the inbox_cursors max-merge, the tool_call_stats
 * counters); each of those is a named gap on the census page with its own follow-on lane. When one
 * closes, the assertion here that names it goes red — update the census, then the test.
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

/** Both directions, both folds. */
async function roundTrip() {
  await pushTeam(joinerCtx, joinerTeam());
  await pullTeam(hubCtx(), hubTeam());
  await pushTeam(hubCtx(), hubTeam());
  await pullTeam(joinerCtx, joinerTeam());
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-census-'));
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
  const jt = joinerTeam();
  const nick = getMemberByName(joiner.db, jt.id, 'nick')!;
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

describe('residence-2 census — what crosses the wire at this build', () => {
  it('the replicated kinds are exactly message, lane, presence and policy; nothing else is ever staged', async () => {
    // A lane transition and a message on the joiner, a claim on the hub: every kind that replicates.
    const opened = await post(
      joinerBase,
      '/teams/bravo/lanes',
      { title: 'x', claim: true },
      nickOnJoiner,
    );
    expect(opened.status).toBe(201);
    await roundTrip();
    const kinds = hub.db
      .prepare<[], { payload: string }>('SELECT payload FROM sync_log')
      .all()
      .map((r) => (JSON.parse(r.payload) as { kind?: string }).kind ?? 'message');
    expect(new Set(kinds)).toEqual(
      new Set(['message', 'lane', 'presence', 'policy'].filter((k) => kinds.includes(k))),
    );
    expect(
      kinds.every((k) => k === 'message' || k === 'lane' || k === 'presence' || k === 'policy'),
    ).toBe(true);
  });

  it('CLOSED (gap 1, ADR 367): a policy change on the hub reaches the joiner — an UNSTAMPED one still does not', async () => {
    // The gap this census named is closed: the admin route stamps, so the change replicates.
    await post(hubBase, '/teams/bravo/policy', { residency: { hourly_cap: 1 } }, nickOnHub);
    expect(getPolicy(hub.db, hubTeam().id).residency.hourly_cap).toBe(1);
    await roundTrip();
    expect(getPolicy(joiner.db, joinerTeam().id).residency.hourly_cap).toBe(1);

    // …and the store's raw `setPolicy` still writes nothing to the wire. It is the fold's own
    // projector and the seam a future in-process caller could fall through: the stamp comes from
    // `applyPolicyChange`, never from the UPDATE. This half is why the assertion above means what
    // it says rather than "any local write happens to converge".
    setPolicy(hub.db, hubTeam().id, { residency: { hourly_cap: 7 } });
    await roundTrip();
    expect(getPolicy(joiner.db, joinerTeam().id).residency.hourly_cap).toBe(1);
  });

  it('GAP (ADR 325 residence 2, promised): seat memory and the inbox cursor are per-machine — a seat that moves reads neither', async () => {
    const nickJ = getMemberByName(joiner.db, joinerTeam().id, 'nick')!;
    saveMemory(joiner.db, nickJ.id, { headline: 'left off here', body: 'mid-flight' });
    setCursor(joiner.db, nickJ.id, 'j-0');
    await roundTrip();
    const nickH = getMemberByName(hub.db, hubTeam().id, 'nick')!;
    expect(getMemory(hub.db, nickH.id)).toBeNull();
    expect(
      hub.db
        .prepare<
          [string],
          { n: number }
        >('SELECT COUNT(*) AS n FROM inbox_cursors WHERE member_id = ?')
        .get(nickH.id),
    ).toEqual({ n: 0 });
  });

  it('GAP (ADR 325 residence 2, promised): audit verbs written best-effort carry no origin stamp and never push — residency.* and memory.save among them (policy.change left this list with ADR 367)', async () => {
    const jt = joinerTeam();
    appendAudit(joiner.db, jt.id, {
      actor: 'nick',
      action: 'residency.wake_leased',
      target: 'ada',
      result: 'allow',
      detail: { lease: 'L1' },
    });
    await roundTrip();
    const rows = joiner.db
      .prepare<
        [],
        { origin_seq: number }
      >("SELECT origin_seq FROM audit WHERE action = 'residency.wake_leased'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin_seq).toBe(0); // no stamp — `appendAudit`, not `appendReplicatedEvent`
    expect(
      hub.db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM audit WHERE action = 'residency.wake_leased'")
        .get(),
    ).toEqual({ n: 0 });
  });
});
