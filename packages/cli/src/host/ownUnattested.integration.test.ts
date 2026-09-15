import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { MemberSummary, WakeOrder } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient, watchClaim } from '../client.js';
import { claimCommand } from '../commands/claim.js';
import { wsBase } from '../config.js';
import type { ActuatorBackend, VerifyResult } from './backend.js';
import { pollHostOnce, type WakeClient } from './loop.js';
import type { HostRegistryEntry } from './registry.js';

/**
 * ADR 379 end-to-end, against a REAL daemon — the falsifier `loop.test.ts` cannot be.
 *
 * The unit tests stub the roster, so they prove the verifier's judgement and nothing about the two
 * facts the judgement rests on, both of which live outside the CLI package:
 *
 *   1. the daemon actually SERIALIZES `attached_at` onto the presence it returns (a `presence.
 *      created_at` that never reached the wire would make `own_unattested` dead code, silently);
 *   2. the label the actuator computes from the spawn path is BYTE-EQUAL to the one a real client
 *      attaches with — ADR 379 §Decision 4 rests on that and a stubbed row cannot test it, because
 *      the stub author types both sides.
 *
 * So this stands a real server, attaches a real lease-less presence with a real `musterd claim
 * --detach` (ADR 377), and runs the real `verifyOccupied` over the real roster. Only the wake lease
 * is synthetic: minting one needs a due act and a residency enrolment, and the lease's identity is
 * not what is under test here — the roster read is.
 *
 * Measured live on 2026-09-04 before this was written: the deployed daemon (build e5c74b4e) does
 * serve `attached_at` on every presence, and for a seat still on its attach branch the actuator's
 * label matches the row's exactly. The branch-drift case is the known ADR 368 hazard and is out of
 * reach here by construction — a wake child attaches inside the 90s verify window, so its label and
 * the actuator's are computed seconds apart from one path.
 *
 * The first run of this file is what found the defect its sibling lane fixes: `presence.workspace`
 * came back `null`, because the stateless HTTP claim's body schema had never accepted the field.
 */

let server: RunningServer;
let configDir: string;
let workspace: string;
let serverUrl: string;
let agentKey: string;
let adminToken: string;

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  serverUrl = `http://127.0.0.1:${port}`;
  process.env['MUSTERD_SERVER'] = serverUrl;
  configDir = mkdtempSync(join(tmpdir(), 'musterd-own-cfg-'));
  process.env['MUSTERD_CONFIG'] = join(configDir, 'config.json');
  // The seat's workspace. Deliberately NOT pinned with MUSTERD_WORKSPACE: the whole point is that
  // both sides derive the label from this path independently, the way they do on the real rail.
  workspace = mkdtempSync(join(tmpdir(), 'musterd-own-ws-'));
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  const team = (await new HttpClient({ server: serverUrl }).createTeam('dawn', {
    name: 'nick',
  })) as { agent_key: string; human_credential: string };
  agentKey = team.agent_key;
  adminToken = team.human_credential;
  process.env['MUSTERD_AGENT_KEY'] = agentKey;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  delete process.env['MUSTERD_SERVER'];
  delete process.env['MUSTERD_CONFIG'];
  delete process.env['MUSTERD_AGENT_KEY'];
});

async function declareSeat(name: string): Promise<void> {
  await new HttpClient({ server: serverUrl, key: adminToken, seat: 'nick' }).addMember('dawn', {
    name,
    kind: 'agent',
  });
}

