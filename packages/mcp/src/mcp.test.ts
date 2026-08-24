import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bind } from './bind.js';
import { findBinding } from './binding.js';
import { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { notReadyMessage } from './tools/format.js';
import {
  autojoin,
  buildMcpServer,
  installShutdownHandlers,
  primerInstructions,
  TOOL_NAMES,
} from './index.js';

let server: RunningServer;
let base: string;
let tokens: Record<string, string> = {};
/**
 * Where the fixture pretends its seat lives — an EMPTY temp dir, never `process.cwd()`.
 *
 * ADR 275 made occupancy follow capture: `refreshAttestation` re-reads `config.bindingDir`'s
 * binding on every heartbeat and rewrites `config.surface` from `session.harness` (else
 * `model_observed.harness`). With `bindingDir: process.cwd()` this suite therefore read the
 * binding of whichever SEAT WORKTREE happened to run it, and the declared `claude-code` below
 * survived only on a claude-code machine.
 *
 * Measured 2026-08-15 at 90af772a: gptbot (codex capture) failed the lifecycle assertion while
 * dolly (claude-code capture) passed it, on the same commit. Anchoring to a dir with no binding
 * makes the declaration stand everywhere, which is what these assertions were always about.
 * Capture-following itself is ADR 275's behaviour and is tested for real in surface-drift.test.ts.
 */
let seatDir: string;

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
  seatDir = mkdtempSync(join(tmpdir(), 'musterd-mcp-seat-'));
});

afterEach(async () => {
  await server.close();
  tokens = {};
  rmSync(seatDir, { recursive: true, force: true });
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
    bindingDir: seatDir,
  };
}

/**
 * The fixture invariant, asserted rather than trusted: this suite's seat must be anchored somewhere
 * with NO capture on disk. Re-point `bindingDir` at `process.cwd()` and this fails immediately on
 * any developer machine — which is the failure mode it exists to stop, because the assertions that
 * depend on it (roster surface, attested model) would otherwise silently answer a question about
 * the runner's own worktree instead of about the code.
 */
