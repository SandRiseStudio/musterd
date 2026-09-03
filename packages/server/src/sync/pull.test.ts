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
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { foldBatch } from './fold.js';
import { pullTeam } from './pull.js';
import { pushTeam } from './push.js';

/**
 * The pull side (ADR 325 increment 3b-ii), exercised between two real daemons: the route that pages
 * the hub's canonical order, and the loop that feeds it to the fold on hub and joiner alike.
 *
 * Harness copied from push.test.ts so this file stands alone — a test that imports another test's
 * lifecycle is a test whose setup nobody can read in one place.
 */

let hub: RunningServer;
let joiner: RunningServer;
let hubBase: string;
let joinerBase: string;
let nickCredential: string;
let dir: string;
/** The joiner's own context — pushTeam runs inside the joiner daemon, not the hub. */
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

/** Send on the joiner, the way a live daemon mints its local node row and stamps an origin_seq. */
function send(server: RunningServer, id: string, body = 'hi') {
  const team = getTeamBySlug(server.db, 'bravo')!;
  const member = server.db
    .prepare<[string], { id: string }>('SELECT id FROM members WHERE team_id = ? LIMIT 1')
    .get(team.id)!;
  insertMessage(
    server.db,
    team.id,
    member.id,
    null,
    makeEnvelope({
      id,
      team: 'bravo',
      from: 'nick',
      to: { kind: 'team' as const },
      act: 'message',
      body,
      ts: 1000,
    }),
  );
}

/** Enroll the joiner at the hub through the real ceremony, so node.json holds a live credential. */
async function enrollJoiner() {
  const { json: minted } = await post(
    hubBase,
    '/teams/bravo/nodes/invite',
    { label: 'joiner laptop' },
    nickCredential,
  );
  const res = await post(joinerBase, '/node/enroll', {
    hub_url: hubBase,
    code: minted.invite,
    team: 'bravo',
  });
  expect(res.status).toBe(200);
}

/**
 * Run `fn` and collect the daemon's log lines, so a test can assert what an OPERATOR would see
 * rather than only what the caller catches (ADR 335 §7 decision 7). MUSTERD_SILENT is lifted for
 * the call because the visibility of the line IS the property under test.
 */
async function captureLogs(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const record = (chunk: unknown): boolean => {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // not one of ours
      }
    }
    return true;
  };
  const silent = process.env['MUSTERD_SILENT'];
  const [outWrite, errWrite] = [process.stdout.write, process.stderr.write];
  delete process.env['MUSTERD_SILENT'];
  process.stdout.write = record as typeof process.stdout.write;
  process.stderr.write = record as typeof process.stderr.write;
  try {
    await fn().catch(() => undefined);
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (silent !== undefined) process.env['MUSTERD_SILENT'] = silent;
  }
  return lines;
}

const joinerTeam = () => getTeamBySlug(joiner.db, 'bravo')!;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-push-'));
  process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');

  hub = createServer({ db: openDb(':memory:'), port: 0 });
  hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
  joiner = createServer({ db: openDb(':memory:'), port: 0 });
  joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;
  joinerCtx = { db: joiner.db, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };

  // The same team on both daemons — roster identity replicates via git (ADR 058), so this is what
  // two machines hosting one team actually look like.
  const created = await post(hubBase, '/teams', {
    slug: 'bravo',
    creator: { name: 'nick', kind: 'human' },
  });
  nickCredential = created.json.human_credential;
  await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } });
});

afterEach(async () => {
  await hub.close();
  await joiner.close();
  delete process.env['MUSTERD_NODE_STATE'];
  rmSync(dir, { recursive: true, force: true });
});

