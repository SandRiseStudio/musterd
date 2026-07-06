import { EventEmitter } from 'node:events';
import { PROTOCOL_VERSION } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bind } from './bind.js';
import { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import {
  buildMcpServer,
  installShutdownHandlers,
  primerInstructions,
  TOOL_NAMES,
} from './index.js';

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
  // Post-cutover (ADR 069): nick authenticates with his human credential (mscr_, self-identifying);
  // the mskd_ creator token no longer authenticates.
  tokens['nick'] = team.json.human_credential;
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

  // ADR 087: a blocking team_join with no grant parks on the approval request and resolves — with the
  // delivered resume token captured — the moment an admin approves, instead of rejecting and looping.
  it('a grant-less blocking join parks on pending, then occupies + captures the resume token on approve', async () => {
    const client = new MusterdClient({ ...adaConfig(), grant: undefined });
    const joining = client.join(5_000); // blocking — parks on the pending request

    // The claim opens a request; approve it as the admin with a ttl (resume) lifetime.
    let requestId: string | undefined;
    for (let i = 0; i < 50 && !requestId; i++) {
      const r = await api('GET', '/teams/dawn/requests?status=pending', undefined, tokens['nick']);
      requestId = r.json.requests[0]?.id;
      if (!requestId) await delay(50);
    }
    expect(requestId).toBeTruthy();
    expect(client.awaitingRequestId).toBe(requestId);
    await api(
      'POST',
      `/teams/dawn/requests/${requestId}/decide`,
      { decision: 'approve', lifetime: 'ttl', ttl_hours: 24 },
      tokens['nick'],
    );

    await joining; // the same call resolves on the pushed occupied — no re-join needed
    expect(client.joined).toBe(true);
    expect(client.member).toBe('Ada');
    // The resume token was delivered on the occupied frame and captured for persistBinding.
    const captured = (client as unknown as { config: McpConfig }).config.grant;
    expect(captured).toMatch(/^msgr_/);
    expect(client.awaitingRequestId).toBeNull();
    client.close();
  }, 10_000);

  // ADR 087: a non-blocking join (autojoin, no wait) must still reject on pending so startup never
  // hangs — only the explicit, timed team_join parks. Preserves the pending-marker/resolution path.
  it('a grant-less non-blocking join rejects on pending (autojoin stays best-effort)', async () => {
    const client = new MusterdClient({ ...adaConfig(), grant: undefined });
    await expect(client.join()).rejects.toThrow(/pending approval/i);
    expect(client.joined).toBe(false);
    client.close();
  }, 10_000);

  it('a second session for the same member takes over; the first is superseded (ADR 017)', async () => {
    const a1 = new MusterdClient(adaConfig());
    // A cross-workspace takeover must NOT trigger the self-exit (ADR 092): it's a genuinely different
    // session (another machine/branch), so a1 stays dormant, not exited.
    let replaced = false;
    a1.onReplaced = () => {
      replaced = true;
    };
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
    // Terminal (ADR 017): no reconnect / re-claim after supersession, and no cross-workspace self-exit.
    await delay(200);
    expect(a1.joined).toBe(false);
    expect(replaced).toBe(false);

    a1.close();
    a2.close();
  });

  it('a same-workspace successor replaces the session: onReplaced fires, terminal (ADR 092)', async () => {
    // Recreate the server with a short reap grace, reusing the same injected db (an injected db is not
    // closed on server.close, so the team/seat/grant set up in beforeEach survive).
    const db = server.db;
    await server.close();
    process.env['MUSTERD_SUPERSEDE_GRACE_MS'] = '120';
    try {
      server = createServer({ db, port: 0 });
      const { port } = await server.listen();
      base = `http://127.0.0.1:${port}`;

      const a1 = new MusterdClient(adaConfig()); // workspace 'repo'
      let replaced = 0;
      a1.onReplaced = () => {
        replaced++;
      };
      await a1.join();
      expect(a1.joined).toBe(true);

      // A reload successor in the SAME workspace claims and stays connected — proving durable, it reaps
      // the orphaned predecessor after the grace (ADR 092).
      const a2 = new MusterdClient(adaConfig()); // same workspace 'repo'
      await a2.join();
      expect(a2.joined).toBe(true);

      await vi.waitFor(
        () => {
          expect(a1.joined).toBe(false);
          expect(a1.lastJoinError).toMatch(/superseded/i);
          expect(replaced).toBe(1);
        },
        { timeout: 2000 },
      );
      // Terminal: no reconnect, and onReplaced fires exactly once (the successor stays live).
      await delay(200);
      expect(a1.joined).toBe(false);
      expect(a2.joined).toBe(true);
      expect(replaced).toBe(1);

      a1.close();
      a2.close();
    } finally {
      delete process.env['MUSTERD_SUPERSEDE_GRACE_MS'];
    }
  }, 10_000);

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

  // ADR 093: memory saved in one session is delivered as the envelope on the next occupy — the
  // continuity loop end-to-end: save → leave → re-join → envelope (headline, never the body) → read.
  it('seat memory survives the session gap: save, re-occupy delivers the envelope, read the body', async () => {
    const s1 = new MusterdClient(adaConfig());
    await s1.join();
    expect(s1.memory).toBeNull(); // fresh seat — nothing saved yet
    await s1.saveMemory({
      headline: 'mid-refactor, tests red',
      body: 'left off at ws.ts eviction',
    });
    // The save refreshes the client-side envelope, so an already-joined team_join shows the new note.
    expect(s1.memory?.headline).toBe('mid-refactor, tests red');
    s1.leave();
    expect(s1.memory).toBeNull(); // occupy-scoped: released with the seat

    s1.close();

    const s2 = new MusterdClient(adaConfig());
    await s2.join();
    expect(s2.memory).toEqual({
      headline: 'mid-refactor, tests red',
      saved_at: expect.any(Number),
      size_bytes: Buffer.byteLength('left off at ws.ts eviction', 'utf8'),
    });
    const mem = await s2.readMemory();
    expect(mem.headline).toBe('mid-refactor, tests red');
    expect(mem.body).toBe('left off at ws.ts eviction');
    // The envelope is occupy-scoped: releasing the seat clears it (no stale getter while dormant).
    s2.leave();
    expect(s2.memory).toBeNull();
    s2.close();
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

  it('defers exit until an async close (the bounded telemetry flush, ADR 089) settles', async () => {
    let settle!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    const exit = vi.fn();
    const stdin = new EventEmitter() as unknown as Parameters<
      typeof installShutdownHandlers
    >[0]['stdin'];
    installShutdownHandlers({
      close,
      exit,
      stdin,
      signals: new EventEmitter() as unknown as NodeJS.Process,
      transport: {},
    });

    (stdin as unknown as EventEmitter).emit('end');
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled(); // still flushing
    settle();
    await Promise.resolve(); // let the .finally run
    await Promise.resolve();
    expect(exit).toHaveBeenCalledWith(0);
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

  it('TOOL_NAMES equals the server registry (ADR 085 — the guidance:check source of truth)', async () => {
    const client = new MusterdClient(adaConfig());
    const mcp = buildMcpServer(client, adaConfig());
    // The SDK keys its registry by tool name; assert our exported list is exactly what got registered
    // so a tool renamed/added/removed without updating TOOL_NAMES fails here (and thus fails CI).
    const registered = Object.keys(
      (mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ).sort();
    expect(registered).toEqual([...TOOL_NAMES].sort());
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