it('anchors its seat where nothing is captured — or these assertions read the runner, not the code', () => {
  expect(findBinding(adaConfig().bindingDir!, {})).toBeNull();
});

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

  // SEAT-DROP B (lane 01KYQCF678, ADR 193). A restarted adapter loads with member undefined and a
  // grant in binding.json. When that grant has expired, today's client sets wantPresence=false on
  // refused and never retries — the session reads as a pending presence forever. The grant is an
  // optimisation, not the authenticator: drop it, persist the drop, retry bare. With ADR 146 reseat
  // on, bare reclaim of a held agent seat occupies immediately.
  it('drops an expired grant and re-claims bare — a restarted adapter self-heals (ADR 193)', async () => {
    const { findBinding, saveBinding } = await import('./binding.js');
    const tmp = mkdtempSync(join(tmpdir(), 'musterd-expired-grant-'));
    try {
      await api(
        'POST',
        '/teams/dawn/policy',
        { standing_reseat_known_agents: true },
        tokens['nick'],
      );

      // Occupy once so the seat is held (bound_at) — the reseat policy's "known" signal.
      const boot = { ...adaConfig(), bindingDir: tmp };
      saveBinding(tmp, {
        version: 2,
        server: boot.server,
        team: boot.team,
        agent_key: boot.agent_key!,
        claim: { mode: 'seat', name: 'Ada' },
        grant: boot.grant!,
      });
      const first = new MusterdClient(boot);
      await first.join();
      expect(first.joined).toBe(true);
      first.leave();
      first.close();

      // Poison the grant the way a lapsed resume token poisons a binding after restart.
      server.db.prepare('UPDATE grants SET expires_at = 1 WHERE expires_at IS NULL').run();

      // Fresh process: no member, same expired grant on disk + in config.
      const restarted: McpConfig = {
        ...adaConfig(),
        bindingDir: tmp,
        grant: tokens['ada_grant']!,
      };
      delete (restarted as { member?: string }).member;
      expect(restarted.member).toBeUndefined();
      expect(findBinding(tmp)?.grant).toBe(tokens['ada_grant']);

      const second = new MusterdClient(restarted);
      await second.join();
      expect(second.joined).toBe(true);
      expect(second.member).toBe('Ada');
      // In-memory and on disk: the stale grant is gone so the next restart does not re-poison.
      expect(restarted.grant).toBeUndefined();
      expect(findBinding(tmp)?.grant).toBeUndefined();
      second.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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

  // Probe safety (the supersession ping-pong fix): a harness health probe (`claude mcp get musterd`,
  // doctor, the ADR 060 SessionStart verify) boots the adapter, completes `initialize`, and exits —
  // it never calls a tool. The launch autojoin therefore must NOT fire at build/boot; it fires once,
  // memoized, on the first real tool call. Before this, every probe issued a real one-shot claim that
  // displaced the live same-workspace session milliseconds before dying.
  describe('deferred autojoin (probe safety)', () => {
    // The team_join handler persists a binding to process.cwd() on success — pin cwd to a temp dir so
    // this suite can never write `.musterd/binding.json` into the real repo (it did, once: the very
    // dogfood workspace this fix protects got its binding clobbered by an early run of these tests).
    let tmpCwd: string;
    beforeEach(() => {
      tmpCwd = mkdtempSync(join(tmpdir(), 'musterd-autojoin-'));
      vi.spyOn(process, 'cwd').mockReturnValue(tmpCwd);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      rmSync(tmpCwd, { recursive: true, force: true });
    });

    const toolCb = (mcp: ReturnType<typeof buildMcpServer>, name: string) =>
      (
        mcp as unknown as {
          _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
        }
      )._registeredTools[name]!.handler;
    const stubClient = () =>
      ({
        member: 'Ada',
        roster: async () => ({ members: [] }),
        join: async () => ({ member: 'Ada' }),
        leave: async () => ({}),
      }) as unknown as MusterdClient;

    it('never fires at build time (a probe that only initializes claims nothing)', () => {
      const join = vi.fn(async () => {});
      buildMcpServer(stubClient(), adaConfig(), { onFirstToolCall: join });
      expect(join).not.toHaveBeenCalled();
    });

    it('fires exactly once, on the first real tool call (memoized across calls)', async () => {
      const join = vi.fn(async () => {});
      const mcp = buildMcpServer(stubClient(), adaConfig(), { onFirstToolCall: join });
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      expect(join).toHaveBeenCalledTimes(1);
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      expect(join).toHaveBeenCalledTimes(1);
    });

    it('team_join and team_leave are exempt — an explicit join is not doubled, a leave never joins', async () => {
      const join = vi.fn(async () => {});
      const mcp = buildMcpServer(stubClient(), adaConfig(), { onFirstToolCall: join });
      await Promise.resolve(toolCb(mcp, 'team_join')({})).catch(() => {});
      await Promise.resolve(toolCb(mcp, 'team_leave')({})).catch(() => {});
      expect(join).not.toHaveBeenCalled();
    });

    // THE SEAT-DROP ROOT CAUSE (lane 01KYQBSD93, fault B). Memoizing the attempt rather than the
    // SUCCESS meant one unlucky moment — a daemon bounce, a transient socket error — permanently
    // dormanted the session: every later team_* call answered "you haven't joined the team yet",
    // truthfully, forever, because nothing ever tried again. Retry is the whole fix; probe safety
    // is untouched, since a retry still only happens on a real tool call.
    it('RETRIES on the next tool call when the attempt failed — one bad moment must not dormant the session', async () => {
      let attempt = 0;
      const join = vi.fn(async () => {
        if (++attempt === 1) throw new Error('socket hang up');
      });
      const mcp = buildMcpServer(stubClient(), adaConfig(), { onFirstToolCall: join });
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      expect(join).toHaveBeenCalledTimes(1);
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      expect(join).toHaveBeenCalledTimes(2); // the retry the old memo swallowed
      // …and once it succeeds it is memoized again: no re-join on every subsequent call.
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      expect(join).toHaveBeenCalledTimes(2);
    });

    // A failed autojoin must not fail the tool call that carried it: the tool still runs, and the
    // dormant-guard message is what tells the agent what happened.
    it('a failed attempt does not reject the tool call it rode in on', async () => {
      const join = vi.fn(async () => {
        throw new Error('connection refused');
      });
      const mcp = buildMcpServer(stubClient(), adaConfig(), { onFirstToolCall: join });
      await expect(Promise.resolve(toolCb(mcp, 'team_members')({}))).resolves.toBeDefined();
    });

    // SEAT-DROP FAULT B2 (stanley's live repro, 3x: join → exactly one call ✓ → every later call
    // "you haven't joined"). The ADR 164 liveness ladder demotes a session it judges dead by calling
    // `leave()`, which clears `wantPresence` — and its own comment promises "a dormant adapter comes
    // back on its next tool call". Nothing implemented that: the autojoin memo was already spent by
    // the SUCCESSFUL first join, so the seat stayed released for the life of the process. A tool call
    // is direct evidence the session is alive, which outranks the ladder's inference.
    it('RE-JOINS after the liveness ladder released the seat — the recovery ADR 164 promises', async () => {
      const join = vi.fn(async () => {});
      let held = true;
      const client = {
        ...stubClient(),
        get holdsSeat() {
          return held;
        },
        get releasedByLiveness() {
          return !held;
        },
      } as unknown as MusterdClient;
      const mcp = buildMcpServer(client, adaConfig(), { onFirstToolCall: join });
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      expect(join).toHaveBeenCalledTimes(1);
      held = false; // the heartbeat's attestSession → leave()
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      expect(join).toHaveBeenCalledTimes(2);
    });

    // …but an EXPLICIT team_leave must stay left. Re-arming on "no longer holds a seat" alone would
    // silently undo the one thing `leave` means, on the very next tool call.
    it('does NOT re-join after a deliberate leave — only a liveness demotion re-arms', async () => {
      const join = vi.fn(async () => {});
      const client = {
        ...stubClient(),
        get holdsSeat() {
          return false;
        },
        get releasedByLiveness() {
          return false; // released on purpose, not by the ladder
        },
      } as unknown as MusterdClient;
      const mcp = buildMcpServer(client, adaConfig(), { onFirstToolCall: join });
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      expect(join).toHaveBeenCalledTimes(1);
    });

    // …and the guard must SAY so. A transport-level failure rejects `join()` before any error frame
    // arrives, so nothing used to record it and the dormant message degraded to a bare "call
    // team_join first" — which reads as "you forgot to join", not "your join failed". That is what
    // sent the seat-drop investigation chasing binding.json and ADR 143 for a day.
    it('records a transport-level autojoin failure so the dormant guard explains itself', async () => {
      // A session that already knows its seat (binding-named) and autojoins — izzo's exact shape.
      const cfg: McpConfig = {
        ...adaConfig(),
        server: 'http://127.0.0.1:1', // nothing listening: a transport failure, not a refusal frame
        member: 'Ada',
        autojoin: true,
      };
      const client = new MusterdClient(cfg);
      await expect(autojoin(client, cfg)).rejects.toThrow();
      expect(client.lastJoinError).toBeTruthy();
      expect(notReadyMessage(client, 'send')).toContain('the last join attempt failed');
      client.close();
    });

    // The two re-arm tests above stub `releasedByLiveness` and inject `join` as `onFirstToolCall`, so
    // they prove the WRAPPER honours the flag and prove nothing about what the real `onFirstToolCall`
    // — `autojoin()` — does when it fires. This one goes end to end through a real server, a real
    // client and a real ladder demotion, because that is where the promise broke in the field: on
    // 2026-08-05 two consecutive `team_send` calls after a demotion stayed dormant, byte-identical
    // refusals, and only an explicit `team_join` recovered (izzo, then dolly on a different seat).
    //
    // The mechanism: `config.member` is set ONLY by the `occupied` frame, so `isClaimedConfig` is
    // false at every boot and true only after a successful occupy. That makes the `isClaimedConfig`
    // branch of `autojoin()` unreachable at boot and reachable ONLY on the re-arm — and there it
    // consults `config.autojoin`, a BOOT policy that defaults to false. So the very success of the
    // first join is what disarms the recovery, for every seat whose binding has no `autojoin` key.
    // Silently: the branch returns without throwing, so nothing is caught, nothing is recorded, and
    // the dormant guard keeps repeating the ladder's "the next one re-joins" forever.
    it('RE-OCCUPIES the seat after a real ladder demotion — through autojoin(), not a stub', async () => {
      const cfg = adaConfig(); // no `autojoin` key: the default, and izzo's + dolly's exact shape
      const client = new MusterdClient(cfg);
      const mcp = buildMcpServer(client, cfg, { onFirstToolCall: () => autojoin(client, cfg) });

      // 1. First tool call → boot autojoin → claim + occupy. This is the step that sets config.member.
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      await delay(150);
      expect(client.joined).toBe(true);
      expect(cfg.member).toBe('Ada');

      // 2. The ADR 164 ladder demotes on inference. Only the verdict SOURCE is faked — the release
      //    itself runs for real: leave(), the flag, the agent-facing message.
      (client as unknown as { session: { check: () => unknown } }).session = {
        check: () => ({ verdict: 'dormant', rung: 'ended' }),
      };
      (client as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 60_000;
      expect((client as unknown as { attestSession: () => boolean }).attestSession()).toBe(true);
      expect(client.joined).toBe(false);
      expect(client.releasedByLiveness).toBe(true);

      // 3. A tool call is first-hand evidence the session is alive, and ADR 164's own message
      //    promises it is enough: "a tool call is evidence otherwise, so the next one re-joins".
      await Promise.resolve(toolCb(mcp, 'team_members')({})).catch(() => {});
      await delay(150);
      expect(client.joined).toBe(true);
      client.close();
    });
  });

  it('serves the primer as MCP instructions — file-free onboarding (ADR 012 follow-up)', () => {
    // A provisioned session names its seat.
    const named = primerInstructions(adaConfig());
    expect(named).toContain('## Your musterd team');
    expect(named).toContain('**Ada** on the **dawn** Team');
    expect(named).toContain('team_inbox_check');

    // Before occupancy, a fixed seat policy is still a process-local Member target.
    const targeted = primerInstructions({
      server: base,
      team: 'dawn',
      claim: { mode: 'seat', name: 'Lin' },
    });
    expect(targeted).toContain('**Lin** on the **dawn** Team');
    for (const forbidden of ['backend', 'own the data layer', 'supabase']) {
      expect(targeted).not.toContain(forbidden);
    }

    // An unclaimed session (no member) is told to claim a seat first.
    const unclaimed = primerInstructions({ server: base, team: 'dawn' });
    expect(unclaimed).toContain('claim your seat first');
    expect(unclaimed).not.toContain('You are **');
  });
});

/**
 * The seat drop (reported by miley, independently hit by izzo): `team_join` succeeds, and the next
 * `team_*` call refuses with "you haven't joined the team yet". `musterd whoami` is correct,
 * binding.json is healthy, and `musterd status` shows the seat ONLINE the whole time — the daemon
 * and the CLI agree, and only the MCP adapter thinks the seat is gone.
 *
 * The conflation under it: `joined` is pure WEBSOCKET state (`ws.on('close')` clears it, then
 * `scheduleReconnect` backs off 1s → 30s), while every acting tool gates on it. But acts do not
 * travel over that socket — `sendEnvelope` is an HTTP POST. So during any reconnect window the
 * adapter refuses an operation that would have succeeded, and blames the agent's identity for a
 * transport blip. miley lost a handoff note to exactly this.
 */
describe('seat drop — a closed socket is not a lost seat', () => {
  it('acts still work over HTTP while the socket is down, so refusing them is gratuitous', async () => {
    const client = new MusterdClient(adaConfig());
    await bind(client);
    await client.join();
    expect(client.joined).toBe(true);
    expect(client.member).toBe('Ada');

    // Exactly what a daemon bounce does to every attached adapter: the socket closes underneath a
    // session that still holds its seat. No leave(), no supersede — the seat is untouched.
    (client as unknown as { ws: { close(): void } | null }).ws?.close();
    await vi.waitFor(() => expect(client.joined).toBe(false));

    // The seat is STILL HELD server-side — this is the split miley reported: daemon says online,
    // adapter says you never joined.
    expect(client.member).toBe('Ada');

    // And the act the tool would have refused succeeds over HTTP, with the socket still down.
    const envelope = {
      id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      from: 'Ada',
      to: { kind: 'team' as const },
      act: 'status_update' as const,
      body: 'sent while the websocket was closed',
      ts: Date.now(),
    };
    await expect(client.sendEnvelope(envelope as never)).resolves.toBeDefined();

    client.close();
  });

  it('team_send REFUSES that same act — the bug, and how miley lost a handoff note', async () => {
    const client = new MusterdClient(adaConfig());
    await bind(client);
    await client.join();
    const mcp = buildMcpServer(client, { ...adaConfig(), member: 'Ada' });
    const send = (
      mcp as unknown as {
        _registeredTools: Record<string, { handler: (...a: unknown[]) => Promise<unknown> }>;
      }
    )._registeredTools['team_send']!.handler;

    (client as unknown as { ws: { close(): void } | null }).ws?.close();
    await vi.waitFor(() => expect(client.joined).toBe(false));

    const res = (await send({ act: 'status_update', body: 'this must not be swallowed' }, {})) as {
      content: { text: string }[];
    };
    const text = res.content[0]!.text;

    // The seat is held, the daemon is up, and the act travels over HTTP — yet the tool refuses,
    // and blames the agent's identity ("call team_join first") for a closed socket.
    expect(text).not.toMatch(/haven't joined the team yet|pending presence/);

    client.close();
  });

  it('still refuses a session that never occupied — a pending presence is not a seat', async () => {
    const client = new MusterdClient(adaConfig());
    await bind(client); // bound, never joined: member unset
    const mcp = buildMcpServer(client, adaConfig());
    const send = (
      mcp as unknown as {
        _registeredTools: Record<string, { handler: (...a: unknown[]) => Promise<unknown> }>;
      }
    )._registeredTools['team_send']!.handler;

    const res = (await send({ act: 'status_update', body: 'x' }, {})) as {
      content: { text: string }[];
    };
    expect(res.content[0]!.text).toMatch(/pending presence|haven't joined/);
    client.close();
  });

  it('still refuses after a deliberate leave — giving up the seat is not a socket blip', async () => {
    const client = new MusterdClient(adaConfig());
    await bind(client);
    await client.join();
    const mcp = buildMcpServer(client, { ...adaConfig(), member: 'Ada' });
    const send = (
      mcp as unknown as {
        _registeredTools: Record<string, { handler: (...a: unknown[]) => Promise<unknown> }>;
      }
    )._registeredTools['team_send']!.handler;

    client.leave(); // member stays set, but the seat is genuinely released
    const res = (await send({ act: 'status_update', body: 'x' }, {})) as {
      content: { text: string }[];
    };
    expect(res.content[0]!.text).toMatch(/haven't joined the team yet/);
    client.close();
  });
});
