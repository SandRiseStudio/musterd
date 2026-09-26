import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';
import { getTeamBySlug, setPolicy } from '../store/teams.js';
import { countTraceEvents, listSessionTrace } from '../store/trace.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/**
 * `POST /teams/:slug/trace/events` (ADR 445 §2 R1 / §3, increment 1a): the hook tap's ingest.
 * Asserted here: the seat comes from the credential, never the body; a seat credential with NO
 * session lease is accepted (a SessionStart hook posts before the session has joined — the ADR 408
 * leaseless window); the body is parsed at the boundary (a content field is stripped, a bad event
 * is a 400, not a partial write); presence is not touched; rows land in the TRACE store, not the
 * coordination store; and `/health` names the trace ladder.
 */
let server: RunningServer;
let base: string;
let auth: AgentHttpAuth;
let agentKey: string;
let humanCredential: string;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

const ev = (over: Record<string, unknown> = {}) => ({
  harness: 'claude-code',
  session_digest: 'abcdef012345',
  ts: 1_790_000_000_000,
  kind: 'PostToolUse',
  tool_name: 'Bash',
  tool_use_id: 'toolu_1',
  ...over,
});

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  await post(
    '/teams/dawn/members',
    { name: 'Ada', kind: 'agent' },
    { authorization: `Bearer ${team.json.human_credential}` },
  );
  auth = await claimAgentHttp(base, 'dawn', team.json.agent_key, team.json.human_credential, 'Ada');
  agentKey = team.json.agent_key;
  humanCredential = team.json.human_credential;
});

afterEach(async () => {
  await server.close();
});

const teamId = () => getTeamBySlug(server.db, 'dawn')!.id;

