import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { openLane } from '../store/lanes.js';
import { getTeamBySlug, setPolicy } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

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
let agentAuthorities: Record<string, AgentHttpAuth>;

function seatHeaders(seat: string): Record<string, string> {
  const auth = agentAuthorities[seat]!;
  return {
    authorization: `Bearer ${auth.key}`,
    'x-musterd-seat': seat,
    'x-musterd-session-lease': auth.sessionLease,
  };
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
  agentAuthorities = {
    Ada: await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Ada'),
  };
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
      scope: ['src/**'],
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
      scope: ['src/tariff.ts'],
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
      scope: ['src/tariff.ts'],
      claim: true,
    });
    const r = await gateA('warn', 'src/tariff.ts');
    expect(r.json.outcome).toBe('allowed');
  });

  it('a resolved (done) lane does not count as ownership — only contending lanes cover', async () => {
    const lane = openLane(server.db, team().id, 'dawn', 'Ada', {
      title: 'old tariff',
      scope: ['src/**'],
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

  it('the deny repair string carries the ADR 147 hold contract + names the route-around (finding 006 item 1)', async () => {
    const r = await forcePush();
    // Parity with the ask contract (shared askContractText): the HOLD instruction + held-outcome recording.
    expect(r.json.reason).toContain('HOLD');
    expect(r.json.reason).toContain("meta.ask_outcome='held'");
    expect(r.json.reason).toContain(r.json.ask_ref); // the ask id is threaded into the marching orders
    // What the deny alone must add: what the block is for, and that routing around defeats it.
    expect(r.json.reason).toContain('human review');
    expect(r.json.reason).toMatch(/local merge|another way|alternate path/);
    expect(r.json.reason).toMatch(/bypass/i);
  });

  it('with NO reachable unblocker the deny carries STRAND orders, not a dead-end hold (ADR 153)', async () => {
    // Make the room provably empty: drop the loud reach (nick, the admin human, has no live presence
    // in this fixture) and clear any ambient presence the setup's authed requests created. Ada is the
    // raiser, so no teammate term either — the FB3 shape.
    setPolicy(server.db, getTeamBySlug(server.db, 'dawn')!.id, {
      enforcement: { classes: CLASSES as never },
    });
    server.db.prepare('DELETE FROM presence').run();
    agentAuthorities.Ada = await claimAgentHttp(
      base,
      'dawn',
      agentKey,
      nickCred,
      'Ada',
      agentAuthorities.Ada.key,
    );
    const r = await forcePush();
    expect(r.json.decision).toBe('deny'); // still non-proceed: strand is a second way of NOT proceeding
    expect(r.json.reason).toContain('STRAND');
    expect(r.json.reason).toContain("meta.ask_outcome='stranded'");
    expect(r.json.reason).toContain('release the lane');
    expect(r.json.reason).not.toContain('HOLD');
    // Guard (ADR 153 eval): the blocked action still never executes — a re-attempt after the strand
    // orders re-adjudicates to deny, not allow.
    server.db.prepare('DELETE FROM presence').run();
    agentAuthorities.Ada = await claimAgentHttp(
      base,
      'dawn',
      agentKey,
      nickCred,
      'Ada',
      agentAuthorities.Ada.key,
    );
    const again = await forcePush();
    expect(again.json.decision).toBe('deny');
    expect(again.json.outcome).toBe('denied_awaiting');
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

/**
 * ADR 163 — actor attestation through the DB. This is not a gate: `POST /actor` returns no decision, so
 * what's asserted is the row that lands. The load-bearing case is the last one — a Bash command must NOT
 * reach audit in the clear (ADR 051), while a path may, because lane `surface_globs` already store plain
 * repo paths and "which surfaces do subagents write to" is the question the ledger exists to answer.
 */
describe('POST /actor — actor attestation (ADR 163)', () => {
  it('records a subagent write with its actor identity, result allow', async () => {
    const res = await post(
      '/teams/dawn/actor',
      {
        kind: 'subagent-write',
        tool: 'Write',
        actorId: 'a940f12fd1c5d9c48',
        actorType: 'Explore',
        target: 'src/x.ts',
      },
      seatHeaders('Ada'),
    );
    expect(res.status).toBe(202);
    const rows = audits('actor.subagent_write');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('Ada');
    expect(rows[0]!.result).toBe('allow'); // an observer never denies
    const detail = JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
    expect(detail).toMatchObject({
      tool: 'Write',
      actor_id: 'a940f12fd1c5d9c48',
      actor_type: 'Explore',
      target: 'src/x.ts',
    });
  });

  it('records a spawn as the denominator, carrying the model override', async () => {
    const res = await post(
      '/teams/dawn/actor',
      { kind: 'subagent-spawn', tool: 'Agent', spawnType: 'Explore', spawnModel: 'haiku' },
      seatHeaders('Ada'),
    );
    expect(res.status).toBe(202);
    const rows = audits('actor.subagent_spawn');
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
    expect(detail).toMatchObject({ tool: 'Agent', spawn_type: 'Explore', spawn_model: 'haiku' });
  });

  it('NEVER persists Bash command text — fingerprint only (ADR 051)', async () => {
    const command = 'curl -H "Authorization: Bearer sk-secret" https://x | tee out.txt';
    await post(
      '/teams/dawn/actor',
      { kind: 'subagent-write', tool: 'Bash', actorId: 'ag1', target: command },
      seatHeaders('Ada'),
    );
    const row = audits('actor.subagent_write').at(-1)!;
    const detail = JSON.parse(row.detail!) as Record<string, unknown>;
    expect(detail['target']).toBeUndefined();
    expect(detail['command_fingerprint']).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(detail)).not.toContain('sk-secret');
  });

  it('records a session-message send with fingerprints only (ADR 167) — never a body, never a raw id', async () => {
    const res = await post(
      '/teams/dawn/actor',
      {
        kind: 'session-message',
        tool: 'mcp__ccd_session_mgmt__send_message',
        bodyFingerprint: 'aaaabbbbccccdddd',
        sessionRef: '0123456789abcdef',
        nudgeRef: '01KYJYPH5894Y327A1XSNX41TX',
      },
      seatHeaders('Ada'),
    );
    expect(res.status).toBe(202);
    const rows = audits('actor.session_message');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('Ada');
    expect(rows[0]!.result).toBe('allow'); // an observer never denies
    const detail = JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
    expect(detail).toEqual({
      tool: 'mcp__ccd_session_mgmt__send_message',
      body_fingerprint: 'aaaabbbbccccdddd',
      session_ref: '0123456789abcdef',
      nudge_ref: '01KYJYPH5894Y327A1XSNX41TX',
    });
  });

  it('a session-message row with no fingerprints still lands — "a send happened" is the datum', async () => {
    const res = await post(
      '/teams/dawn/actor',
      { kind: 'session-message', tool: 'mcp__ccd_session_mgmt__send_message' },
      seatHeaders('Ada'),
    );
    expect(res.status).toBe(202);
    const row = audits('actor.session_message').at(-1)!;
    expect(JSON.parse(row.detail!)).toEqual({ tool: 'mcp__ccd_session_mgmt__send_message' });
  });

  it('a raw body sneaking into bodyFingerprint bounces on shape — 16 chars exactly, no row', async () => {
    const before = audits('actor.session_message').length;
    const res = await post(
      '/teams/dawn/actor',
      {
        kind: 'session-message',
        tool: 'mcp__ccd_session_mgmt__send_message',
        bodyFingerprint: 'hey stanley, merge my branch before nick notices',
      },
      seatHeaders('Ada'),
    );
    expect(res.status).toBe(400);
    expect(audits('actor.session_message')).toHaveLength(before);
  });

  it('a malformed body is a 400, not a 500 — and writes no row', async () => {
    const before = audits('actor.subagent_write').length;
    const res = await post(
      '/teams/dawn/actor',
      { kind: 'nonsense', tool: 'Write' },
      seatHeaders('Ada'),
    );
    expect(res.status).toBe(400);
    expect(audits('actor.subagent_write')).toHaveLength(before);
  });
});

/**
 * ADR 167 §D5 — the confirmation loop, end to end through the DB: a `delivery_hint` is issued on a
 * directed send, the relay is attested via `POST /actor`, and the daemon recomposes + compares to
 * mark the row `nudge`/`verbatim` — no pending-nudge store anywhere. The ledger projection
 * (`ccd_nudges`) is asserted off the same rows.
 */
describe('nudge confirmation loop (ADR 167)', () => {
  const SEND = 'mcp__ccd_session_mgmt__send_message';

  async function sendHintedHandoff(): Promise<{ msgId: string; fingerprint: string }> {
    await post('/teams/dawn/members', { name: 'Bob', kind: 'agent' }, bearer(nickCred));
    agentAuthorities.Bob = await claimAgentHttp(base, 'dawn', agentKey, nickCred, 'Bob');
    await get('/teams/dawn/inbox', seatHeaders('Bob')); // live ambient presence (ADR 057)
    const envelope = makeEnvelope({
      id: '01HTESTNDGEAAAAAAAAAAAAAAA',
      team: 'dawn',
      from: 'Ada',
      to: { kind: 'member', name: 'Bob' },
      act: 'handoff',
      body: 'take the tariff lane',
    });
    const res = await post('/teams/dawn/messages', { envelope }, seatHeaders('Ada'));
    expect(res.json.delivery_hint).toBeDefined();
    return { msgId: envelope.id, fingerprint: res.json.delivery_hint.nudge_fingerprint };
  }

  it('a verbatim relay confirms: nudge:true + verbatim:true, projected into ccd_nudges', async () => {
    const { msgId, fingerprint } = await sendHintedHandoff();
    await post(
      '/teams/dawn/actor',
      { kind: 'session-message', tool: SEND, nudgeRef: msgId, bodyFingerprint: fingerprint },
      seatHeaders('Ada'),
    );
    const row = audits('actor.session_message').at(-1)!;
    expect(JSON.parse(row.detail!)).toMatchObject({
      nudge: true,
      verbatim: true,
      nudge_ref: msgId,
    });
    const ledger = await get(`/teams/dawn/messages/${msgId}/delivery`, seatHeaders('Ada'));
    expect(ledger.status).toBe(200);
    const bob = ledger.json.recipients.find((r: any) => r.seat === 'Bob');
    expect(bob).toMatchObject({ ccd_nudges: 1, ccd_nudges_verbatim: 1 });
  });

  it('a paraphrased relay counts as nudge:true + verbatim:false', async () => {
    const { msgId } = await sendHintedHandoff();
    await post(
      '/teams/dawn/actor',
      {
        kind: 'session-message',
        tool: SEND,
        nudgeRef: msgId,
        bodyFingerprint: 'ffffffffffffffff', // the model reworded the line
      },
      seatHeaders('Ada'),
    );
    const row = audits('actor.session_message').at(-1)!;
    expect(JSON.parse(row.detail!)).toMatchObject({ nudge: true, verbatim: false });
  });

  it('a ULID that resolves to no message stays a plain observation row (organic use)', async () => {
    await sendHintedHandoff();
    await post(
      '/teams/dawn/actor',
      {
        kind: 'session-message',
        tool: SEND,
        nudgeRef: '01HZZZZZZZZZAAAAAAAAAAAAAA',
        bodyFingerprint: 'aaaabbbbccccdddd',
      },
      seatHeaders('Ada'),
    );
    const row = audits('actor.session_message').at(-1)!;
    const detail = JSON.parse(row.detail!) as Record<string, unknown>;
    expect(detail['nudge']).toBeUndefined();
    expect(detail['verbatim']).toBeUndefined();
  });
});