async function grantFor(target: string): Promise<string> {
  const res = await fetch(`${serverUrl}/teams/dawn/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ scope: 'seat', target, lifetime: 'standing' }),
  });
  return ((await res.json()) as { token: string }).token;
}

/** The real roster off the real daemon; only the lease poll and the reports are synthetic. */
function wakeClientOverRealRoster(orders: WakeOrder[]): WakeClient {
  const http = new HttpClient({ server: serverUrl, key: agentKey, seat: 'nick' });
  return {
    wakeLeases: async () => ({ orders }),
    wakeReport: async () => ({ ok: true }),
    wakeProgress: async () => ({ ok: true }),
    roster: (team: string): Promise<{ members: MemberSummary[] }> => http.roster(team),
  };
}

/** Run one poll tick whose backend does nothing but ask the real verifier, at `sinceTs`. */
async function verifyVia(sinceTs: number): Promise<VerifyResult> {
  let verified: VerifyResult | undefined;
  const backend: ActuatorBackend = {
    harness: 'claude-code',
    wake: async (_spec, ctx) => {
      verified = await ctx.verifyOccupied('bo', 300, sinceTs);
      return { outcome: { occupied: verified.occupied }, settled: Promise.resolve(undefined) };
    },
  };
  const entry: HostRegistryEntry = {
    server: serverUrl,
    team: 'dawn',
    seat: 'bo',
    workspace,
    harness: 'claude-code',
    host: 'mac.lan',
    updated_at: 1,
  };
  await pollHostOnce({
    backends: new Map([['claude-code', backend]]),
    bounds: { timeout_ms: 60_000 },
    log: () => undefined,
    readAgentKey: () => agentKey,
    liveness: () => ({ state: 'none' }),
    verifyWindowMs: 300,
    verifyPollMs: 20,
    loadRegistry: () => ({ entries: [entry] }),
    clientFor: () =>
      wakeClientOverRealRoster([
        {
          lease_id: 'L-own',
          seat: 'bo',
          act_id: 'A1',
          act: 'request_help',
          sender: 'nick',
          lane: 'immediate',
          composed_line: 'musterd wake — you are seat "bo" on team "dawn": …',
          expires_at: Date.now() + 120_000,
        },
      ]),
  });
  return verified!;
}

describe('ADR 379 against a real daemon — the actuator recognises its own unattesting child', () => {
  it('a real lease-less presence in the spawn workspace, attached after the spawn, reads own_unattested', async () => {
    await declareSeat('bo');
    const grant = await grantFor('bo');
    const spawnedAt = Date.now();
    // A REAL attach: `claim --detach` leaves a Presence with no session lease and no wake lease,
    // carrying the label it derived from `workspace` itself — exactly the row a woken child that
    // could not read its lease would leave behind (ADR 354's codex class).
    const code = await claimCommand(
      parseArgs([
        'bo',
        '--team',
        'dawn',
        '--grant',
        grant,
        '--surface',
        'codex',
        '--detach',
        '--json',
      ]),
    );
    expect(code).toBe(0);

    // The row the daemon actually returns carries the two fields the judgement reads, and its
    // workspace label is the one the actuator will independently compute from the same path.
    const { members } = await new HttpClient({
      server: serverUrl,
      key: agentKey,
      seat: 'nick',
    }).roster('dawn');
    const presence = members.find((m) => m.name === 'bo')!.presences[0]!;
    expect(presence.workspace).toBe(basename(workspace));
    expect(presence.wake_lease ?? null).toBeNull();
    expect(typeof presence.attached_at).toBe('number');

    const verified = await verifyVia(spawnedAt);
    // `provenance` is null, not 'session': the same stateless route drops that field too — the same
    // class as the workspace gap this lane fixed, deliberately left alone here because ADR 379's
    // judgement never reads provenance (it reads workspace, attached_at, and the ABSENCE of a
    // lease). Recorded on the lane as the neighbouring gap, not fixed under a workspace heading.
    expect(verified).toEqual({
      occupied: true,
      provenance: null,
      lease_matched: false,
      own_unattested: true,
    });
  });

  it('the SAME real row is foreign to a wake that spawned after it — the before-spawn control', async () => {
    await declareSeat('bo');
    const grant = await grantFor('bo');
    const code = await claimCommand(
      parseArgs([
        'bo',
        '--team',
        'dawn',
        '--grant',
        grant,
        '--surface',
        'codex',
        '--detach',
        '--json',
      ]),
    );
    expect(code).toBe(0);

    // Same presence, same workspace — only the spawn clock moves. A row created BEFORE this wake
    // spawned is an occupant that was already there (the ADR 068 human-in-the-workspace case), and
    // must still defer and still be killed. This is the control that keeps ADR 379 narrow.
    const verified = await verifyVia(Date.now() + 30_000);
    expect(verified.own_unattested).toBeUndefined();
    expect(verified.lease_matched).toBe(false);
  });
});

describe('the stateless claim carries its workspace (ADR 014/092/368)', () => {
  const detachArgs = (grant: string) => [
    'bo',
    '--team',
    'dawn',
    '--grant',
    grant,
    '--surface',
    'codex',
    '--detach',
    '--json',
  ];

  it('a re-claim of the same workspace REPLACES its own socketless row rather than piling one up', async () => {
    await declareSeat('bo');
    const grant = await grantFor('bo');
    const http = new HttpClient({ server: serverUrl, key: agentKey, seat: 'nick' });
    expect(await claimCommand(parseArgs(detachArgs(grant)))).toBe(0);
    const first = (await http.roster('dawn')).members.find((m) => m.name === 'bo')!.presences[0]!;
    expect(first.workspace).toBe(basename(workspace));

    // The a11y fixture re-claims every few seconds to hold a Presence (ADR 377). A socketless row in
    // THIS folder is the previous detached attach and this claim is its successor — one row, not a
    // row per heartbeat, and not the pre-2026-09-04 behaviour of clearing every seat row blindly.
    expect(await claimCommand(parseArgs(detachArgs(grant)))).toBe(0);
    const after = (await http.roster('dawn')).members.find((m) => m.name === 'bo')!.presences;
    expect(after.map((p) => p.workspace)).toEqual([basename(workspace)]);
  });

  it('a detached claim does NOT evict a LIVE session in the same workspace (ADR 092)', async () => {
    await declareSeat('bo');
    const grant = await grantFor('bo');
    const http = new HttpClient({ server: serverUrl, key: agentKey, seat: 'nick' });
    // A real socket, holding the seat from this same folder — what a working session is.
    const label = basename(workspace);
    const held = await new Promise<{ close: () => void }>((resolve) => {
      const session = watchClaim({
        wsUrl: wsBase(serverUrl) + '/ws',
        team: 'dawn',
        key: agentKey,
        target: { seat: 'bo' },
        surface: 'claude-code',
        workspace: label,
        workspace_key: workspace,
        grant,
        onOccupied: () => resolve({ close: () => session.close() }),
      });
    });
    try {
      const before = (await http.roster('dawn')).members.find((m) => m.name === 'bo')!.presences;
      expect(before.some((p) => p.surface === 'claude-code')).toBe(true);

      // Before 2026-09-04 this route could not compare workspaces, so it evicted unconditionally:
      // `claim --detach` in your own folder killed the session sitting in it.
      expect(await claimCommand(parseArgs(detachArgs(grant)))).toBe(0);
      const after = (await http.roster('dawn')).members.find((m) => m.name === 'bo')!.presences;
      expect(after.some((p) => p.surface === 'claude-code')).toBe(true);
    } finally {
      held.close();
    }
  });
});