describe('POST /teams/:slug/trace/events', () => {
  it('stores structural rows in trace.db under the authenticated seat, with a lease', async () => {
    const r = await post(
      '/teams/dawn/trace/events',
      { events: [ev(), ev({ kind: 'PreToolUse', tool_use_id: 'toolu_2' })] },
      {
        authorization: `Bearer ${auth.key}`,
        'x-musterd-seat': 'Ada',
        'x-musterd-session-lease': auth.sessionLease,
      },
    );
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ accepted: 2, content: 'off' });
    const rows = listSessionTrace(server.traceDb, teamId(), 'abcdef012345');
    expect(rows.map((x) => [x.seq, x.kind, x.seat])).toEqual([
      [0, 'PostToolUse', 'Ada'],
      [1, 'PreToolUse', 'Ada'],
    ]);
    // the coordination store has no trace table at all
    const t = server.db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='trace_events'")
      .get()!;
    expect(t.n).toBe(0);
  });

  it('accepts a seat credential with no session lease (the SessionStart window)', async () => {
    const r = await post(
      '/teams/dawn/trace/events',
      { events: [ev({ kind: 'SessionStart' })] },
      { authorization: `Bearer ${auth.key}`, 'x-musterd-seat': 'Ada' },
    );
    expect(r.status).toBe(202);
    expect(countTraceEvents(server.traceDb, teamId(), 'Ada')).toEqual([
      { kind: 'SessionStart', count: 1 },
    ]);
  });

  it('parses at the boundary: a content field is stripped, a malformed event is a 400 with no partial write', async () => {
    const headers = { authorization: `Bearer ${auth.key}`, 'x-musterd-seat': 'Ada' };
    const ok = await post(
      '/teams/dawn/trace/events',
      { events: [ev({ tool_input: { command: 'cat .musterd/binding.json' } })] },
      headers,
    );
    expect(ok.status).toBe(202);
    const row = listSessionTrace(server.traceDb, teamId(), 'abcdef012345')[0]!;
    expect(row.content).toBeNull();
    expect(JSON.stringify(row)).not.toContain('binding.json');

    const bad = await post(
      '/teams/dawn/trace/events',
      { events: [ev({ session_digest: 'ffffffff0000' }), ev({ kind: 'Reasoning' })] },
      headers,
    );
    expect(bad.status).toBe(400);
    expect(listSessionTrace(server.traceDb, teamId(), 'ffffffff0000')).toHaveLength(0);
    expect((await post('/teams/dawn/trace/events', { events: [] }, headers)).status).toBe(400);
  });

  describe('the content part (increment 1b)', () => {
    const headers = () => ({ authorization: `Bearer ${auth.key}`, 'x-musterd-seat': 'Ada' });
    const content = (over: Record<string, unknown> = {}) => ({
      tool_input: '{"command":"cat .musterd/binding.json"}',
      tool_response: '{"stdout":"ok"}',
      redactions: 0,
      truncated: false,
      ...over,
    });

    it('is dropped, never stored, while the team policy is off (the default) — and the reply says off', async () => {
      const r = await post(
        '/teams/dawn/trace/events',
        { events: [ev({ content: content() })] },
        headers(),
      );
      expect(r.json).toEqual({ accepted: 1, content: 'off' });
      const row = listSessionTrace(server.traceDb, teamId(), 'abcdef012345')[0]!;
      expect(row.content).toBeNull();
      expect(row.redactions).toBeNull();
    });

    it('is stored under trace.content=on, re-scrubbed on the way in, with the counts on the row', async () => {
      setPolicy(server.db, teamId(), { trace: { content: 'on' } });
      const leaked = 'mskey_Zq7xK2mNvB9pLw4R';
      const r = await post(
        '/teams/dawn/trace/events',
        {
          events: [
            // An older / foreign tap that sent content unscrubbed: the daemon's pass catches it.
            ev({
              content: content({
                tool_response: `{"stdout":"${leaked}"}`,
                redactions: 2,
                truncated: true,
              }),
            }),
            ev({ kind: 'PreToolUse', tool_use_id: 'toolu_2' }),
          ],
        },
        headers(),
      );
      expect(r.json).toEqual({ accepted: 2, content: 'on' });
      const [withContent, structural] = listSessionTrace(server.traceDb, teamId(), 'abcdef012345');
      expect(JSON.parse(withContent!.content!)).toEqual({
        tool_input: '{"command":"cat .musterd/binding.json"}',
        tool_response: '{"stdout":"<redacted:agent_key>"}',
      });
      expect(withContent!.content).not.toContain(leaked);
      expect(withContent!.redactions).toBe(3); // the hook's 2 + the daemon's 1
      expect(withContent!.truncated).toBe(1);
      expect(structural!.content).toBeNull();
    });

    it('refuses a content part over the bound as a 400 — no partial write', async () => {
      setPolicy(server.db, teamId(), { trace: { content: 'on' } });
      const r = await post(
        '/teams/dawn/trace/events',
        { events: [ev({ content: content({ tool_response: 'x'.repeat(262_145) }) })] },
        headers(),
      );
      expect(r.status).toBe(400);
      expect(listSessionTrace(server.traceDb, teamId(), 'abcdef012345')).toHaveLength(0);
    });
  });

  it('refuses a body that names another seat, an unauthenticated post, and a bootstrap key', async () => {
    const r = await post('/teams/dawn/trace/events', { events: [ev()] });
    expect(r.status).toBe(401);
    // `seat` is not a body field; a stray one is ignored and the row is still the caller's
    const r2 = await post(
      '/teams/dawn/trace/events',
      { seat: 'nick', events: [ev()] },
      { authorization: `Bearer ${auth.key}`, 'x-musterd-seat': 'Ada' },
    );
    expect(r2.status).toBe(202);
    expect(listSessionTrace(server.traceDb, teamId(), 'abcdef012345')[0]!.seat).toBe('Ada');
  });

  it('/health reports the trace ladder beside the coordination schema', async () => {
    const h = (await (await fetch(base + '/health')).json()) as Record<string, unknown>;
    expect(h['trace_schema']).toBe(3);
    expect(h['trace_db']).toBe(':memory:');
    // an in-memory store has no size on disk — absence, never a made-up zero (increment 3a)
    expect(h).not.toHaveProperty('trace_db_bytes');
  });

  it('writes a trace.downgraded audit row when a tail posts its downgrade marker (increment 2)', async () => {
    const r = await post(
      '/teams/dawn/trace/events',
      {
        events: [
          ev({
            kind: 'unknown',
            tool_name: undefined,
            tool_use_id: undefined,
            outcome: 'error',
            detail: { parser: 'claude-code@1', downgraded: true, reason: 'transcript_truncated' },
          }),
          // an ordinary unknown record is NOT a downgrade and writes no audit row
          ev({ kind: 'unknown', detail: { parser: 'claude-code@1', bytes: 12, type: 'novel' } }),
        ],
      },
      { authorization: `Bearer ${auth.key}`, 'x-musterd-seat': 'Ada' },
    );
    expect(r.status).toBe(202);
    const rows = server.db
      .prepare<
        [string],
        { actor: string; target: string; detail: string }
      >("SELECT actor, target, detail FROM audit WHERE team_id = ? AND action = 'trace.downgraded'")
      .all(teamId());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('Ada');
    expect(JSON.parse(rows[0]!.detail)).toEqual({
      harness: 'claude-code',
      session_digest: 'abcdef012345',
      reason: 'transcript_truncated',
    });
  });
});

