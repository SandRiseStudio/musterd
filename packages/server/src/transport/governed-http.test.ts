import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { bindNode, bindSeatToNode } from '../store/nodes.js';
import { attach } from '../store/presence.js';
import { getTeamBySlug } from '../store/teams.js';

let server: RunningServer;
let base: string;
let nickCredential: string;

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const created = await request('POST', '/teams', {
    slug: 'governed',
    creator: { name: 'nick', kind: 'human' },
  });
  nickCredential = created.json.human_credential;
  await request(
    'POST',
    '/teams/governed/members',
    { name: 'ada', kind: 'agent' },
    bearer(nickCredential),
  );

  const team = getTeamBySlug(server.db, 'governed')!;
  const ada = getMemberByName(server.db, team.id, 'ada')!;
  bindNode(server.db, team.id, 'node-a', 'laptop', 'msnode_node-a', 'nick', 10);
  bindSeatToNode(server.db, team.id, ada.id, 'node-a', 11);
});

afterEach(async () => {
  await server.close();
});

describe('governed authorization HTTP routes (ADR 410)', () => {
  it('syncs policy, issues a human-started handoff, consumes it, and authorizes a request', async () => {
    const policy = {
      version: 1,
      team: { models: ['anthropic/claude-sonnet-4-6'] },
      members: { ada: { models: ['anthropic/claude-sonnet-4-6'] } },
    };
    expect(
      (await request('POST', '/teams/governed/governed/policy', policy, bearer(nickCredential)))
        .status,
    ).toBe(200);
    const issued = await request(
      'POST',
      '/teams/governed/governed/launches',
      {
        member: 'ada',
        node_id: 'node-a',
        correlation: 'corr-http',
        context: { kind: 'orientation', allowance_id: 'allow-http' },
      },
      bearer(nickCredential),
    );
    expect(issued.status).toBe(201);
    expect(issued.json.token).toMatch(/^msla_/);

    const team = getTeamBySlug(server.db, 'governed')!;
    const ada = getMemberByName(server.db, team.id, 'ada')!;
    const presence = attach(server.db, ada.id, 'claude-code', 'conn-1');
    const consumed = await request(
      'POST',
      '/teams/governed/governed/launches/consume',
      {
        token: issued.json.token,
        launch_id: issued.json.authorization.id,
        presence_id: presence.id,
        member: 'ada',
        node_id: 'node-a',
        correlation: 'corr-http',
      },
      bearer('msnode_node-a'),
    );
    expect(consumed.status).toBe(200);
    expect(consumed.json.decision).toBe('allow');

    const authorized = await request(
      'POST',
      '/teams/governed/governed/authorize',
      {
        launch_id: issued.json.authorization.id,
        presence_id: presence.id,
        correlation: 'corr-http',
        member: 'ada',
        node_id: 'node-a',
        provider: 'anthropic',
        model: 'anthropic/claude-sonnet-4-6',
      },
      bearer('msnode_node-a'),
    );
    expect(authorized).toMatchObject({
      status: 200,
      json: { decision: 'allow', reason: 'allowed' },
    });
    const auditDetails = server.db
      .prepare<[], { detail: string | null }>('SELECT detail FROM audit')
      .all();
    expect(JSON.stringify(auditDetails)).not.toContain(issued.json.token);
  });

  it('returns a structured denial for a node-bound identity mismatch', async () => {
    const issue = await request(
      'POST',
      '/teams/governed/governed/launches',
      {
        member: 'ada',
        node_id: 'node-a',
        correlation: 'corr-http',
        context: { kind: 'orientation', allowance_id: 'allow-http' },
      },
      bearer(nickCredential),
    );
    const team = getTeamBySlug(server.db, 'governed')!;
    const ada = getMemberByName(server.db, team.id, 'ada')!;
    const presence = attach(server.db, ada.id, 'claude-code', 'conn-1');
    await request(
      'POST',
      '/teams/governed/governed/launches/consume',
      {
        token: issue.json.token,
        launch_id: issue.json.authorization.id,
        presence_id: presence.id,
        member: 'ada',
        node_id: 'node-a',
        correlation: 'corr-http',
      },
      bearer('msnode_node-a'),
    );
    const denied = await request(
      'POST',
      '/teams/governed/governed/authorize',
      {
        launch_id: issue.json.authorization.id,
        presence_id: presence.id,
        correlation: 'corr-http',
        member: 'ada',
        node_id: 'node-other',
        provider: 'anthropic',
        model: 'anthropic/claude-sonnet-4-6',
      },
      bearer('msnode_node-a'),
    );
    expect(denied).toMatchObject({
      status: 200,
      json: { decision: 'deny', reason: 'denied_node_binding' },
    });
  });
});
