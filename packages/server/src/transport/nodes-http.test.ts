import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * The node enrollment routes (ADR 328), increment 3a of the ADR 325 federation build.
 *
 * Two properties these tests exist to hold. `join` is authenticated by the invite code and nothing
 * else — that IS the ceremony (§2), so it must work unauthenticated and still refuse a spent code.
 * And an `msnode_` admits its bearer to the sync surface only (§3): a machine being *admitted* and
 * a seat being *authorized* are independent axes, and collapsing them would make one laptop's
 * compromise a licence to mint teammates.
 */

let server: RunningServer;
let base: string;
let nickCredential: string;
let adaKey: string;

type Auth = string | { key: string; seat: string };

function headers(auth?: Auth): Record<string, string> {
  if (!auth) return {};
  if (typeof auth === 'string') return { authorization: `Bearer ${auth}` };
  return { authorization: `Bearer ${auth.key}`, 'x-musterd-seat': auth.seat };
}

async function request(method: string, path: string, body?: unknown, auth?: Auth) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers(auth) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
}

/** An admin-minted invite, the way an operator gets one. */
async function invite(label = 'joiner laptop'): Promise<string> {
  const res = await request('POST', '/teams/bravo/nodes/invite', { label }, nickCredential);
  expect(res.status).toBe(200);
  return res.json.invite;
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;

  const created = await request('POST', '/teams', {
    slug: 'bravo',
    creator: { name: 'nick', kind: 'human' },
  });
  nickCredential = created.json.human_credential;
  adaKey = created.json.agent_key;
  await request('POST', '/teams/bravo/members', { name: 'ada', kind: 'agent' }, nickCredential);
});

afterEach(async () => {
  await server.close();
});

