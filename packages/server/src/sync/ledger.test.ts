import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb, type Database } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState } from '../node/state.js';
import { appendAudit } from '../store/audit.js';
import { deriveWakeMetrics } from '../store/insights.js';
import { addMember, getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { foldBatch } from './fold.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

/**
 * The ledger kind (ADR 365): the wake economy crosses the wire, and decides nothing when it lands.
 *
 * Falsifiers, run between two real daemons:
 *  1. a wake paid for on the joiner is counted by the hub's `report` (the defect this closes);
 *  2. the rows land verbatim in `audit` with the ORIGIN's stamp, projected into nothing;
 *  3. the deciding readers ignore a peer's rows — a seat at its hourly cap on the joiner is still
 *     wakeable on the hub (ADR 365 §3, the residence-2 line);
 *  4. a projected verb wearing the ledger tag stops the fold instead of landing unprojected.
 *
 * Harness copied from presence.test.ts so this file stands alone.
 */

let hub: RunningServer;
let joiner: RunningServer;
let hubBase: string;
let joinerBase: string;
let nickOnHub: string;
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
const joinerNode = () => readNodeState().nodes['bravo']!.node_id;

async function roundTrip() {
  await pushTeam(joinerCtx, joinerTeam());
  await pullTeam(hubCtx(), hubTeam());
  await pushTeam(hubCtx(), hubTeam());
  await pullTeam(joinerCtx, joinerTeam());
}

/** Every `audit` row for an action, on one machine. */
const auditRows = (db: Database, teamId: string, action: string) =>
  db
    .prepare<
      [string, string],
      { id: string; target: string; detail: string | null; origin_node: string; origin_seq: number }
    >('SELECT id, target, detail, origin_node, origin_seq FROM audit WHERE team_id = ? AND action = ?')
    .all(teamId, action);

/** One wake row as the report path writes it: through `appendAudit`, on the joiner. */
function wakeRow(action: string, seat: string, detail: Record<string, unknown>, ts?: number) {
  appendAudit(joiner.db, joinerTeam().id, {
    actor: null,
    action,
    target: seat,
    result: action === 'residency.wake_failed' ? 'deny' : 'allow',
    detail,
  });
  if (ts !== undefined) {
    joiner.db
      .prepare('UPDATE audit SET ts = ? WHERE team_id = ? AND action = ? AND ts != ?')
      .run(ts, joinerTeam().id, action, ts);
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-ledger-'));
  process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');

  hub = createServer({ db: openDb(':memory:'), port: 0 });
  hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
  joiner = createServer({ db: openDb(':memory:'), port: 0 });
  joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
  joinerCtx = { db: joiner.db, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };

  nickOnHub = (
    await post(hubBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
  ).json.human_credential;
  await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } });
  // Roster identity replicates via git (ADR 058): the same agent seat exists on both.
  addMember(hub.db, hubTeam(), { name: 'ada', kind: 'agent' });
  addMember(joiner.db, joinerTeam(), { name: 'ada', kind: 'agent' });

  // The joiner's node row is minted on its first logged act; enrollment needs it to exist.
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
  const { json: minted } = await post(
    hubBase,
    '/teams/bravo/nodes/invite',
    { label: 'joiner laptop' },
    nickOnHub,
  );
  expect(
    (
      await post(joinerBase, '/node/enroll', {
        hub_url: hubBase,
        code: minted.invite,
        team: 'bravo',
      })
    ).status,
  ).toBe(200);
});

afterEach(async () => {
  await hub.close().catch(() => undefined);
  await joiner.close();
  delete process.env['MUSTERD_NODE_STATE'];
  rmSync(dir, { recursive: true, force: true });
});

