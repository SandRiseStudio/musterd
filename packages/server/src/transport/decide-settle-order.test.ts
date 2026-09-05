import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * ADR 343 decision 3, made enforceable (lane 01M1QA28RD). The admin decide route used to mint the
 * grant BEFORE settling the request, and the only thing preventing two admins from both minting was
 * the accidental absence of an `await` between the read and the settle. The safety now lives in the
 * ORDER: the `WHERE status = 'pending'` compare-and-set settles the request first, and a decision that
 * loses it mints nothing. These tests pin that order two ways — behaviorally on the live route, and
 * structurally on the handler's source, since a yield-injected interleaving is not reachable without a
 * seam in a handler that is synchronous after `readJson`.
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let nickCred: string;

async function post(path: string, body: unknown, cred?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cred ? { authorization: `Bearer ${cred}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

function grantCount(): number {
  const teamId = getTeamBySlug(server.db, 'dawn')!.id;
  return (
    server.db
      .prepare<[string], { n: number }>('SELECT count(*) AS n FROM grants WHERE team_id = ?')
      .get(teamId)?.n ?? 0
  );
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  agentKey = team.json.agent_key;
  nickCred = team.json.human_credential;
  await post('/teams/dawn/members', { name: 'Ada', kind: 'agent', role: 'backend' }, nickCred);
});

afterEach(async () => {
  await server.close();
});

async function openPending(): Promise<string> {
  const r = await post('/teams/dawn/claim', {
    key: agentKey,
    target: { seat: 'Ada' },
    surface: 'cli',
  });
  return r.json.request_id as string;
}

describe('decide settles before it mints (ADR 343 decision 3)', () => {
  it('two concurrent approvals of one request mint exactly one grant and settle it once', async () => {
    const id = await openPending();
    const before = grantCount();
    const [a, b] = await Promise.all([
      post(`/teams/dawn/requests/${id}/decide`, { decision: 'approve', lifetime: 'ttl' }, nickCred),
      post(`/teams/dawn/requests/${id}/decide`, { decision: 'approve', lifetime: 'ttl' }, nickCred),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(grantCount() - before).toBe(1);
    const teamId = getTeamBySlug(server.db, 'dawn')!.id;
    const decides = listAudit(server.db, teamId).filter(
      (row) => row.action === 'request.decide' && JSON.parse(row.detail ?? '{}').request_id === id,
    );
    expect(decides).toHaveLength(1);
  });

  it('an approval that loses the settle mints nothing — the 409 carries no grant', async () => {
    const id = await openPending();
    await post(`/teams/dawn/requests/${id}/decide`, { decision: 'deny' }, nickCred);
    const before = grantCount();
    const late = await post(
      `/teams/dawn/requests/${id}/decide`,
      { decision: 'approve', lifetime: 'standing' },
      nickCred,
    );
    expect(late.status).toBe(409);
    expect(late.json?.grant).toBeUndefined();
    expect(grantCount()).toBe(before);
  });

  it('in the handler source, every settle precedes the mint — the order is the guard, not the absence of a yield', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'http.ts'), 'utf8');
    const start = src.indexOf('rest.match(/^\\/requests\\/([^/]+)\\/decide$/)');
    expect(start).toBeGreaterThan(0);
    // The handler ends at the next route match after it.
    const end = src.indexOf('rest.match(', start + 1);
    const handler = src.slice(start, end);
    const mint = handler.indexOf('issueGrant(');
    const settle = handler.indexOf('decideRequest(');
    expect(mint).toBeGreaterThan(0);
    expect(settle).toBeGreaterThan(0);
    expect(settle).toBeLessThan(mint);
    // Exactly one settle on the approve side and one on the deny side; a second approve-side settle
    // would mean the mint had crept back between two of them.
    expect(handler.match(/decideRequest\(/g)).toHaveLength(2);
  });
});