async function get(base: string, path: string, auth?: string) {
  const response = await fetch(base + path, {
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
}
const joinerCredential = () => readNodeState().nodes['bravo']!.credential;

describe('GET /sync/pull', () => {
  it('refuses without a machine credential', async () => {
    expect((await get(hubBase, '/teams/bravo/sync/pull?after=0')).status).toBe(401);
    expect((await get(hubBase, '/teams/bravo/sync/pull?after=0', nickCredential)).status).toBe(401);
  });

  it('pages the canonical order after a hub_seq, bounded, with the head', async () => {
    send(joiner, 'j-1');
    await enrollJoiner();
    send(joiner, 'j-2');
    send(joiner, 'j-3');
    await pushTeam(joinerCtx, joinerTeam());
    const page = await get(hubBase, '/teams/bravo/sync/pull?after=1&limit=1', joinerCredential());
    expect(page.status).toBe(200);
    expect(page.json.hub_seq_high).toBe(3);
    expect(page.json.events).toHaveLength(1);
    expect(page.json.events[0]).toMatchObject({ hub_seq: 2, origin_seq: 2 });
    expect(page.json.events[0].envelope.id).toBe('j-2');
  });

  it('answers 409 with the head when asked to resume past it', async () => {
    send(joiner, 'j-1');
    await enrollJoiner();
    await pushTeam(joinerCtx, joinerTeam());
    const res = await get(hubBase, '/teams/bravo/sync/pull?after=5', joinerCredential());
    expect(res.status).toBe(409);
    expect(res.json.hub_seq_high).toBe(1);
  });
});

const hubCtx = () => ({ db: hub.db, hub: new Hub(), config: resolveConfig(), rosterRoots: [] });
const hubTeam = () => getTeamBySlug(hub.db, 'bravo')!;
const originsIn = (db: Database, teamId: string) =>
  db
    .prepare<
      [string],
      { id: string; origin_seq: number }
    >('SELECT id, origin_seq FROM messages WHERE team_id = ? ORDER BY origin_node, origin_seq')
    .all(teamId);
/** A seat that exists on one daemon only — roster lag, the ordinary case the fold blocks on. */
const addSeat = (server: RunningServer, name: string) =>
  addMember(server.db, getTeamBySlug(server.db, 'bravo')!, { name, kind: 'agent' }).row;

describe('the pull loop', () => {
  it('the hub folds joiner events into its own messages from its own sync_log', async () => {
    send(joiner, 'j-1');
    await enrollJoiner();
    send(joiner, 'j-2');
    await pushTeam(joinerCtx, joinerTeam());
    expect(await pullTeam(hubCtx(), hubTeam())).toBe(2);
    expect(
      hub.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id IN (?, ?)').get('j-1', 'j-2'),
    ).toEqual({ n: 2 });
    // Second pass: nothing new.
    expect(await pullTeam(hubCtx(), hubTeam())).toBe(0);
  });

  it("a joiner receives the hub's own history AND its own events back, stamps verbatim, ids local", async () => {
    send(hub, 'h-1');
    send(joiner, 'j-1');
    await enrollJoiner();
    // Hub stages its own history (loopback) and ingests the joiner's push.
    await pushTeam(joinerCtx, joinerTeam());
    await pushTeam(hubCtx(), hubTeam());
    // Joiner pulls: gets h-1 (foreign to it) and j-1 (its own — skipped, rule 1).
    expect(await pullTeam(joinerCtx, joinerTeam())).toBe(1);
    const h1 = joiner.db
      .prepare<
        [string],
        { from_member: string; origin_node: string; origin_seq: number }
      >('SELECT from_member, origin_node, origin_seq FROM messages WHERE id = ?')
      .get('h-1')!;
    const hubLocal = hub.db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(hubTeam().id)!.node_id;
    expect(h1.origin_node).toBe(hubLocal);
    expect(h1.origin_seq).toBe(1);
    const joinerNick = joiner.db
      .prepare<
        [string, string],
        { id: string }
      >('SELECT id FROM members WHERE team_id = ? AND name = ?')
      .get(joinerTeam().id, 'nick')!.id;
    expect(h1.from_member).toBe(joinerNick);
    // And the joiner's own row is still the one insertMessage wrote — not a second copy.
    expect(originsIn(joiner.db, joinerTeam().id).filter((r) => r.id === 'j-1')).toHaveLength(1);
  });

  it('logs the blocker at error, once per seat, and resumes after the roster catches up', async () => {
    send(joiner, 'j-0');
    await enrollJoiner();
    const late = addSeat(joiner, 'late');
    insertMessage(
      joiner.db,
      joinerTeam().id,
      late.id,
      null,
      makeEnvelope({
        id: 'l-1',
        team: 'bravo',
        from: 'late',
        to: { kind: 'team' },
        act: 'message',
        body: 'hi',
        ts: 1,
      }),
    );
    await pushTeam(joinerCtx, joinerTeam());

    const lines = await captureLogs(() => pullTeam(hubCtx(), hubTeam()));
    const blocked = lines.filter((l) => l['msg'] === 'sync_fold_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ level: 'error', seat: 'late' });
    // j-0 (before the blocker) applied; l-1 did not.
    expect(hub.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get('l-1')).toEqual({
      n: 0,
    });
    // Same blocker again: no second error line.
    const again = await captureLogs(() => pullTeam(hubCtx(), hubTeam()));
    expect(again.filter((l) => l['msg'] === 'sync_fold_blocked')).toHaveLength(0);

    addSeat(hub, 'late');
    expect(await pullTeam(hubCtx(), hubTeam())).toBe(1);
  });

  /**
   * dolly's #1155 F1. The fold classifies an act this build cannot name (`unknown_act`: "upgrade
   * this daemon", valid prefix applied, retried each tick). But over the WIRE that stop was
   * unreachable: the hub re-parsed its own page with an `Act`-enum schema, so one poisoned row made
   * `GET /sync/pull` answer 500 with a raw ZodError to every puller, which logged `sync_pull_failed`
   * (indistinguishable from offline) and applied nothing — not even the rows before it. The
   * loopback feeder skipped the parse and reached the stop, so the two feeders diverged on the
   * same log. The wire now carries what the log holds; both feeders converge on the fold's stop.
   */
  it('an act this build cannot name reaches the fold over the wire — prefix applied, stop classified, no 500', async () => {
    send(hub, 'h-1');
    send(hub, 'h-2');
    send(hub, 'h-3');
    send(joiner, 'j-1'); // the joiner needs a node row before it can enroll
    await enrollJoiner();
    await pushTeam(hubCtx(), hubTeam()); // hub stages its own history
    // A hub on a newer build staged h-2 with an act this puller's ActSchema does not hold.
    hub.db
      .prepare(
        "UPDATE sync_log SET payload = json_set(payload, '$.envelope.act', 'frobnicate') WHERE team_id = ? AND json_extract(payload, '$.envelope.id') = 'h-2'",
      )
      .run(hubTeam().id);

    const lines = await captureLogs(() => pullTeam(joinerCtx, joinerTeam()));
    const unknown = lines.filter((l) => l['msg'] === 'sync_fold_unknown_act');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ level: 'error', act: 'frobnicate' });
    // The prefix before the blocker landed; the blocker and what follows did not.
    const held = (id: string) =>
      (
        joiner.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(id) as {
          n: number;
        }
      ).n;
    expect(held('h-1')).toBe(1);
    expect(held('h-2')).toBe(0);
    expect(held('h-3')).toBe(0);
    // Same stop next tick: no second line, and still not a transport failure.
    const again = await captureLogs(() => pullTeam(joinerCtx, joinerTeam()));
    expect(again.filter((l) => l['msg'] === 'sync_fold_unknown_act')).toHaveLength(0);
    // Once "upgraded" — the staged act is one this build knows — the fold resumes past it.
    hub.db
      .prepare(
        "UPDATE sync_log SET payload = json_set(payload, '$.envelope.act', 'message') WHERE team_id = ? AND json_extract(payload, '$.envelope.id') = 'h-2'",
      )
      .run(hubTeam().id);
    expect(await pullTeam(joinerCtx, joinerTeam())).toBe(2);
  });

  it('a puller refuses a hub head below its own cursor as impossible', async () => {
    send(joiner, 'j-0');
    await enrollJoiner();
    // Pretend the joiner has applied further than the hub has ever held.
    joiner.db
      .prepare('INSERT INTO sync_pull_cursor (team_id, last_hub_seq, updated_at) VALUES (?, 99, 1)')
      .run(joinerTeam().id);
    const lines = await captureLogs(() => pullTeam(joinerCtx, joinerTeam()));
    expect(lines.some((l) => l['msg'] === 'sync_pull_impossible_resume')).toBe(true);
    await expect(pullTeam(joinerCtx, joinerTeam())).rejects.toThrow(/impossible/);
  });

  it('does nothing on a single-machine install', async () => {
    send(hub, 'h-1');
    expect(await pullTeam(hubCtx(), hubTeam())).toBe(0);
    expect(foldBatch(hub.db, hubTeam().id, [])).toMatchObject({
      applied: 0,
      skipped: 0,
      last_hub_seq: 0,
      stop: null,
    });
  });
});
