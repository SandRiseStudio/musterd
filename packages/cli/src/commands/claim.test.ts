import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  BindingSchema,
  PENDING_DIR,
  RESOLVED_SUFFIX,
} from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient, watchClaim } from '../client.js';
import { saveBinding, wsBase } from '../config.js';
import { writePending } from '../onboard/pending.js';
import { claimCommand } from './claim.js';
import { WAIT_TIMEOUT_EXIT } from './inbox.js';

let server: RunningServer;
let dir: string;
let cwd: string;
let serverUrl: string;
let agentKey: string; // team agent key (mskey_) from the composite mint
let adminToken: string; // nick's creator seat token (mskd_, untouched authMember path → admin)

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  serverUrl = `http://127.0.0.1:${port}`;
  process.env['MUSTERD_SERVER'] = serverUrl;
  dir = mkdtempSync(join(tmpdir(), 'musterd-claim-'));
  process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
  cwd = mkdtempSync(join(tmpdir(), 'musterd-claim-cwd-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  // Pin the workspace label so it's deterministic (the temp cwd isn't a git repo) and markers can be
  // written with a matching `workspace` for the claim's workspace-scoped pending filter.
  process.env['MUSTERD_WORKSPACE'] = 'ws-here';
  // Stand up the team; capture the v0.3 composite mint (SPEC A.7): the team agent key + the creator's
  // human credential (mscr_). Post-cutover (ADR 069) nick authenticates with the credential; the mskd_
  // creator token no longer authenticates, so the admin (grants/declare-seat) calls use the credential.
  const team = (await new HttpClient({ server: serverUrl }).createTeam('dawn', {
    name: 'nick',
  })) as {
    agent_key: string;
    human_credential: string;
  };
  agentKey = team.agent_key;
  adminToken = team.human_credential;
  process.env['MUSTERD_AGENT_KEY'] = agentKey; // claim presents this
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  delete process.env['MUSTERD_SERVER'];
  delete process.env['MUSTERD_CONFIG'];
  delete process.env['MUSTERD_TEAM'];
  delete process.env['MUSTERD_AGENT_KEY'];
  delete process.env['MUSTERD_WORKSPACE'];
});

async function run(argv: string[]) {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
    chunks.push(String(c));
    return true;
  });
  try {
    const code = await claimCommand(parseArgs(argv));
    return { code, out: chunks.join('') };
  } finally {
    spy.mockRestore();
  }
}

function readBinding() {
  return BindingSchema.parse(
    JSON.parse(readFileSync(join(cwd, BINDING_DIR, BINDING_FILE), 'utf8')),
  );
}

/** Admin (nick) declares a seat (so a named claim has a target) — auth via the creator mskd_ token. */
async function declareSeat(name: string, role?: string): Promise<void> {
  await new HttpClient({ server: serverUrl, key: adminToken, seat: 'nick' }).addMember('dawn', {
    name,
    kind: 'agent',
    ...(role ? { role } : {}),
  });
}

/** Admin (nick) issues a standing grant for a seat/role so a claim occupies immediately. */
async function grant(target: string, scope: 'seat' | 'role' = 'seat'): Promise<string> {
  const res = await fetch(`${serverUrl}/teams/dawn/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ scope, target, lifetime: 'standing' }),
  });
  return ((await res.json()) as { token: string }).token;
}

/**
 * Hold a seat durably live via an open `watchClaim` session (heartbeating WS) — as a *real* live agent
 * does. A one-shot `claimCommand` closes its socket the instant it resolves, so the seat is live for
 * <50ms; relying on that window is the race that flaked the clobber-guard test under CI timing (ADR
 * 104). The returned session both occupies+binds the folder (its `onOccupied` saves the binding) and
 * keeps the seat online until closed. Resolves once the roster reads the seat live.
 */
async function holdSeatLive(name: string, grant: string): Promise<{ close: () => void }> {
  let onBound!: () => void;
  const bound = new Promise<void>((r) => (onBound = r));
  const session = watchClaim({
    wsUrl: wsBase(serverUrl) + '/ws',
    team: 'dawn',
    key: agentKey,
    target: { seat: name },
    surface: 'cli',
    workspace: 'ws-here',
    grant,
    // Write the folder binding ourselves (as claimCommand would) so this is the *only* session that
    // occupies the seat — a second occupy from a one-shot `run()` would race its own close() against
    // this hold and drop the presence.
    onOccupied: (seat) => {
      saveBinding(process.cwd(), {
        server: serverUrl,
        team: 'dawn',
        agent_key: agentKey,
        surface: 'cli',
        claim: { mode: 'seat', name: seat.name },
        grant,
      });
      onBound();
    },
  });
  try {
    await Promise.all([bound, waitLive(name)]); // occupied+bound AND visibly live before we proceed
  } catch (e) {
    session.close();
    throw e;
  }
  return session;
}

/** Poll the roster until `name` reads live (mirrors the guard's own liveness predicate). */
async function waitLive(name: string): Promise<void> {
  const client = new HttpClient({ server: serverUrl, key: adminToken, seat: 'nick' });
  for (let i = 0; i < 200; i++) {
    const { members } = await client.roster('dawn');
    const m = members.find((x) => x.name === name);
    if (m && (m.presence !== 'offline' || (m.activity != null && m.activity !== 'offline'))) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${name} never became live on the roster`);
}