describe('GET /teams/:slug/trace/sessions/:digest (increment 2)', () => {
  // Unlike the ingest POST (leaseless by design — hooks), the read is an ordinary authenticated
  // read: an agent seat presents its live session lease like everywhere else.
  const headers = () => ({
    authorization: `Bearer ${auth.key}`,
    'x-musterd-seat': 'Ada',
    'x-musterd-session-lease': auth.sessionLease,
  });

  async function get(path: string, hdrs: Record<string, string>) {
    const res = await fetch(base + path, { headers: hdrs });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  beforeEach(async () => {
    setPolicy(server.db, teamId(), { trace: { content: 'on' } });
    await post(
      '/teams/dawn/trace/events',
      {
        events: [
          ev({ kind: 'PreToolUse' }),
          ev({
            kind: 'reasoning',
            tool_name: undefined,
            detail: { parser: 'claude-code@1', reasoning_bytes: 14 },
            content: { reasoning: 'think it over', redactions: 0, truncated: false },
          }),
          ev({
            kind: 'usage',
            tool_name: undefined,
            detail: { input_tokens: 10, output_tokens: 2 },
          }),
        ],
      },
      headers(),
    );
  });

  it('returns the seat its own session end to end, seq-ordered, content parsed', async () => {
    const r = await get('/teams/dawn/trace/sessions/abcdef012345', headers());
    expect(r.status).toBe(200);
    expect(r.json.events.map((e: any) => [e.seq, e.kind])).toEqual([
      [0, 'PreToolUse'],
      [1, 'reasoning'],
      [2, 'usage'],
    ]);
    const reasoning = r.json.events[1];
    expect(reasoning.content).toEqual({ reasoning: 'think it over' });
    expect(reasoning.detail).toEqual({ parser: 'claude-code@1', reasoning_bytes: 14 });
    expect(reasoning.truncated).toBe(false);
    expect(reasoning.seat).toBe('Ada');
  });

  it("filters another seat's rows for a non-admin — same empty answer as an unknown digest", async () => {
    await post(
      '/teams/dawn/members',
      { name: 'Bo', kind: 'agent' },
      { authorization: `Bearer ${humanCredential}` },
    );
    const bo = await claimAgentHttp(base, 'dawn', agentKey, humanCredential, 'Bo');
    const r = await get('/teams/dawn/trace/sessions/abcdef012345', {
      authorization: `Bearer ${bo.key}`,
      'x-musterd-seat': 'Bo',
      'x-musterd-session-lease': bo.sessionLease,
    });
    expect(r.status).toBe(200);
    expect(r.json.events).toEqual([]);
    const missing = await get('/teams/dawn/trace/sessions/ffffffffffff', headers());
    expect(missing.json.events).toEqual([]);
  });

  it('lets an admin read any seat, and refuses a digest that is not a digest', async () => {
    const r = await get('/teams/dawn/trace/sessions/abcdef012345', {
      authorization: `Bearer ${humanCredential}`,
    });
    expect(r.status).toBe(200);
    expect(r.json.events).toHaveLength(3);
    const bad = await get('/teams/dawn/trace/sessions/not-a-digest!', headers());
    expect(bad.status).toBe(400);
  });
});
