import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState, saveNodeEnrollment } from '../node/state.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { pushTeam } from './push.js';

/**
 * The daemon-side push loop (ADR 325 increment 3b-i), exercised between two real daemons.
 *
 * The property that matters is the cursor's: it advances only past a batch the hub ACKED. A cursor
 * that moved on send would turn every unreachable hub into permanent silent loss — the pusher would
 * believe it had delivered events that never arrived, and nothing downstream could tell that from a
 * team that simply said nothing. Offline is the expected state here, not the exceptional one.
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

/** A hub that answers every push with one canned status+body — for the paths a real hub cannot reach. */
function createHubStub(status: number, body: unknown) {
  const server = createHttpServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
    });
  });
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const joinerTeam = () => getTeamBySlug(joiner.db, 'bravo')!;
const stagedOnHub = () => hub.db.prepare('SELECT COUNT(*) AS n FROM sync_log').get();
const cursor = () =>
  joiner.db
    .prepare<
      [string],
      { last_seq: number }
    >('SELECT last_seq FROM sync_push_cursor WHERE team_id = ?')
    .get(joinerTeam().id)?.last_seq ?? 0;

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

describe('the push loop', () => {
  it("pushes this node's unpushed messages and advances the cursor", async () => {
    send(joiner, 'm-1');
    send(joiner, 'm-2');
    await enrollJoiner();

    expect(await pushTeam(joinerCtx, joinerTeam())).toBe(2);

    expect(stagedOnHub()).toEqual({ n: 2 });
    expect(cursor()).toBe(2);
    // The wire carries the seat NAME, never `from_member`: a daemon-private id would dangle on the
    // receiver, or resolve to a DIFFERENT seat holding that id there (ADR 325).
    const staged = hub.db
      .prepare<[], { payload: string }>('SELECT payload FROM sync_log ORDER BY hub_seq')
      .all();
    expect(JSON.parse(staged[0]!.payload).envelope.from).toBe('nick');
    expect(staged[0]!.payload).not.toContain('from_member');
  });

  it('advances the cursor only past an ACKED batch', async () => {
    send(joiner, 'm-1');
    await enrollJoiner();
    // Repoint the enrollment at a port nothing is listening on: the hub is unreachable, which is
    // an ordinary Tuesday for a laptop, not a fault.
    const enrolled = readNodeState().nodes['bravo']!;
    saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: 'http://127.0.0.1:1' });

    // The pass surfaces the failure rather than swallowing it — the loop is what treats offline as
    // expected (`sync_push_failed`, retry next tick), which is the shape seeds/ingest.ts uses. A
    // pass that returned 0 here would make a permanently misconfigured hub_url indistinguishable
    // from having nothing to send.
    await expect(pushTeam(joinerCtx, joinerTeam())).rejects.toThrow();

    // And the important half: a cursor that moved on SEND rather than on ACK would make this
    // permanent silent loss. It did not move, so the next tick resends.
    expect(cursor()).toBe(0);
    expect(stagedOnHub()).toEqual({ n: 0 });
  });

  it('re-sends after a lost ack without duplicating on the hub', async () => {
    send(joiner, 'm-1');
    await enrollJoiner();
    await pushTeam(joinerCtx, joinerTeam());
    expect(stagedOnHub()).toEqual({ n: 1 });

    // The ack was lost in flight: the hub holds the event, the pusher does not know it. Rewinding
    // the cursor is exactly what that looks like on the next tick.
    joiner.db.prepare('UPDATE sync_push_cursor SET last_seq = 0').run();
    const accepted = await pushTeam(joinerCtx, joinerTeam());

    // Idempotence end to end: the hub acks without staging a second copy, and the cursor recovers.
    expect(accepted).toBe(0);
    expect(stagedOnHub()).toEqual({ n: 1 });
    expect(cursor()).toBe(1);
  });

  it('refuses a resume point ahead of anything this node has ever minted', async () => {
    send(joiner, 'm-1');
    send(joiner, 'm-2');
    send(joiner, 'm-3');
    await enrollJoiner();

    // A hub answering with a seq we never minted is asserting something impossible, not correcting
    // us. dolly, 2026-08-28 (#1102 required B): validated only as an integer >= 1, expected_seq
    // 1000000 drove the cursor to 999999 and every later pass sent nothing — the silent loss the
    // cursor exists to prevent, reintroduced through the one number the hub gets to dictate.
    const enrolled = readNodeState().nodes['bravo']!;
    const stub = createHubStub(409, {
      error: { code: 'conflict', message: 'gap' },
      expected_seq: 1000000,
    });
    saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: await stub.url });

    await expect(pushTeam(joinerCtx, joinerTeam())).rejects.toThrow(/impossible|ahead/i);

    // The cursor did not move, so the three messages are still queued for a hub that tells the truth.
    expect(cursor()).toBe(0);
    await stub.close();
  });

  it('accepts a resume point at or below this node\u2019s head', async () => {
    send(joiner, 'm-1');
    send(joiner, 'm-2');
    await enrollJoiner();

    // head + 1 EXACTLY — the boundary, and the case a too-tight clamp would break: the hub holds
    // everything we have minted (1 and 2) and asks for the next seq we have not written yet. Tested
    // at the boundary on purpose; asserting at `head` would pass under an off-by-one clamp too.
    const enrolled = readNodeState().nodes['bravo']!;
    const stub = createHubStub(409, {
      error: { code: 'conflict', message: 'gap' },
      expected_seq: 3,
    });
    saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: await stub.url });

    expect(await pushTeam(joinerCtx, joinerTeam())).toBe(0);
    expect(cursor()).toBe(2);
    await stub.close();
  });

  it('reports a terminal refusal at error rather than retrying it as if offline', async () => {
    send(joiner, 'm-1');
    await enrollJoiner();
    // A 422 is a batch the hub will never accept. The loop's every other answer is "retry next
    // tick", which here means resending a poison batch forever behind a line that reads as offline.
    const stub = createHubStub(422, {
      error: { code: 'validation', message: 'duplicate id' },
      event_id: 'm-1',
      terminal: true,
    });
    const enrolled = readNodeState().nodes['bravo']!;
    saveNodeEnrollment({ team: 'bravo', ...enrolled, hub_url: await stub.url });

    await expect(pushTeam(joinerCtx, joinerTeam())).rejects.toThrow(/permanently refused/i);
    expect(cursor()).toBe(0);
    await stub.close();
  });

  it('does nothing for a team with no enrollment', async () => {
    send(joiner, 'm-1');

    // The single-machine case, which is every musterd install today: no node.json entry, so no
    // outbound call at all. Not an error — most teams are never federated.
    expect(await pushTeam(joinerCtx, joinerTeam())).toBe(0);
    expect(cursor()).toBe(0);
    expect(stagedOnHub()).toEqual({ n: 0 });
  });

  it('does nothing when the daemon has never sent for the team', async () => {
    await post(joinerBase, '/teams', { slug: 'quiet', creator: { name: 'nick', kind: 'human' } });
    // Enrolled, but with no local row — node.json is keyed by SLUG while the db keys by team_id, so
    // a renamed team, a restored database, or a hand-edited file all reach exactly this state.
    send(joiner, 'm-1');
    await enrollJoiner();
    const enrolled = readNodeState().nodes['bravo']!;
    saveNodeEnrollment({ team: 'quiet', ...enrolled });

    // No local_node row: this daemon has stamped no origin, so it has nothing of its own to push
    // and must not mint an identity just to discover that. Reading `local_node` is what keeps that
    // true — the minting path (insertMessage's localNodeForTeam) would create a row and a marker.
    const quiet = getTeamBySlug(joiner.db, 'quiet')!;
    expect(await pushTeam(joinerCtx, quiet)).toBe(0);

    const rows = (t: string) =>
      joiner.db
        .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE team_id = ?`)
        .get(quiet.id)!.n;
    expect(rows('nodes')).toBe(0);
    expect(rows('local_node')).toBe(0);
  });

  it('pushes only this node’s own events, never a peer’s', async () => {
    send(joiner, 'm-1');
    await enrollJoiner();
    // A foreign origin sitting in the local log — what 3b-ii's fold will one day put there. This
    // node may push only its own events, so the batch must not sweep it up.
    const team = joinerTeam();
    joiner.db
      .prepare('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)')
      .run('node-peer', team.id, 'peer');
    joiner.db
      .prepare(
        `INSERT INTO messages (id, team_id, from_member, to_kind, act, body, ts, created_at,
                               origin_node, origin_seq)
         SELECT 'm-peer', team_id, from_member, to_kind, act, body, 2000, 2000, 'node-peer', 1
           FROM messages LIMIT 1`,
      )
      .run();

    expect(await pushTeam(joinerCtx, team)).toBe(1);

    const origins = hub.db
      .prepare<[], { origin_node: string }>('SELECT DISTINCT origin_node FROM sync_log')
      .all();
    expect(origins).toHaveLength(1);
    expect(origins[0]!.origin_node).not.toBe('node-peer');
  });
});
