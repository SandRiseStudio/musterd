import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState } from '../node/state.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * `POST /node/enroll` (ADR 328 §2) — the local half of enrollment, and the first place in this
 * build where two daemons actually talk.
 *
 * The joiner's daemon holds the v47 `nodes` row whose id must be presented, and it is what will
 * hold the credential, so it makes the call to the hub and writes `node.json` itself. The CLI only
 * asks. This test stands up a real hub and a real joiner on two ports to exercise that.
 */

let hub: RunningServer;
let joiner: RunningServer;
let hubBase: string;
let joinerBase: string;
let nickCredential: string;
let joinerCredential: string;
let dir: string;

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

/** Give a daemon its own local node row for the team, the way a live one gets it — by writing. */
function mintLocalRow(server: RunningServer, slug: string, id: string) {
  const team = getTeamBySlug(server.db, slug)!;
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
      team: slug,
      from: 'nick',
      to: { kind: 'team' as const },
      act: 'message',
      body: 'hi',
      ts: 1000,
      meta: null,
    }),
  );
  return server.db
    .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
    .get(team.id)!.node_id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-enroll-'));
  process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');

  hub = createServer({ db: openDb(':memory:'), port: 0 });
  hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
  joiner = createServer({ db: openDb(':memory:'), port: 0 });
  joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;

  // The same team exists on both daemons — roster identity replicates via git (ADR 058), so this
  // is what two machines hosting one team actually look like.
  const created = await post(hubBase, '/teams', {
    slug: 'bravo',
    creator: { name: 'nick', kind: 'human' },
  });
  nickCredential = created.json.human_credential;
  joinerCredential = (
    await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
  ).json.human_credential;
});

afterEach(async () => {
  await hub.close();
  await joiner.close();
  delete process.env['MUSTERD_NODE_STATE'];
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /node/enroll — the joiner daemon enrolls itself at a hub', () => {
  it('presents its OWN node id and writes the credential to node.json', async () => {
    const joinerNodeId = mintLocalRow(joiner, 'bravo', 'm-joiner');
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
    // The id the hub bound is the one the joiner already had — no second identity was minted, which
    // is the whole of ADR 331 §Decision 1.
    expect(res.json.node_id).toBe(joinerNodeId);

    const saved = readNodeState().nodes['bravo'];
    expect(saved?.credential).toMatch(/^msnode_/);
    expect(saved?.node_id).toBe(joinerNodeId);
    expect(saved?.hub_url).toBe(hubBase);

    // And the hub now knows it, under the id the joiner presented.
    const hubTeam = getTeamBySlug(hub.db, 'bravo')!;
    const row = hub.db
      .prepare<
        [string, string],
        { label: string }
      >('SELECT label FROM nodes WHERE team_id = ? AND id = ? AND credential_hash IS NOT NULL')
      .get(hubTeam.id, joinerNodeId);
    expect(row).toBeDefined();
  });

  it('does not return the credential to the caller — it went to disk, not to the CLI', async () => {
    mintLocalRow(joiner, 'bravo', 'm-joiner');
    const { json: minted } = await post(
      hubBase,
      '/teams/bravo/nodes/invite',
      { label: 'laptop' },
      nickCredential,
    );

    const res = await post(joinerBase, '/node/enroll', {
      hub_url: hubBase,
      code: minted.invite,
      team: 'bravo',
    });

    expect(JSON.stringify(res.json)).not.toContain('msnode_');
    expect(readNodeState().nodes['bravo']?.credential).toMatch(/^msnode_/);
  });

  it("relays the hub's refusal rather than inventing success", async () => {
    mintLocalRow(joiner, 'bravo', 'm-joiner');

    const res = await post(joinerBase, '/node/enroll', {
      hub_url: hubBase,
      code: 'msinv_never-minted',
      team: 'bravo',
    });

    expect(res.status).toBe(409);
    // Nothing was written — a failed enrollment must not leave a half-credential behind.
    expect(readNodeState().nodes['bravo']).toBeUndefined();
  });

  it('refuses when this daemon has no node row for the team yet', async () => {
    // No mintLocalRow: the joiner has the team but has never written to its own log.
    const { json: minted } = await post(
      hubBase,
      '/teams/bravo/nodes/invite',
      { label: 'laptop' },
      nickCredential,
    );

    const res = await post(joinerBase, '/node/enroll', {
      hub_url: hubBase,
      code: minted.invite,
      team: 'bravo',
    });

    expect(res.status).toBe(409);
  });

  it('refuses an off-machine caller — enrolling this machine is not remotely initiable', async () => {
    // `trustProxy` is how the suite models a non-local peer while still binding on loopback (the
    // pattern integration.test.ts and secured-bind.test.ts use for the same ADR 040 predicate).
    // Without this case the localhost gate is untested: every other request here comes from
    // 127.0.0.1, so deleting the gate entirely would leave the suite green.
    const proxied = createServer({ db: openDb(':memory:'), port: 0, trustProxy: true });
    const proxiedBase = `http://127.0.0.1:${(await proxied.listen()).port}`;
    await post(proxiedBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } });
    mintLocalRow(proxied, 'bravo', 'm-proxied');

    try {
      const res = await post(proxiedBase, '/node/enroll', {
        hub_url: hubBase,
        code: 'msinv_abc',
        team: 'bravo',
      });
      expect(res.status).toBe(403);
      expect(readNodeState().nodes['bravo']).toBeUndefined();
    } finally {
      await proxied.close();
    }
  });

  it('rejects a hub_url that is not a url before any secret leaves the machine', async () => {
    mintLocalRow(joiner, 'bravo', 'm-joiner');
    const res = await post(joinerBase, '/node/enroll', {
      hub_url: 'hub.example',
      code: 'msinv_abc',
      team: 'bravo',
    });
    // 400 rather than 422: the daemon's own `parseOrBadRequest` maps a schema failure to
    // bad_request, and this route follows the convention every other body-parsing route uses.
    expect(res.status).toBe(400);
  });
});

describe('the hub is the machine the team was created on (ADR 376)', () => {
  async function enrolled() {
    mintLocalRow(joiner, 'bravo', 'm-joiner');
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

  it('an enrolled joiner cannot mint an invite — the refusal names the hub to mint from (§2)', async () => {
    await enrolled();
    // The joiner's own admin credential, minted when its copy of the team was created.
    const before = joiner.db.prepare('SELECT COUNT(*) AS n FROM node_invites').get() as {
      n: number;
    };
    const res = await post(
      joinerBase,
      '/teams/bravo/nodes/invite',
      { label: 'a third machine' },
      joinerCredential,
    );
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
    expect(res.json.error.message).toContain(hubBase);
    expect(joiner.db.prepare('SELECT COUNT(*) AS n FROM node_invites').get()).toEqual(before);
  });

  it('a hub cannot enroll — refused before any request leaves the machine (§3)', async () => {
    await enrolled();
    mintLocalRow(hub, 'bravo', 'm-hub');
    // Point the hub at a URL nothing listens on: if the refusal came AFTER the outbound call, this
    // would be a connection error, not a 409.
    const res = await post(hubBase, '/node/enroll', {
      hub_url: 'http://127.0.0.1:9',
      code: 'msinv_irrelevant',
      team: 'bravo',
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
    expect(res.json.error.message).toMatch(/is the hub/);
    expect(readNodeState().nodes['bravo']?.hub_url).toBe(hubBase); // the joiner's record, untouched
  });
});
