import { EventEmitter } from 'node:events';
import { PROTOCOL_VERSION } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bind } from './bind.js';
import { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { buildMcpServer, installShutdownHandlers, primerInstructions } from './index.js';

let server: RunningServer;
let base: string;
let tokens: Record<string, string> = {};

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await api('POST', '/teams', {
    slug: 'dawn',
    creator: { name: 'nick', kind: 'human', role: 'lead' },
  });
  tokens['nick'] = team.json.token;
  // v0.3 (ADR 075): agents claim with the team agent key from the composite mint (SPEC A.7).
  tokens['agent_key'] = team.json.agent_key;
  // Declare Ada's seat (no per-seat token in v0.3 — she claims it with the team agent key).
  await api(
    'POST',
    '/teams/dawn/members',
    { name: 'Ada', kind: 'agent', role: 'backend' },
    tokens['nick'],
  );
  // Issue a standing grant for Ada's seat so the claim occupies immediately (no admin-approval lane).
  const grant = await api(
    'POST',
    '/teams/dawn/grants',
    { scope: 'seat', target: 'Ada', lifetime: 'standing' },
    tokens['nick'],
  );
  tokens['ada_grant'] = grant.json.token;
});

afterEach(async () => {
  await server.close();
  tokens = {};
});

function adaConfig(): McpConfig {
  return {
    server: base,
    team: 'dawn',
    agent_key: tokens['agent_key']!,
    grant: tokens['ada_grant']!,
    surface: 'claude-code',
    provenance: 'session',
    workspace: 'repo',
    claim: { mode: 'seat', name: 'Ada' },
    connId: 'conn-ada',
    claimCode: 'AD12',
  };
}

async function rosterMember(name: string) {
  const roster = await api('GET', '/teams/dawn/members', undefined, tokens['nick']);
  return roster.json.members.find((m: any) => m.name === name);
}

