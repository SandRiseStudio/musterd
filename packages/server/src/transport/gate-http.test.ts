import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { openLane } from '../store/lanes.js';
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

describe('Gate A — lane-ownership (ADR 150)', () => {
  const team = () => getTeamBySlug(server.db, 'dawn')!;
  const gateA = (posture: 'warn' | 'block', target: string, seat = 'Ada') =>
    post(
      '/teams/dawn/gate',
      {
        kind: 'contended-surface',
        class: 'src/tariff.ts',
        fingerprint: 'fp',
        posture,
        tool: 'Edit',
        target,
      },
      seatHeaders(seat),
    );

  it('owns a claimed lane covering the path → allow, quietly (no nag), under block', async () => {
    openLane(server.db, team().id, 'dawn', 'Ada', {
      title: 'tariff work',
      surface_globs: ['src/**'],
      claim: true,
    });
    const r = await gateA('block', 'src/tariff.ts');
    expect(r.json.decision).toBe('allow');
    expect(r.json.outcome).toBe('allowed');
    expect(r.json.reason).toContain('tariff work');
  });

  it('no lane covering the path, block → DENY with a "claim one" repair', async () => {
    const r = await gateA('block', 'src/tariff.ts');
    expect(r.json.decision).toBe('deny');
    expect(r.json.outcome).toBe('denied');
    expect(r.json.reason).toContain('claim one');
    // The deny is recorded as a lane.gate row with result: deny.
    const row = audits('lane.gate').at(-1)!;
    expect(row.result).toBe('deny');
  });

  it('ANOTHER seat owns the covering lane, block → DENY naming that owner', async () => {
    await post('/teams/dawn/members', { name: 'Bo', kind: 'agent' }, bearer(nickCred));
    openLane(server.db, team().id, 'dawn', 'Bo', {
      title: 'bo tariff',
      surface_globs: ['src/tariff.ts'],
      claim: true,
    });
    const r = await gateA('block', 'src/tariff.ts');
    expect(r.json.decision).toBe('deny');
    expect(r.json.reason).toContain('owned by Bo');
  });

  it('no lane, warn → allow with the advisory (ADR 083 default preserved)', async () => {
    const r = await gateA('warn', 'src/tariff.ts');
    expect(r.json.decision).toBe('allow');
    expect(r.json.outcome).toBe('warned');
  });

  it('owns the lane, warn → quiet allow (ownership means no advisory either)', async () => {
    openLane(server.db, team().id, 'dawn', 'Ada', {
      title: 'ada tariff',
      surface_globs: ['src/tariff.ts'],
      claim: true,
    });
    const r = await gateA('warn', 'src/tariff.ts');
    expect(r.json.outcome).toBe('allowed');
  });

  it('a resolved (done) lane does not count as ownership — only contending lanes cover', async () => {
    const lane = openLane(server.db, team().id, 'dawn', 'Ada', {
      title: 'old tariff',
      surface_globs: ['src/**'],
      claim: true,
    });
    server.db.prepare('UPDATE lanes SET state = ? WHERE id = ?').run('done', lane.id);
    const r = await gateA('block', 'src/tariff.ts');
    expect(r.json.decision).toBe('deny'); // done lane ≠ ownership
  });
});

