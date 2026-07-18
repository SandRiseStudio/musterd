import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * Direct HTTP coverage for the ADR 150 enforcement foundation: the member-readable class table
 * (`GET /enforcement`) and the gate ingest (`POST /gate`). What's asserted is the foundation's
 * behavioral contract — member (not admin) read, the webhook never leaking through the scoped read,
 * the warn path proceeding with a `warned` audit outcome, the stubbed block path failing OPEN (never
 * wedging a seat), and the audit row being SHAPES ONLY (class + fingerprint, never the target text).
 */
let server: RunningServer;
let base: string;
let agentKey: string;
let nickCred: string;

function seatHeaders(seat: string): Record<string, string> {
  return { authorization: `Bearer ${agentKey}`, 'x-musterd-seat': seat };
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
const bearer = (auth: string) => ({ authorization: `Bearer ${auth}` });

const audits = (action: string) => {
  const team = getTeamBySlug(server.db, 'dawn')!;
  return listAudit(server.db, team.id).filter((r) => r.action === action);
};

const CLASSES = [
  { class: 'src/tariff.ts', kind: 'contended-surface', match: ['src/tariff.ts'], posture: 'warn' },
  { class: 'merge-to-main', kind: 'costly-action', match: ['gh pr merge*'], posture: 'warn' },
  { class: 'force-push', kind: 'costly-action', match: ['git push --force*'], posture: 'block' },
];

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  agentKey = team.json.agent_key;
  nickCred = team.json.human_credential;
  await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, bearer(nickCred));
  // Admin sets an enforcement class table (plus a secret webhook, to prove the scoped read hides it).
  await post(
    '/teams/dawn/policy',
    { enforcement: { classes: CLASSES }, ask_slack_webhook: 'https://hooks.slack.test/secret' },
    bearer(nickCred),
  );
});

afterEach(async () => {
  await server.close();
});

describe('GET /enforcement (ADR 150) — member-readable, webhook-scoped-out', () => {
  it('a member seat (not admin) can read the class table', async () => {
    const r = await get('/teams/dawn/enforcement', seatHeaders('Ada'));
    expect(r.status).toBe(200);
    expect(r.json.enforcement.classes).toHaveLength(3);
    expect(r.json.enforcement.classes[0].class).toBe('src/tariff.ts');
  });

  it('the scoped read never exposes the secret webhook (only enforcement is returned)', async () => {
    const r = await get('/teams/dawn/enforcement', seatHeaders('Ada'));
    expect(JSON.stringify(r.json)).not.toContain('secret');
    expect(r.json.ask_slack_webhook).toBeUndefined();
  });
});

describe('POST /gate (ADR 150) — adjudicate + shapes-only audit', () => {
  it('a warn-posture contended-surface match proceeds and records a warned lane.gate row', async () => {
    const r = await post(
      '/teams/dawn/gate',
      {
        kind: 'contended-surface',
        class: 'src/tariff.ts',
        fingerprint: 'abc123',
        posture: 'warn',
        tool: 'Edit',
        target: 'src/tariff.ts',
      },
      seatHeaders('Ada'),
    );
    expect(r.status).toBe(200);
    expect(r.json.decision).toBe('allow');
    expect(r.json.outcome).toBe('warned');
    const rows = audits('lane.gate');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe('allow');
  });

  it('a warn-posture costly-action match records a warned action.gate row', async () => {
    const r = await post(
      '/teams/dawn/gate',
      {
        kind: 'costly-action',
        class: 'merge-to-main',
        fingerprint: 'def456',
        posture: 'warn',
        tool: 'Bash',
        target: 'gh pr merge 320 --squash',
      },
      seatHeaders('Ada'),
    );
    expect(r.json.outcome).toBe('warned');
    expect(audits('action.gate')).toHaveLength(1);
  });

  it('the stubbed block path FAILS OPEN — an unfinished gate never wedges a seat', async () => {
    const r = await post(
      '/teams/dawn/gate',
      {
        kind: 'costly-action',
        class: 'force-push',
        fingerprint: 'ghi789',
        posture: 'block',
        tool: 'Bash',
        target: 'git push --force origin feat/x',
      },
      seatHeaders('Ada'),
    );
    expect(r.json.decision).toBe('allow'); // fail-open until Gate B's block path lands
    expect(r.json.outcome).toBe('allowed');
  });

  it('the audit row is SHAPES ONLY — carries class + fingerprint, never the raw target text', async () => {
    await post(
      '/teams/dawn/gate',
      {
        kind: 'costly-action',
        class: 'force-push',
        fingerprint: 'ghi789',
        posture: 'block',
        tool: 'Bash',
        target: 'git push --force origin secret-branch-name',
      },
      seatHeaders('Ada'),
    );
    const row = audits('action.gate').at(-1)!;
    const detail = JSON.parse(row.detail!);
    expect(detail.class).toBe('force-push');
    expect(detail.fingerprint).toBe('ghi789');
    expect(row.target).toBe('force-push'); // the class name, not the command
    // The raw command text never reaches any audit field.
    expect(JSON.stringify(row)).not.toContain('secret-branch-name');
  });

  it('rejects a malformed gate body (400)', async () => {
    const r = await post(
      '/teams/dawn/gate',
      { kind: 'not-a-kind', class: 'x' },
      seatHeaders('Ada'),
    );
    expect(r.status).toBe(400);
  });
});