/** Poll for the first pending request (admin view) — the CLI opens it asynchronously over WS. */
async function firstPendingRequestId(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${serverUrl}/teams/dawn/requests?status=pending`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const { requests } = (await res.json()) as { requests: { id: string }[] };
    if (requests[0]) return requests[0].id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no pending request appeared');
}

/** Admin (nick) decides a pending request. */
async function decide(
  requestId: string,
  body: { decision: 'approve'; lifetime: 'once' | 'ttl' | 'standing' } | { decision: 'deny' },
): Promise<void> {
  await fetch(`${serverUrl}/teams/dawn/requests/${requestId}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(body),
  });
}

describe('musterd claim (v0.3 handshake, ADR 075)', () => {
  it('claims a named seat with a grant → occupies + binds the folder (agent_key, no token)', async () => {
    await declareSeat('Ada');
    const g = await grant('Ada');
    const { code, out } = await run(['Ada', '--team', 'dawn', '--grant', g]);
    expect(code).toBe(0);
    expect(out).toContain('Ada');
    const b = readBinding();
    expect(b.agent_key).toBe(agentKey);
    expect(b.member).toBeUndefined(); // v0.3: no member/token in the binding
    expect(b.token).toBeUndefined();
    expect(b.claim).toEqual({ mode: 'seat', name: 'Ada' });
  });

  it('errors clearly when no agent key is available', async () => {
    delete process.env['MUSTERD_AGENT_KEY'];
    await expect(run(['Ada', '--team', 'dawn'])).rejects.toMatchObject({ exitCode: 4 });
  });

  it('without a grant, a claim opens a pending request and waits — times out if never approved', async () => {
    await declareSeat('Ada');
    await expect(run(['Ada', '--team', 'dawn', '--timeout', '1'])).rejects.toMatchObject({
      exitCode: WAIT_TIMEOUT_EXIT,
    });
    // No binding is written for a pending claim that was never approved.
    expect(existsSync(join(cwd, BINDING_DIR, BINDING_FILE))).toBe(false);
  }, 10_000);

  it('a pending claim resolves once an admin approves the request (ADR 077)', async () => {
    await declareSeat('Ada');
    const claiming = run(['Ada', '--team', 'dawn', '--timeout', '5']);
    const requestId = await firstPendingRequestId();
    await decide(requestId, { decision: 'approve', lifetime: 'once' });

    const { code, out } = await claiming;
    expect(code).toBe(0);
    expect(out).toContain('Ada');
    expect(readBinding().claim).toEqual({ mode: 'seat', name: 'Ada' });
  }, 10_000);

  it('a ttl approval delivers a resume token that lands in binding.grant (ADR 087)', async () => {
    await declareSeat('Ada');
    const claiming = run(['Ada', '--team', 'dawn', '--timeout', '5']);
    const requestId = await firstPendingRequestId();
    // A ttl approval is the resume-friendly default — it mints a reusable grant + delivers its token.
    await decide(requestId, { decision: 'approve', lifetime: 'ttl' });

    const { code } = await claiming;
    expect(code).toBe(0);
    const b = readBinding();
    expect(b.claim).toEqual({ mode: 'seat', name: 'Ada' });
    // The resume token is persisted so a reconnect re-occupies without another approval.
    expect(b.grant).toMatch(/^msgr_/);
  }, 10_000);

  it('a bare claim reports identity (no re-claim) when the seat is already live in this workspace (ADR 087)', async () => {
    await declareSeat('Ada');
    const g = await grant('Ada');
    // Hold Ada live from THIS workspace via a persistent session (stands in for the folder's adapter).
    const held = watchClaim({
      wsUrl: wsBase(serverUrl) + '/ws',
      team: 'dawn',
      key: agentKey,
      target: { seat: 'Ada' },
      surface: 'claude-code',
      workspace: 'ws-here',
      grant: g,
      onDeliver: () => {},
    });
    try {
      // Wait until Ada shows online in ws-here.
      for (let i = 0; i < 50; i++) {
        const { members } = await new HttpClient({ server: serverUrl }).roster('dawn');
        const ada = members.find((m) => m.name === 'Ada');
        if (ada?.presences.some((p) => p.status !== 'offline' && p.workspace === 'ws-here')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // Bind this folder to Ada, then a bare `claim` should just confirm — not re-run the handshake.
      saveBinding(cwd, {
        server: serverUrl,
        team: 'dawn',
        agent_key: agentKey,
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'Ada' },
        grant: g,
      });
      const { code, out } = await run([]);
      expect(code).toBe(0);
      expect(out).toMatch(/already live/i);
      expect(out).toContain('Ada');
    } finally {
      held.close();
    }
  }, 10_000);

  it('claims the next open pool seat for a role (server-resolved)', async () => {
    await declareSeat('backend-1', 'backend');
    const g = await grant('backend', 'role');
    const { code } = await run(['--role', 'backend', '--team', 'dawn', '--grant', g]);
    expect(code).toBe(0);
    // the resolved seat is recorded as the folder's standing seat policy
    expect(readBinding().claim).toMatchObject({ mode: 'seat' });
  });

  it('uses the folder claim policy when no target is given', async () => {
    await declareSeat('Polly');
    const g = await grant('Polly');
    saveBinding(cwd, {
      server: serverUrl,
      team: 'dawn',
      agent_key: agentKey,
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'Polly' },
      grant: g,
    });
    const { code } = await run([]);
    expect(code).toBe(0);
    expect(readBinding().claim).toEqual({ mode: 'seat', name: 'Polly' });
  });

  it('refuses a claim presenting an invalid grant (ADR 075/078)', async () => {
    await declareSeat('Ada');
    // A bogus grant token can't authorize the claim → the server refuses it.
    await expect(
      run(['Ada', '--team', 'dawn', '--grant', 'msgr_bogusbogusbogus']),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('refuses to clobber a folder bound to a currently-live different seat (ADR 066)', async () => {
    await declareSeat('Ada');
    await declareSeat('Bob');
    // Hold Ada live with an open session (a real live seat holds an open WS) — this occupies the seat,
    // binds the folder to Ada, and keeps her online, so the guard sees a genuinely-live incumbent
    // rather than the <50ms flicker a one-shot claim leaves behind.
    const ada = await holdSeatLive('Ada', await grant('Ada'));
    try {
      const gb = await grant('Bob');
      await expect(run(['Bob', '--team', 'dawn', '--grant', gb])).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining('musterd agent'),
      });
      expect(readBinding().claim).toEqual({ mode: 'seat', name: 'Ada' }); // untouched
    } finally {
      ada.close();
    }
  });

  it('--force repoints a folder bound to a live seat anyway (ADR 066)', async () => {
    await declareSeat('Ada');
    await declareSeat('Bob');
    await run(['Ada', '--team', 'dawn', '--grant', await grant('Ada')]);
    const { code } = await run(['Bob', '--team', 'dawn', '--grant', await grant('Bob'), '--force']);
    expect(code).toBe(0);
    expect(readBinding().claim).toEqual({ mode: 'seat', name: 'Bob' });
  });

  it('lists waiting sessions and requires --for when several are pending', async () => {
    await declareSeat('Ada');
    const g = await grant('Ada');
    writePending(cwd, {
      code: 'AB12',
      team: 'dawn',
      workspace: 'ws-here',
      surface: 'claude-code',
      connId: 'c1',
      ts: 1,
    });
    writePending(cwd, {
      code: 'CD34',
      team: 'dawn',
      workspace: 'ws-here',
      surface: 'cursor',
      connId: 'c2',
      ts: 2,
    });
    await expect(run(['Ada', '--team', 'dawn', '--grant', g])).rejects.toMatchObject({
      exitCode: 2,
    });
    const ok = await run(['Ada', '--team', 'dawn', '--grant', g, '--for', 'AB12']);
    expect(ok.code).toBe(0);
  });

  it('ignores a pending marker from a different workspace (2026-07-01 dogfood bug)', async () => {
    await declareSeat('Ada');
    const g = await grant('Ada');
    // One marker for *this* workspace, one for a foreign workspace sharing the same `.musterd` dir.
    // Only the local one counts, so a single-target claim proceeds without demanding `--for`.
    writePending(cwd, {
      code: 'MINE',
      team: 'dawn',
      workspace: 'ws-here',
      surface: 'claude-code',
      connId: 'c1',
      ts: 1,
    });
    writePending(cwd, {
      code: 'THEIRS',
      team: 'dawn',
      workspace: 'someone-elses-ws',
      surface: 'claude-code',
      connId: 'c2',
      ts: 2,
    });
    const ok = await run(['Ada', '--team', 'dawn', '--grant', g]);
    expect(ok.code).toBe(0);
    // The claim resolved this workspace's marker (going online), never the foreign one.
    expect(ok.out).toContain('Ada');
  });

  it('hands the seat to a waiting session via a resolution sidecar carrying the seat (ADR 034)', async () => {
    await declareSeat('Ada');
    const g = await grant('Ada');
    writePending(cwd, {
      code: 'AB12',
      team: 'dawn',
      workspace: 'ws-here',
      surface: 'claude-code',
      connId: 'c1',
      ts: 1,
    });
    const { out } = await run(['Ada', '--team', 'dawn', '--grant', g, '--for', 'AB12']);
    expect(out).toContain('going online as Ada now');
    expect(existsSync(join(cwd, BINDING_DIR, PENDING_DIR, 'AB12.json'))).toBe(false);
    const resolved = JSON.parse(
      readFileSync(join(cwd, BINDING_DIR, PENDING_DIR, `AB12${RESOLVED_SUFFIX}`), 'utf8'),
    );
    expect(resolved.seat).toBe('Ada'); // v0.3: the resolution carries the seat, not member+token
  });
});