describe('Gate B — policy-classed action→ask (ADR 150) — deny IS emit', () => {
  // `force-push` is the block-posture costly-action class in CLASSES.
  const forcePush = (target = 'git push --force origin feat/x') =>
    post(
      '/teams/dawn/gate',
      {
        kind: 'costly-action',
        class: 'force-push',
        fingerprint: 'fp-force',
        posture: 'block',
        tool: 'Bash',
        target,
      },
      seatHeaders('Ada'),
    );

  /** A seat answers the raised ask (accept/decline naming it via meta.in_reply_to). `headers` carry the
   *  answerer's identity — a human's bearer cred, or an agent's key + seat header. */
  const answer = async (
    seat: string,
    headers: Record<string, string>,
    act: 'accept' | 'decline',
    askId: string,
  ) => {
    const env = makeEnvelope({
      id: `ans-${act}-${askId.slice(-4)}`,
      team: 'dawn',
      from: seat,
      to: { kind: 'member', name: seat },
      act,
      meta: { in_reply_to: askId },
    });
    return post('/teams/dawn/messages', { envelope: env }, headers);
  };

  const askMessages = () =>
    server.db
      .prepare(
        `SELECT id, meta FROM messages WHERE team_id = ? AND act = 'ask'
           AND json_extract(meta, '$.gate.fingerprint') = 'fp-force'`,
      )
      .all(getTeamBySlug(server.db, 'dawn')!.id) as { id: string; meta: string }[];

  it('first block attempt → DENY + emits ONE species:approve/tier:blocking ask carrying meta.gate', async () => {
    const r = await forcePush();
    expect(r.json.decision).toBe('deny');
    expect(r.json.outcome).toBe('denied_ask_raised');
    expect(r.json.reason).toContain('human approval');
    expect(r.json.ask_ref).toBeTruthy();

    const asks = askMessages();
    expect(asks).toHaveLength(1);
    const meta = JSON.parse(asks[0]!.meta);
    expect(meta.species).toBe('approve');
    expect(meta.tier).toBe('blocking');
    expect(meta.gate).toMatchObject({ class: 'force-push', fingerprint: 'fp-force' });
    // The ask raised its ADR 147 lifecycle row.
    expect(audits('ask.raised')).toHaveLength(1);
    // The gate decision recorded a denied_ask_raised action.gate row.
    expect(audits('action.gate').at(-1)!.result).toBe('deny');
  });

  it('re-attempt while unanswered → DENY (denied_awaiting), does NOT raise a second ask (dedup)', async () => {
    const first = await forcePush();
    const r = await forcePush(); // same fingerprint, human has not answered
    expect(r.json.decision).toBe('deny');
    expect(r.json.outcome).toBe('denied_awaiting');
    expect(r.json.ask_ref).toBe(first.json.ask_ref);
    expect(askMessages()).toHaveLength(1); // still ONE ask
  });

  it('re-attempt after a HUMAN accept → ALLOW (released), standing per-fingerprint', async () => {
    const first = await forcePush();
    const a = await answer('nick', bearer(nickCred), 'accept', first.json.ask_ref);
    expect(a.status).toBe(201);
    const r = await forcePush();
    expect(r.json.decision).toBe('allow');
    expect(r.json.outcome).toBe('released');
    expect(r.json.reason).toContain('approved by nick');
  });

  it('re-attempt after a HUMAN decline → stays DENIED (denied_declined), do not re-raise', async () => {
    const first = await forcePush();
    await answer('nick', bearer(nickCred), 'decline', first.json.ask_ref);
    const r = await forcePush();
    expect(r.json.decision).toBe('deny');
    expect(r.json.outcome).toBe('denied_declined');
    expect(r.json.reason).toContain('declined by nick');
    expect(askMessages()).toHaveLength(1); // no second ask on decline
  });

  it('an AGENT accept does NOT release the gate — only a human accept counts', async () => {
    const first = await forcePush();
    // Ada (the acting agent) tries to self-approve — a valid message, but not a human accept.
    const a = await answer('Ada', seatHeaders('Ada'), 'accept', first.json.ask_ref);
    expect(a.status).toBe(201);
    const r = await forcePush();
    expect(r.json.decision).toBe('deny');
    expect(r.json.outcome).toBe('denied_awaiting'); // still awaiting a HUMAN
  });

  it('the ask body carries the target (delivery carries bodies) while the audit row stays shapes-only', async () => {
    await forcePush('git push --force origin secret-branch');
    const meta = askMessages();
    // body is delivery, not audit: the ask names the exact action for the human.
    const askRow = server.db.prepare(`SELECT body FROM messages WHERE id = ?`).get(meta[0]!.id) as {
      body: string;
    };
    expect(askRow.body).toContain('secret-branch');
    // but the action.gate audit row never carries the command text.
    expect(JSON.stringify(audits('action.gate'))).not.toContain('secret-branch');
  });
});
