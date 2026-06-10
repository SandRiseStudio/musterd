import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnvelope, PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { MusterdClient, bind, type McpConfig } from '@musterd/mcp';
import { ulid } from 'ulid';

/**
 * Scenario C — the flagship 3-pane scenario (06-testing.md), automated.
 * nick (human, CLI/HTTP), Ada (agent, claude-code via MCP), Lin (agent, codex via MCP)
 * split work, post status, exchange a request_help → accept and a handoff → accept,
 * with nick watching. This is the same script that drives the recorded README demo.
 */

let server: RunningServer;
let base: string;
let tok: Record<string, string> = {};
let clients: MusterdClient[] = [];

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await api('POST', '/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human', role: 'lead' } });
  tok['nick'] = team.json.token;
  const ada = await api('POST', '/teams/dawn/members', { name: 'Ada', kind: 'agent', role: 'backend' }, tok['nick']);
  tok['Ada'] = ada.json.token;
  const lin = await api('POST', '/teams/dawn/members', { name: 'Lin', kind: 'agent', role: 'frontend' }, tok['nick']);
  tok['Lin'] = lin.json.token;
});

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await server.close();
  tok = {};
});

function cfg(member: string, surface: McpConfig['surface']): McpConfig {
  return { server: base, team: 'dawn', member, token: tok[member]!, surface };
}

function client(member: string, surface: McpConfig['surface']): MusterdClient {
  const c = new MusterdClient(cfg(member, surface));
  clients.push(c);
  return c;
}

// Strictly increasing send clock so the transcript order is deterministic even when
// several sends land in the same wall-clock millisecond (the log orders by ts, then id).
let sendClock = Date.now();

async function agentSend(client: MusterdClient, from: string, env: Partial<Envelope> & Pick<Envelope, 'act'>) {
  const full = makeEnvelope({
    id: ulid(),
    team: 'dawn',
    from,
    to: env.to ?? { kind: 'team' },
    act: env.act,
    body: env.body ?? '',
    thread: env.thread ?? null,
    meta: env.meta ?? null,
    ts: ++sendClock,
  });
  await client.sendEnvelope(full);
  client.markSeen(full.id);
  return full;
}

describe('Scenario C — flagship 3-pane', () => {
  it('coordinates across three surfaces end to end', async () => {
    // Ada (claude-code) and Lin (codex) attach via the MCP adapter.
    const ada = client('Ada', 'claude-code');
    const lin = client('Lin', 'codex');
    await bind(ada);
    await bind(lin);
    await delay(150); // let both background sockets connect

    // nick (human) is present and watching: roster shows all three online on their surfaces.
    await api('POST', '/teams/dawn/presence', { surface: 'cli', status: 'online' }, tok['nick']);
    const roster = await api('GET', '/teams/dawn/members', undefined, tok['nick']);
    const surfaces = Object.fromEntries(
      roster.json.members.map((m: any) => [m.name, m.presences.map((p: any) => p.surface)]),
    );
    expect(surfaces['Ada']).toContain('claude-code');
    expect(surfaces['Lin']).toContain('codex');
    expect(roster.json.members.find((m: any) => m.name === 'nick').presence).toBe('online');

    // 1. Both agents split work and post status.
    await agentSend(ada, 'Ada', { act: 'status_update', body: 'taking the auth backend', meta: { progress: 0.1 } });
    await agentSend(lin, 'Lin', { act: 'status_update', body: 'taking the login UI', meta: { progress: 0.1 } });

    // 2. Lin hits a blocker and asks the team for help (so the whole team — and nick — sees it).
    const help = await agentSend(lin, 'Lin', {
      act: 'request_help',
      to: { kind: 'team' },
      body: 'what shape is the /session response?',
      meta: { blocking: true },
    });
    await delay(80);

    // Ada sees the request_help in her buffered/fetched inbox and accepts it (threaded).
    const adaInbox = await ada.fetchInbox(true);
    expect(adaInbox.messages.find((m) => m.id === help.id)?.act).toBe('request_help');
    await ada.markRead(help.id);
    await agentSend(ada, 'Ada', {
      act: 'accept',
      to: { kind: 'team' },
      body: '{ token, expiresAt } — handing you a typed client',
      thread: help.id,
      meta: { in_reply_to: help.id },
    });

    // 3. Ada hands the typed client off to Lin; Lin accepts.
    const handoff = await agentSend(ada, 'Ada', {
      act: 'handoff',
      to: { kind: 'member', name: 'Lin' },
      body: 'session client ready in src/session.ts',
      meta: { artifact: 'src/session.ts' },
    });
    await delay(80);
    const linInbox = await lin.fetchInbox(true);
    expect(linInbox.messages.some((m) => m.id === handoff.id && m.act === 'handoff')).toBe(true);
    await lin.markRead(handoff.id);
    await agentSend(lin, 'Lin', {
      act: 'accept',
      to: { kind: 'team' },
      body: 'wired in, tests green',
      thread: handoff.id,
      meta: { in_reply_to: handoff.id },
    });

    // nick (the watching human) sees all team-scoped coordination in order. The Ada→Lin
    // handoff is a private 1:1 transfer, so it is intentionally NOT in nick's stream.
    const transcript = await api('GET', '/teams/dawn/inbox', undefined, tok['nick']);
    const acts = transcript.json.messages.map((m: Envelope) => m.act);
    expect(acts).toEqual(['status_update', 'status_update', 'request_help', 'accept', 'accept']);

    // The request_help → accept pair is threaded.
    const accept = transcript.json.messages.find((m: Envelope) => m.act === 'accept' && m.thread === help.id);
    expect(accept).toBeTruthy();

    ada.close();
    lin.close();
  });
});