describe('node enrollment routes (ADR 328)', () => {
  it('mints an invite for an admin, and a joiner trades it for a credential', async () => {
    const code = await invite();
    expect(code).toMatch(/^msinv_/);

    const joined = await request('POST', '/teams/bravo/nodes/join', {
      code,
      node_id: 'node-remote',
      label: 'joiner laptop',
    });

    expect(joined.status).toBe(200);
    expect(joined.json.node_credential).toMatch(/^msnode_/);
    expect(joined.json.node_id).toBe('node-remote');
    expect(joined.json.team).toBe('bravo');
  });

  it('join needs no seat credential — the code is the whole ceremony (§2)', async () => {
    const code = await invite();
    // No authorization header at all.
    const joined = await request('POST', '/teams/bravo/nodes/join', {
      code,
      node_id: 'node-remote',
      label: 'laptop',
    });
    expect(joined.status).toBe(200);
  });

  it('two daemons racing one invite: exactly one is admitted', async () => {
    const code = await invite();

    const [a, b] = await Promise.all([
      request('POST', '/teams/bravo/nodes/join', { code, node_id: 'node-a', label: 'a' }),
      request('POST', '/teams/bravo/nodes/join', { code, node_id: 'node-b', label: 'b' }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    // And only the winner got a row.
    const rows = server.db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM nodes WHERE id IN ('node-a','node-b') AND credential_hash IS NOT NULL")
      .get();
    expect(rows?.n).toBe(1);
  });

  it('refuses a spent code, an unknown code, and a node id already bound', async () => {
    const first = await invite();
    await request('POST', '/teams/bravo/nodes/join', {
      code: first,
      node_id: 'node-remote',
      label: 'laptop',
    });

    expect(
      (
        await request('POST', '/teams/bravo/nodes/join', {
          code: first,
          node_id: 'node-other',
          label: 'l',
        })
      ).status,
    ).toBe(409);

    expect(
      (
        await request('POST', '/teams/bravo/nodes/join', {
          code: 'msinv_nope',
          node_id: 'node-other',
          label: 'l',
        })
      ).status,
    ).toBe(409);

    // A fresh code cannot re-bind an id that already carries a credential (the ADR 331 refusal).
    const second = await invite();
    expect(
      (
        await request('POST', '/teams/bravo/nodes/join', {
          code: second,
          node_id: 'node-remote',
          label: 'l',
        })
      ).status,
    ).toBe(409);
  });

  it('a refused bind does not burn the invite — the code survives to be retried', async () => {
    // Take an id, then try to enroll a SECOND machine onto it with a fresh code. The bind is
    // refused, and the operator's still-unspent code must survive: consume-and-bind is one
    // transaction, so a rolled-back bind rolls the consumption back with it. Without that, a
    // fat-fingered node id would silently cost the operator an invite and they would have to mint
    // another to find out why.
    const first = await invite();
    await request('POST', '/teams/bravo/nodes/join', {
      code: first,
      node_id: 'node-taken',
      label: 'first',
    });

    const code = await invite();
    expect(
      (
        await request('POST', '/teams/bravo/nodes/join', {
          code,
          node_id: 'node-taken',
          label: 'second',
        })
      ).status,
    ).toBe(409);

    // Same code, a free id: it still works.
    const retry = await request('POST', '/teams/bravo/nodes/join', {
      code,
      node_id: 'node-free',
      label: 'second',
    });
    expect(retry.status).toBe(200);
    expect(retry.json.node_id).toBe('node-free');
  });

  it("refuses a joiner presenting the hub's own node id", async () => {
    // Make the hub mint its own local row the way a live daemon does — by writing to its log.
    const team = getTeamBySlug(server.db, 'bravo')!;
    const nick = server.db
      .prepare<[string], { id: string }>('SELECT id FROM members WHERE team_id = ? AND name = ?')
      .get(team.id, 'nick')!;
    insertMessage(
      server.db,
      team.id,
      nick.id,
      null,
      makeEnvelope({
        id: 'm-1',
        team: 'bravo',
        from: 'nick',
        to: { kind: 'team' as const },
        act: 'message',
        body: 'hi',
        ts: 1000,
        meta: null,
      }),
    );
    const ours = server.db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(team.id)!.node_id;

    const code = await invite();
    const res = await request('POST', '/teams/bravo/nodes/join', {
      code,
      node_id: ours,
      label: 'impostor',
    });
    expect(res.status).toBe(409);
  });

  it('an msnode_ cannot act as a seat (§3) — admitted is not authorized', async () => {
    const code = await invite();
    const { json } = await request('POST', '/teams/bravo/nodes/join', {
      code,
      node_id: 'node-remote',
      label: 'laptop',
    });
    const nodeCredential = json.node_credential;

    // It is not a seat credential: it cannot speak, read the roster's authority detail, or claim.
    expect(
      (
        await request(
          'POST',
          '/teams/bravo/messages',
          { act: 'message', body: 'I am a machine pretending to be a teammate' },
          nodeCredential,
        )
      ).status,
    ).toBe(401);
    expect((await request('GET', '/teams/bravo/inbox', undefined, nodeCredential)).status).toBe(
      401,
    );
  });

  it('invite, rotate, revoke and list are admin-only', async () => {
    const paths: [string, string][] = [
      ['POST', '/teams/bravo/nodes/invite'],
      ['POST', '/teams/bravo/nodes/node-remote/rotate'],
      ['POST', '/teams/bravo/nodes/node-remote/revoke'],
      ['GET', '/teams/bravo/nodes'],
    ];

    for (const [method, path] of paths) {
      // No credential at all.
      expect((await request(method, path)).status, `${method} ${path} unauthenticated`).toBe(401);
      // A genuinely AUTHENTICATED non-admin seat — ada, an ordinary agent. The seat header matters:
      // a bare agent key resolves to no member and 401s on every route, which would make this
      // assertion pass without ever exercising the admin gate.
      const res = await request(method, path, undefined, { key: adaKey, seat: 'ada' });
      expect(res.status, `${method} ${path} as non-admin seat`).toBe(403);
    }
  });

  it('rotation retires the old credential and keeps the node id', async () => {
    const code = await invite();
    const joined = await request('POST', '/teams/bravo/nodes/join', {
      code,
      node_id: 'node-remote',
      label: 'laptop',
    });
    const old = joined.json.node_credential;

    const rotated = await request(
      'POST',
      '/teams/bravo/nodes/node-remote/rotate',
      undefined,
      nickCredential,
    );
    expect(rotated.status).toBe(200);
    expect(rotated.json.node_credential).toMatch(/^msnode_/);
    expect(rotated.json.node_credential).not.toBe(old);

    const team = getTeamBySlug(server.db, 'bravo')!;
    const row = server.db
      .prepare<[string], { id: string }>('SELECT id FROM nodes WHERE team_id = ? AND id = ?')
      .get(team.id, 'node-remote');
    expect(row?.id).toBe('node-remote');
  });

  it('revocation is recorded, and a second revoke reports that it changed nothing', async () => {
    const code = await invite();
    await request('POST', '/teams/bravo/nodes/join', {
      code,
      node_id: 'node-remote',
      label: 'laptop',
    });

    const first = await request(
      'POST',
      '/teams/bravo/nodes/node-remote/revoke',
      undefined,
      nickCredential,
    );
    expect(first.status).toBe(200);
    expect(first.json.revoked).toBe(true);

    const second = await request(
      'POST',
      '/teams/bravo/nodes/node-remote/revoke',
      undefined,
      nickCredential,
    );
    expect(second.json.revoked).toBe(false);

    // A revoked node cannot be rotated back into service.
    expect(
      (await request('POST', '/teams/bravo/nodes/node-remote/rotate', undefined, nickCredential))
        .status,
    ).toBe(409);
  });

  it('the listing names nodes without handing over any part of a secret', async () => {
    const code = await invite();
    const joined = await request('POST', '/teams/bravo/nodes/join', {
      code,
      node_id: 'node-remote',
      label: 'laptop',
    });
    const secret = joined.json.node_credential;

    const listed = await request('GET', '/teams/bravo/nodes', undefined, nickCredential);
    expect(listed.status).toBe(200);

    const body = JSON.stringify(listed.json);
    expect(body).not.toContain(secret);
    expect(body).not.toContain('credential_hash');
    const remote = listed.json.nodes.find((n: any) => n.id === 'node-remote');
    expect(remote.credential_prefix).toBe('msnode_');
    expect(remote.label).toBe('laptop');
  });
});
