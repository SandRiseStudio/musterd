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
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
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