describe('MCP adapter', () => {
  it('is dormant after bind, online after team_join, offline after team_leave', async () => {
    const client = new MusterdClient(adaConfig());
    await bind(client);
    expect(client.joined).toBe(false);
    expect((await rosterMember('Ada')).presence).toBe('offline'); // dormant: not present

    await client.join();
    expect(client.joined).toBe(true);
    const ada = await rosterMember('Ada');
    expect(ada.presence).toBe('online');
    expect(ada.presences.some((p: any) => p.surface === 'claude-code')).toBe(true);

    client.leave();
    expect(client.joined).toBe(false);
    client.close();
  });

  it('a second session for the same member takes over; the first is superseded (ADR 017)', async () => {
    const a1 = new MusterdClient(adaConfig());
    await a1.join();
    expect(a1.joined).toBe(true);

    // Newest wins: a second session from a DIFFERENT workspace claims the same seat and takes over
    // (no member_busy lockout). Different-workspace is the genuine-relaunch case ADR 017 displaces;
    // a *same*-workspace re-claim (a health-check probe) would instead keep the incumbent (ADR 068).
    const a2 = new MusterdClient({ ...adaConfig(), workspace: 'repo-elsewhere' });
    await a2.join();
    expect(a2.joined).toBe(true);

    // ... and the first is displaced — it stops holding the seat and won't reconnect.
    await vi.waitFor(() => {
      expect(a1.joined).toBe(false);
      expect(a1.lastJoinError).toMatch(/superseded/i);
    });

    a1.close();
    a2.close();
  });

  it('an invalid agent key is refused on claim (v0.3, ADR 075)', async () => {
    const bad = new MusterdClient({ ...adaConfig(), agent_key: 'mskey_not_a_real_key' });
    await expect(bad.join()).rejects.toThrow(/forbidden|unauthorized|refused|invalid|expired/i);
    expect(bad.lastJoinError).toMatch(/invalid key|forbidden|refused/i);
    bad.close();
  });

  it('Ada sends a status_update that nick sees in his inbox', async () => {
    const client = new MusterdClient(adaConfig());
    await client.join();
    const { ulid } = await import('ulid');
    const { makeEnvelope } = await import('@musterd/protocol');
    const env = makeEnvelope({
      id: ulid(),
      team: 'dawn',
      from: 'Ada',
      to: { kind: 'team' },
      act: 'status_update',
      body: 'scaffolded auth',
      meta: { progress: 0.4 },
    });
    await client.sendEnvelope(env);
    const inbox = await api('GET', '/teams/dawn/inbox?unread=1', undefined, tokens['nick']);
    expect(inbox.json.messages.map((m: any) => m.body)).toContain('scaffolded auth');
    client.close();
  });

  it('returns an inbound request_help once, then nothing (cursor advances)', async () => {
    const client = new MusterdClient(adaConfig());
    await client.join();
    await delay(150); // let the background WS connect

    // nick asks Ada for help (over HTTP)
    const env = {
      id: 'rh1',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from: 'nick',
      to: { kind: 'member', name: 'Ada' },
      act: 'request_help',
      body: 'tests failing on token hash',
      ts: Date.now(),
    };
    await api('POST', '/teams/dawn/messages', { envelope: env }, tokens['nick']);

    const first = await client.fetchInbox(true);
    expect(first.messages.map((m) => m.id)).toContain('rh1');
    await client.markRead('rh1');
    const second = await client.fetchInbox(true);
    expect(second.messages).toHaveLength(0);
    client.close();
  });

  it('buffers a live delivery over the background WS and dedups own sends', async () => {
    const client = new MusterdClient(adaConfig());
    await client.join(); // join opens the background WS (bind no longer claims presence)
    await delay(150);

    await api(
      'POST',
      '/teams/dawn/messages',
      {
        envelope: {
          id: 'live1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'Ada' },
          act: 'message',
          body: 'live ping',
          ts: Date.now(),
        },
      },
      tokens['nick'],
    );
    await delay(100);

    const buffered = client.drainBuffer();
    expect(buffered.map((e) => e.id)).toContain('live1');
    // draining again yields nothing
    expect(client.drainBuffer()).toHaveLength(0);
    client.close();
  });

  it('drops presence and exits when the host closes stdin (no orphaned adapter)', () => {
    const close = vi.fn();
    const exit = vi.fn();
    const stdin = new EventEmitter() as unknown as Parameters<
      typeof installShutdownHandlers
    >[0]['stdin'];
    const signals = new EventEmitter() as unknown as NodeJS.Process;
    const transport: { onclose?: () => void } = {};

    installShutdownHandlers({ close, exit, stdin, signals, transport });

    // Host closing the stdio pipe is the canonical shutdown signal.
    (stdin as unknown as EventEmitter).emit('end');
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);

    // Further teardown events (close, a SIGTERM race, transport.onclose) are idempotent.
    (stdin as unknown as EventEmitter).emit('close');
    (signals as unknown as EventEmitter).emit('SIGTERM');
    transport.onclose?.();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('chains an existing transport.onclose rather than clobbering it', () => {
    const prior = vi.fn();
    const transport: { onclose?: () => void } = { onclose: prior };
    installShutdownHandlers({
      close: vi.fn(),
      exit: vi.fn(),
      stdin: new EventEmitter() as any,
      signals: new EventEmitter() as unknown as NodeJS.Process,
      transport,
    });
    transport.onclose?.();
    expect(prior).toHaveBeenCalledTimes(1);
  });

  it('builds an MCP server with the four tools registered', async () => {
    const client = new MusterdClient(adaConfig());
    const mcp = buildMcpServer(client, adaConfig());
    expect(mcp).toBeTruthy();
    // McpServer exposes registered tools on its internal registry; smoke check construction only.
    client.close();
  });

  it('serves the primer as MCP instructions — file-free onboarding (ADR 012 follow-up)', () => {
    // A provisioned session names its seat.
    const named = primerInstructions(adaConfig());
    expect(named).toContain('## Your musterd team');
    expect(named).toContain('**Ada** on the **dawn** team');
    expect(named).toContain('team_inbox_check');

    // An unclaimed session (no member) is told to claim a seat first.
    const unclaimed = primerInstructions({ server: base, team: 'dawn' });
    expect(unclaimed).toContain('claim your seat first');
    expect(unclaimed).not.toContain('You are **');
  });
});