describe('the ledger kind — the wake economy crosses, and decides nothing when it lands', () => {
  it('1. a wake paid for on the joiner is counted by the hub`s report', async () => {
    const now = Date.now();
    wakeRow('residency.woke', 'ada', { act: 'a-1', lease_id: 'l-1' }, now - 1000);
    wakeRow(
      'residency.wake_cost',
      'ada',
      { act: 'a-1', lease_id: 'l-1', cost_usd: 0.42 },
      now - 900,
    );

    // Before the fold the hub's ledger is empty — the defect, stated as a precondition.
    expect(deriveWakeMetrics(hub.db, hubTeam().id, now).cost_usd_total).toBe(null);

    await roundTrip();

    const metrics = deriveWakeMetrics(hub.db, hubTeam().id, now);
    expect(metrics.cost_usd_total).toBeCloseTo(0.42);
    expect(metrics.cost_reported).toBe(1);
    expect(metrics.by_seat.find((s) => s.seat === 'ada')?.cost_usd_total).toBeCloseTo(0.42);
  });

  it('2. the row lands verbatim with the origin`s stamp, and projects into nothing', async () => {
    wakeRow('residency.wake_failed', 'ada', { act: 'a-2', reason: 'lease_expired' });
    const mintedOnJoiner = auditRows(joiner.db, joinerTeam().id, 'residency.wake_failed')[0]!;
    expect(mintedOnJoiner.origin_node).toBe(joinerNode());
    expect(mintedOnJoiner.origin_seq).toBeGreaterThan(0);

    await roundTrip();

    const onHub = auditRows(hub.db, hubTeam().id, 'residency.wake_failed');
    expect(onHub).toHaveLength(1);
    // The origin's stamp verbatim — never re-minted from the hub's own allocator.
    expect(onHub[0]).toMatchObject({
      id: mintedOnJoiner.id,
      target: 'ada',
      origin_node: joinerNode(),
      origin_seq: mintedOnJoiner.origin_seq,
    });
    expect(JSON.parse(onHub[0]!.detail!)).toMatchObject({ reason: 'lease_expired' });
    // Projected into nothing: no lane, no presence row was invented for it.
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM lanes').get() as { n: number }).toMatchObject({
      n: 0,
    });
  });

  it('3. a peer`s wake rows do not decide here — the hourly cap counts what this machine minted', async () => {
    const now = Date.now();
    // Six wakes on the joiner inside the hour: past any default hourly cap, if they counted.
    for (let i = 0; i < 6; i += 1) {
      wakeRow('residency.woke', 'ada', { act: `cap-${i}`, lease_id: `l-${i}` }, now - 60_000);
    }
    await roundTrip();
    // The hub HOLDS them — this is not a test that the fold dropped the rows.
    expect(auditRows(hub.db, hubTeam().id, 'residency.woke')).toHaveLength(6);

    const wakesHere = hub.db
      .prepare<[string, string], { n: number }>(
        `SELECT COUNT(*) AS n FROM audit
          WHERE team_id = ? AND action IN ('residency.woke','residency.wake_failed')
            AND target = ? AND ts > 0
            AND origin_node IN ('', COALESCE((SELECT node_id FROM local_node l WHERE l.team_id = audit.team_id), ''))`,
      )
      .get(hubTeam().id, 'ada');
    expect(wakesHere?.n).toBe(0);
  });

  it('4. a projected verb wearing the ledger tag stops the fold', () => {
    const team = hubTeam();
    const result = foldBatch(hub.db, team.id, [
      {
        kind: 'ledger',
        team: 'bravo',
        hub_seq: 1,
        origin_node: 'node-elsewhere',
        origin_seq: 1,
        event: {
          id: 'a-smuggled',
          ts: 1000,
          actor: 'ada',
          action: 'lane.claimed',
          target: 'lane-x',
          result: 'allow',
          detail: { lane: 'lane-x' },
        },
      },
    ]);
    expect(result.stop).toMatchObject({ kind: 'mistagged_ledger_event', action: 'lane.claimed' });
    expect(result.applied).toBe(0);
    expect(auditRows(hub.db, team.id, 'lane.claimed')).toHaveLength(0);
  });
});
