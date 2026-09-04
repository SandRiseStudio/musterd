import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args.js';
import { HttpClient, watchClaim } from './client.js';
import { claimCommand } from './commands/claim.js';
import { reachabilityNudge, resolve, resolveRead } from './commands/helpers.js';
import { inboxCommand } from './commands/inbox.js';
import { joinCommand } from './commands/join.js';
import { nudgeCommand } from './commands/nudge.js';
import { reclaimCommand } from './commands/reclaim.js';
import { sendCommand } from './commands/send.js';
import { captureSession } from './commands/session.js';
import { statusCommand } from './commands/status.js';
import { teamCommand } from './commands/team.js';
import { whoamiCommand } from './commands/whoami.js';
import { wireCommand } from './commands/wire.js';
import { loadConfig, saveBinding } from './config.js';
import { cachedTeamLive } from './onboard/init.js';
import { sessionDigest } from './session/digest.js';
import { claimAgentHttp } from './test-auth.js';

let server: RunningServer;
let dir: string;
let nickConfig: string;
let cwdDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), 'musterd-cli-'));
  nickConfig = join(dir, 'nick.json');
  process.env['MUSTERD_CONFIG'] = nickConfig;
  // The creating folder is now auto-bound (ADR 036), so each test gets its own throwaway cwd — both
  // to absorb that binding write and to give the team creator (nick) an *active* folder to act from.
  cwdDir = mkdtempSync(join(tmpdir(), 'musterd-cwd-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
  delete process.env['MUSTERD_SERVER'];
  delete process.env['MUSTERD_CONFIG'];
  actAsNobody();
});

/** Act explicitly as a member via `MUSTERD_*` env — the way a second member (its own session) acts
 *  from someone else's folder now that an ambient global-config identity can only read (ADR 036). */
function actAs(team: string, member: string, token: string, sessionLease?: string): void {
  process.env['MUSTERD_TEAM'] = team;
  // v0.3 (ADR 075): the env carries the Bearer secret (here the member's mskd_ seat token, on the
  // untouched authMember path) + the claim target naming the acting seat.
  process.env['MUSTERD_AGENT_KEY'] = token;
  process.env['MUSTERD_CLAIM'] = `seat:${member}`;
  if (sessionLease !== undefined) process.env['MUSTERD_SESSION_LEASE'] = sessionLease;
}
function actAsNobody(): void {
  delete process.env['MUSTERD_TEAM'];
  delete process.env['MUSTERD_AGENT_KEY'];
  delete process.env['MUSTERD_CLAIM'];
  delete process.env['MUSTERD_GRANT'];
  delete process.env['MUSTERD_SESSION_LEASE'];
}

async function claimedAgent(team: string, member: string) {
  const cfg = loadConfig();
  return claimAgentHttp(
    process.env['MUSTERD_SERVER']!,
    team,
    cfg.agentKeys[team]!,
    cfg.identities[team]!.key,
    member,
  );
}

/** Run a command fn with captured stdout. */
async function run(fn: (p: ReturnType<typeof parseArgs>) => Promise<number>, argv: string[]) {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    chunks.push(String(c));
    return true;
  });
  try {
    const code = await fn(parseArgs(argv));
    return { code, out: chunks.join('') };
  } finally {
    spy.mockRestore();
  }
}

describe('CLI end-to-end (ADR 350 legacy bootstrap cutover)', () => {
  it('migrates two Workspaces and one host without interrupting an occupied Presence', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent']);
    await run(teamCommand, ['add', 'Grace', '--kind', 'agent']);
    const config = loadConfig();
    const legacyKey = config.agentKeys['dawn']!;
    const adminCredential = config.identities['dawn']!.key;
    const adaAuth = await claimAgentHttp(
      process.env['MUSTERD_SERVER']!,
      'dawn',
      legacyKey,
      adminCredential,
      'Ada',
    );
    const graceAuth = await claimAgentHttp(
      process.env['MUSTERD_SERVER']!,
      'dawn',
      legacyKey,
      adminCredential,
      'Grace',
    );
    const adaPresence = server.db
      .prepare<[string], { id: string }>(
        `SELECT p.id FROM presence p JOIN members m ON m.id = p.member_id
         WHERE m.name = ? AND p.status = 'online'`,
      )
      .get('Ada')!.id;

    const adaDir = mkdtempSync(join(tmpdir(), 'musterd-ada-'));
    const graceDir = mkdtempSync(join(tmpdir(), 'musterd-grace-'));
    try {
      for (const [workspace, seat, credential] of [
        [adaDir, 'Ada', adaAuth.key],
        [graceDir, 'Grace', graceAuth.key],
      ] as const) {
        saveBinding(workspace, {
          version: 2,
          server: process.env['MUSTERD_SERVER']!,
          team: 'dawn',
          claim: { mode: 'seat', name: seat },
          agent_key: legacyKey,
          seat_credential: credential,
        });
        cwdSpy.mockReturnValue(workspace);
        expect((await run(wireCommand, ['wire', '--migrate-bootstrap'])).code).toBe(0);
      }
      expect(
        server.db
          .prepare<[string], { id: string }>('SELECT id FROM presence WHERE id = ?')
          .get(adaPresence)?.id,
      ).toBe(adaPresence);

      cwdSpy.mockReturnValue(cwdDir);
      const enrolled = await fetch(`${process.env['MUSTERD_SERVER']}/teams/dawn/residency/enroll`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${adminCredential}`,
        },
        body: JSON.stringify({ seat: 'Ada', harness: 'cursor', host: 'mac-studio' }),
      });
      expect(enrolled.status).toBe(201);
      const hostMint = JSON.parse(
        (await run(teamCommand, ['bootstrap', 'mint', '--host', 'mac-studio', '--json'])).out,
      );
      const hostUse = await fetch(
        `${process.env['MUSTERD_SERVER']}/teams/dawn/residency/wake-leases`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${hostMint.agent_key}`,
          },
          body: JSON.stringify({ host: 'mac-studio' }),
        },
      );
      expect(hostUse.status).toBe(200);

      const reseatPolicy = await fetch(`${process.env['MUSTERD_SERVER']}/teams/dawn/policy`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${adminCredential}`,
        },
        body: JSON.stringify({ standing_reseat_known_agents: true }),
      });
      expect(reseatPolicy.status).toBe(200);
      for (const workspace of [adaDir, graceDir]) {
        const binding = JSON.parse(
          readFileSync(join(workspace, '.musterd', 'binding.json'), 'utf8'),
        );
        const claimed = await fetch(`${process.env['MUSTERD_SERVER']}/teams/dawn/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            key: binding.agent_key,
            target: { seat: binding.claim.name },
            surface: 'cli',
          }),
        });
        expect(claimed.status).toBe(200);
      }

      const cutover = await run(teamCommand, ['bootstrap', 'cutover', '--yes', '--json']);
      expect(JSON.parse(cutover.out)).toMatchObject({ ok: true, already_cut_over: false });

      const legacyClaim = await fetch(`${process.env['MUSTERD_SERVER']}/teams/dawn/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: legacyKey,
          target: { seat: 'Ada' },
          surface: 'cli',
        }),
      });
      expect(legacyClaim.status).toBe(403);
      const legacyHost = await fetch(
        `${process.env['MUSTERD_SERVER']}/teams/dawn/residency/wake-leases`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${legacyKey}`,
          },
          body: JSON.stringify({ host: 'mac-studio' }),
        },
      );
      expect(legacyHost.status).toBe(401);
    } finally {
      rmSync(adaDir, { recursive: true, force: true });
      rmSync(graceDir, { recursive: true, force: true });
    }
  });
});

describe('CLI end-to-end (Scenario A: two humans on one team)', () => {
  it('creates a team, adds a second human, exchanges a message', async () => {
    // nick creates dawn
    const created = await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    expect(created.code).toBe(0);
    expect(created.out).toContain('team "dawn" created');

    // nick adds bo — a 2nd human, who gets her own mscr_ credential (ADR 069 cutover)
    const added = await run(teamCommand, ['add', 'bo', '--kind', 'human', '--json']);
    const boToken = JSON.parse(added.out).human_credential as string;
    expect(boToken).toMatch(/^mscr_/);

    // status shows both members
    const status = await run(statusCommand, []);
    expect(status.out).toContain('nick');
    expect(status.out).toContain('bo');

    // nick sends bo a message
    const sent = await run(sendCommand, ['--to', 'bo', '--act', 'message', 'hello', 'bo']);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain('sent');

    // bo (a second human, her own session) reads her inbox — explicit via env (ADR 036).
    actAs('dawn', 'bo', boToken);

    const inbox1 = await run(inboxCommand, []);
    expect(inbox1.out).toContain('1 unread');
    expect(inbox1.out).toContain('hello bo');

    // reading advanced the cursor → second read shows 0 unread
    const inbox2 = await run(inboxCommand, []);
    expect(inbox2.out).toContain('0 unread');
  });

  it('reports an empty inbox with the canonical string', async () => {
    await run(teamCommand, ['create', 'solo', '--as', 'nick']);
    await run(teamCommand, ['add', 'pat', '--kind', 'human']);
    // pat has received nothing
    const added = await run(teamCommand, ['add', 'pat2', '--kind', 'human', '--json']);
    const tok = JSON.parse(added.out).human_credential as string;
    actAs('solo', 'pat2', tok);
    const inbox = await run(inboxCommand, []);
    expect(inbox.out).toContain("inbox empty — nobody's mustered anything yet");
  });
});

describe('CLI ask contract parity (ADR 147 / finding 006 item 3)', () => {
  it('hands a CLI ask-raiser the same wait/hold marching orders the MCP send returns', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);

    // Human output carries the shared askContractText — the CLI is no longer silent about the contract.
    const ask = await run(sendCommand, [
      '--to',
      '@team',
      '--act',
      'ask',
      '--meta',
      'species=approve',
      '--meta',
      'tier=blocking',
      'ship the migration?',
    ]);
    expect(ask.code).toBe(0);
    expect(ask.out).toContain('sent');
    expect(ask.out).toContain('HOLD');
    expect(ask.out).toContain("meta.ask_outcome='held'");
    expect(ask.out).toContain('15m');

    // --json is additive + id-preserving: the derived ask_contract rides alongside the envelope.
    const askJson = await run(sendCommand, [
      '--to',
      '@team',
      '--act',
      'ask',
      '--meta',
      'species=approve',
      '--meta',
      'tier=blocking',
      '--json',
      'ship it?',
    ]);
    const parsed = JSON.parse(askJson.out);
    expect(parsed.id).toBeTruthy();
    // The daemon-derived contract carries the reachability projection (ADR 153): nick — an admin
    // human made live by this very CLI session's ambient presence — is a reachable unblocker.
    expect(parsed.ask_contract).toEqual({
      timeout_ms: 15 * 60_000,
      no_answer: 'hold',
      unblocker_reachable: true,
    });

    // A non-ask send carries no contract noise.
    const msg = await run(sendCommand, ['--to', '@team', '--act', 'status_update', 'working']);
    expect(msg.out).not.toContain('HOLD');
  });

  it('a below-top tier tells the CLI ask-raiser it may proceed with a recorded risk', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    const ask = await run(sendCommand, [
      '--to',
      '@team',
      '--act',
      'ask',
      '--meta',
      'species=consult',
      '--meta',
      'tier=advisory',
      'which direction?',
    ]);
    expect(ask.out).toContain('PROCEED');
    expect(ask.out).toContain("meta.ask_outcome='risk_accepted'");
    expect(ask.out).not.toContain('HOLD');
  });
});

describe('comeback summary on status (ADR 024)', () => {
  it('leads status with the count of unread action-needed messages, then clears once read', async () => {
    // nick creates dawn and adds bo (the away human).
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    const added = await run(teamCommand, ['add', 'bo', '--kind', 'human', '--json']);
    const boToken = JSON.parse(added.out).human_credential as string; // 2nd human's mscr_ credential

    // nick directs a request_help at bo and a plain @team status_update (the latter must NOT count).
    await run(sendCommand, ['--to', 'bo', '--act', 'request_help', 'can you review the auth PR?']);
    await run(sendCommand, ['--act', 'status_update', '--to', '@team', 'still refactoring']);

    // bo comes back and runs `status` — sees the waiting request up top (explicit via env, ADR 036).
    actAs('dawn', 'bo', boToken);

    const status1 = await run(statusCommand, []);
    expect(status1.out).toContain('1 request waiting for you');

    // After bo reads the inbox (cursor advances), status no longer nags.
    await run(inboxCommand, []);
    const status2 = await run(statusCommand, []);
    expect(status2.out).not.toContain('waiting for you');
  });
});

describe('thread-close clears the comeback summary (ADR 025)', () => {
  it('stops nagging once the request is resolved, even before the inbox is read', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    const added = await run(teamCommand, ['add', 'bo', '--kind', 'human', '--json']);
    const boToken = JSON.parse(added.out).human_credential as string; // 2nd human's mscr_ credential

    // nick directs a request_help at bo; capture the envelope id (its thread root).
    const ask = await run(sendCommand, [
      '--to',
      'bo',
      '--act',
      'request_help',
      '--json',
      'can you review the auth PR?',
    ]);
    const askId = JSON.parse(ask.out).id as string;

    // bo (away) would see 1 waiting — explicit via env (ADR 036).
    actAs('dawn', 'bo', boToken);
    const before = await run(statusCommand, []);
    expect(before.out).toContain('1 request waiting for you');

    // ...but nick (back to his auto-bound folder) resolves the thread, and bo's status goes quiet
    // without reading the inbox.
    actAsNobody();
    const done = await run(sendCommand, [
      '--act',
      'resolve',
      '--to',
      '@team',
      '--thread',
      askId,
      'merged — thanks',
    ]);
    expect(done.code).toBe(0);

    actAs('dawn', 'bo', boToken);
    const after = await run(statusCommand, []);
    expect(after.out).not.toContain('waiting for you');
  });
});

describe('agent-side reachability nudge (ADR 046)', () => {
  it('does not supersede a live same-workspace adapter while re-claiming agent HTTP authority', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    const authority = await claimedAgent('dawn', 'Ada');
    const agentKey = loadConfig().agentKeys['dawn']!;
    const adapterError = vi.fn();
    let adapter: ReturnType<typeof watchClaim>;
    await new Promise<void>((resolve, reject) => {
      adapter = watchClaim({
        wsUrl: process.env['MUSTERD_SERVER']!.replace(/^http/, 'ws') + '/ws',
        team: 'dawn',
        key: authority.key,
        target: { seat: 'Ada' },
        surface: 'claude-code',
        workspace: basename(cwdDir),
        onDeliver: () => {},
        onOccupied: () => resolve(),
        onError: (message) => {
          adapterError(message);
          reject(new Error(message));
        },
      });
    });

    try {
      saveBinding(cwdDir, {
        version: 2,
        server: process.env['MUSTERD_SERVER']!,
        team: 'dawn',
        agent_key: agentKey,
        seat_credential: authority.key,
        session_lease: 'msls_stale',
        claim: { mode: 'seat', name: 'Ada' },
      });

      await resolve({}).http.inbox('dawn', { unread: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(adapterError).not.toHaveBeenCalled();
    } finally {
      adapter!.close();
    }
  });

  it('re-claims a bound agent before a routine HTTP read when its stored lease is stale', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    const authority = await claimedAgent('dawn', 'Ada');
    const agentKey = loadConfig().agentKeys['dawn']!;

    saveBinding(cwdDir, {
      version: 2,
      server: process.env['MUSTERD_SERVER']!,
      team: 'dawn',
      agent_key: agentKey,
      seat_credential: authority.key,
      session_lease: 'msls_stale',
      claim: { mode: 'seat', name: 'Ada' },
    });

    await expect(
      new HttpClient({
        server: process.env['MUSTERD_SERVER']!,
        key: authority.key,
        seat: 'Ada',
        sessionLease: 'msls_stale',
      }).inbox('dawn', { unread: true }),
    ).rejects.toMatchObject({ exitCode: 4 });

    const restored = await resolve({}).http.inbox('dawn', { unread: true });
    expect(restored.messages).toEqual([]);
  });

  it('surfaces a directed act on an unrelated command, then self-clears once the inbox is read', async () => {
    // nick creates dawn and adds Ada (a heads-down agent).
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    // ADR 069: Ada (agent) authenticates with the team agent key + seat:Ada (set by actAs).
    const ada = await claimedAgent('dawn', 'Ada');

    // nick directs a request_help at Ada.
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'real test please']);

    // Ada acts (explicit via env, ADR 036) — runs an unrelated `send`. The nudge fires for that
    // command, naming the waiting act, even though `send` never shows the inbox itself.
    actAs('dawn', 'Ada', ada.key, ada.sessionLease);
    const nudge = await reachabilityNudge(
      'send',
      parseArgs(['--to', 'nick', '--act', 'message', 'ok']),
    );
    expect(nudge).toContain('1 act waiting for Ada');
    expect(nudge).toContain('musterd inbox');

    // After Ada reads the inbox (cursor advances), the nudge goes quiet.
    await run(inboxCommand, []);
    expect(await reachabilityNudge('send', parseArgs([]))).toBe('');
  });

  it('skips commands that show the acts themselves (inbox/status) and suppresses on --json/--quiet', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    // ADR 069: Ada (agent) authenticates with the team agent key + seat:Ada (set by actAs).
    const ada = await claimedAgent('dawn', 'Ada');
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'real test please']);
    actAs('dawn', 'Ada', ada.key, ada.sessionLease);

    // No double-surfacing: inbox renders the acts, status leads with the comeback summary.
    expect(await reachabilityNudge('inbox', parseArgs([]))).toBe('');
    expect(await reachabilityNudge('status', parseArgs([]))).toBe('');
    // Sidecar opt-outs keep --json/piped output and quiet scripts clean.
    expect(await reachabilityNudge('send', parseArgs(['--json']))).toBe('');
    expect(await reachabilityNudge('send', parseArgs(['--quiet']))).toBe('');
    // MUSTERD_NO_NUDGE=1 silences it too.
    process.env['MUSTERD_NO_NUDGE'] = '1';
    expect(await reachabilityNudge('send', parseArgs([]))).toBe('');
    delete process.env['MUSTERD_NO_NUDGE'];
  });

  it('prints nothing for an ambient-only (read) identity — never acts as the global config (ADR 036)', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']); // auto-binds cwdDir as nick
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent']);
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'real test please']);

    // Move to an unbound folder: nick@dawn is ambient (config) only — not explicit, so no nudge.
    const elsewhere = mkdtempSync(join(tmpdir(), 'musterd-unbound-'));
    cwdSpy.mockReturnValue(elsewhere);
    actAsNobody();
    expect(resolveRead({}).explicit).toBe(false);
    expect(await reachabilityNudge('send', parseArgs([]))).toBe('');
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('inbox --interrupt-check — the mid-loop interrupt line (ADR 088)', () => {
  it('raises one daemon-composed line for a waiting urgent directed act, silent for a plain one', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent']);
    const ada = await claimedAgent('dawn', 'Ada');

    // nick (his bound folder) sends Ada a NON-urgent directed act first.
    await run(sendCommand, ['--to', 'Ada', '--act', 'message', 'fyi, minor thing']);

    // As Ada: a non-urgent act is NOT interrupt-class → silent, exit 0, zero output (the free path).
    actAs('dawn', 'Ada', ada.key, ada.sessionLease);
    const silent = await run(inboxCommand, ['--interrupt-check']);
    expect(silent.code).toBe(0);
    expect(silent.out).toBe('');

    // nick escalates with an urgent request_help.
    actAsNobody();
    await run(sendCommand, [
      '--to',
      'Ada',
      '--act',
      'request_help',
      '--urgent',
      '--urgent-reason',
      'prod is down',
      'drop everything and look at deploy',
    ]);

    // As Ada: the interrupt line fires — daemon-composed, names sender + act, NEVER the raw body.
    actAs('dawn', 'Ada', ada.key, ada.sessionLease);
    const raised = await run(inboxCommand, ['--interrupt-check']);
    expect(raised.code).toBe(0);
    expect(raised.out).toContain('⚡ musterd:');
    expect(raised.out).toContain('nick');
    expect(raised.out).toContain('request_help');
    expect(raised.out).not.toContain('drop everything'); // §4: never the message body

    // The probe never advances the cursor — it keeps raising until the agent explicitly reads.
    const again = await run(inboxCommand, ['--interrupt-check']);
    expect(again.out).toContain('⚡ musterd:');
    await run(inboxCommand, []); // Ada reads her inbox → cursor advances
    const cleared = await run(inboxCommand, ['--interrupt-check']);
    expect(cleared.out).toBe('');
  });

  it('is silent for an unbound folder and honours MUSTERD_NO_NUDGE=1', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent']);
    const ada = await claimedAgent('dawn', 'Ada');
    await run(sendCommand, [
      '--to',
      'Ada',
      '--act',
      'request_help',
      '--urgent',
      '--urgent-reason',
      'prod',
      'help',
    ]);

    // Unbound folder, ambient-only identity → no seat to interrupt → silent, exit 0 (never throws).
    const elsewhere = mkdtempSync(join(tmpdir(), 'musterd-unbound-'));
    cwdSpy.mockReturnValue(elsewhere);
    actAsNobody();
    const amb = await run(inboxCommand, ['--interrupt-check']);
    expect(amb.code).toBe(0);
    expect(amb.out).toBe('');
    rmSync(elsewhere, { recursive: true, force: true });

    // Explicit as Ada, but the kill-switch silences the probe entirely.
    actAs('dawn', 'Ada', ada.key, ada.sessionLease);
    process.env['MUSTERD_NO_NUDGE'] = '1';
    const off = await run(inboxCommand, ['--interrupt-check']);
    expect(off.out).toBe('');
    delete process.env['MUSTERD_NO_NUDGE'];

    // Kill-switch cleared → the urgent act raises.
    const on = await run(inboxCommand, ['--interrupt-check']);
    expect(on.out).toContain('⚡ musterd:');
  });
});

describe('reclaim command (ADR 017 follow-up)', () => {
  it('reclaims a member (idempotent with no live session) and 404s an unknown one', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent']);

    // No live WS session here, but reclaim is a safe no-op that still succeeds.
    const ok = await run(reclaimCommand, ['Ada']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('reclaimed');
    expect(ok.out).toContain('Ada');

    // Unknown member → not_found (CLI exit 6).
    await expect(run(reclaimCommand, ['Ghost'])).rejects.toMatchObject({ exitCode: 6 });
  });
});

describe('team remove command (ADR 019)', () => {
  it('soft-removes a member off the roster; unknown member errors', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent']);

    // Ada is on the roster before removal.
    const before = await run(statusCommand, []);
    expect(before.out).toContain('Ada');

    const removed = await run(teamCommand, ['remove', 'Ada']);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain('removed');
    expect(removed.out).toContain('Ada');

    // ... and gone from `status` afterwards.
    const after = await run(statusCommand, []);
    expect(after.out).not.toContain('Ada');

    // Unknown (or already-removed) member → not_found (CLI exit 6).
    await expect(run(teamCommand, ['remove', 'Ghost'])).rejects.toMatchObject({ exitCode: 6 });
  });
});

describe('join honesty (2026-06-16 dogfood: relabeled token cascade)', () => {
  it('refuses to join as a different member than the cached identity without a token', async () => {
    // nick creates dawn and adds Ada; the cached config identity is nick.
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);

    // Joining as Ada with no --token must NOT silently relabel nick's token as "Ada"
    // (that "succeeds" then fails every send with from/team mismatch). It must refuse.
    await expect(run(joinCommand, ['dawn', '--as', 'Ada'])).rejects.toMatchObject({ exitCode: 4 });

    // The cached identity is untouched — still nick, not a poisoned "Ada".
    const cfg = JSON.parse(readFileSync(nickConfig, 'utf8'));
    expect(cfg.identities.dawn.name).toBe('nick');
  });

  it('the legacy `join <slug> --as <name>` spelling runs the claim handshake and says so on stderr (ADR 377)', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    const errChunks: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => {
      errChunks.push(String(c));
      return true;
    });
    try {
      const ok = await run(joinCommand, ['dawn', '--as', 'nick']);
      expect(ok.code).toBe(0);
      // Delegated to claim: claim's output, not a second handshake's.
      expect(ok.out).toContain('occupied on dawn');
      expect(ok.out).toContain('online via cli (detached');
      expect(ok.out).not.toContain('joined');
    } finally {
      errSpy.mockRestore();
    }
    expect(errChunks.join('')).toContain(
      'musterd join is now: musterd claim nick --team dawn --detach',
    );
    // Same handshake, same result: the folder is bound to the seat claim resolved.
    const ok2 = await run(claimCommand, ['nick', '--team', 'dawn', '--json']);
    expect(JSON.parse(ok2.out.trim().split('\n').pop()!)).toMatchObject({
      team: 'dawn',
      member: 'nick',
    });
  });

  it("under --json the alias is silent on stderr and emits claim's JSON shape", async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    const errChunks: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => {
      errChunks.push(String(c));
      return true;
    });
    try {
      const ok = await run(joinCommand, ['dawn', '--as', 'nick', '--json']);
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.out.trim().split('\n').pop()!)).toMatchObject({
        team: 'dawn',
        member: 'nick',
      });
    } finally {
      errSpy.mockRestore();
    }
    expect(errChunks.join('')).not.toContain('ADR 377');
  });

  it('`claim <name> --team <slug>` is the same handshake — the vault key is found without --key (ADR 377)', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    const ok = await run(claimCommand, ['nick', '--team', 'dawn', '--json']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out.trim().split('\n').pop()!)).toMatchObject({
      team: 'dawn',
      member: 'nick',
    });
  });
});

describe('resolve() identity alignment with the MCP adapter (ADR 018)', () => {
  afterEach(() => {
    delete process.env['MUSTERD_BINDING'];
    delete process.env['MUSTERD_TEAM'];
    delete process.env['MUSTERD_MEMBER'];
    delete process.env['MUSTERD_TOKEN'];
  });

  it('the workspace binding beats the global config — two agents on one machine no longer collide', () => {
    // Global config says this machine's `lab` identity is Api (the 2026-06-16 collision).
    writeFileSync(
      nickConfig,
      JSON.stringify({
        server: process.env['MUSTERD_SERVER'],
        current: 'lab',
        identities: { lab: { name: 'Api', key: 'mskd_api', surface: 'cli' } },
      }),
    );
    // But this workspace is bound to Ui — the CLI must resolve to Ui, not the global Api.
    const bindingPath = saveBinding(dir, {
      version: 2,
      server: process.env['MUSTERD_SERVER']!,
      team: 'lab',
      agent_key: 'mskd_ui',
      claim: { mode: 'seat', name: 'Ui' },
    });
    process.env['MUSTERD_BINDING'] = bindingPath;

    const r = resolve({});
    expect(r.team).toBe('lab');
    expect(r.identity.name).toBe('Ui');
    expect(r.identity.key).toBe('mskd_ui');
  });

  it('a pre-ADR-281 binding REFUSES identity resolution — never falls through to the global config', () => {
    // The other half of the #928-fallout split: advisory reads warn and continue, but a verb that
    // would act AS this workspace's identity must refuse — falling through to the vault would have
    // the broken workspace silently act as a different member.
    writeFileSync(
      nickConfig,
      JSON.stringify({
        server: process.env['MUSTERD_SERVER'],
        current: 'lab',
        identities: { lab: { name: 'Api', key: 'mskd_api', surface: 'cli' } },
      }),
    );
    const legacyPath = join(dir, '.musterd', 'binding.json');
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        server: process.env['MUSTERD_SERVER'],
        team: 'lab',
        surface: 'claude-code',
        agent_key: 'mskd_ui',
        claim: { mode: 'seat', name: 'Ui' },
      }),
    );
    process.env['MUSTERD_BINDING'] = legacyPath;
    expect(() => resolve({})).toThrow(/musterd harness configure/);
  });

  it('MUSTERD_* env overrides the binding (same precedence as the MCP adapter)', () => {
    const bindingPath = saveBinding(dir, {
      version: 2,
      server: process.env['MUSTERD_SERVER']!,
      team: 'lab',
      agent_key: 'mskd_ui',
      claim: { mode: 'seat', name: 'Ui' },
    });
    process.env['MUSTERD_BINDING'] = bindingPath;
    process.env['MUSTERD_TEAM'] = 'lab';
    process.env['MUSTERD_AGENT_KEY'] = 'mskd_env';
    process.env['MUSTERD_CLAIM'] = 'seat:Api';

    const r = resolve({});
    expect(r.identity.name).toBe('Api');
    expect(r.identity.key).toBe('mskd_env');
  });
});

describe('cachedTeamLive (init reuse probe, ADR 016)', () => {
  it('is true for a live team+token, false for a stale token or a missing team', async () => {
    const server = process.env['MUSTERD_SERVER']!;
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    const token = JSON.parse(readFileSync(nickConfig, 'utf8')).identities.dawn.key as string;

    expect(await cachedTeamLive(server, 'dawn', token)).toBe(true);
    // stale token (e.g. minted against a since-wiped db) → not live
    expect(await cachedTeamLive(server, 'dawn', 'mskd_bogus_token')).toBe(false);
    // team that doesn't exist on this daemon (e.g. db reset) → not live
    expect(await cachedTeamLive(server, 'ghost-team', token)).toBe(false);
  });
});

describe('an active identity is required to act (ADR 036)', () => {
  it('an unbound folder reads freely but refuses to act as the ambient config identity', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']); // auto-binds cwdDir as nick
    // Move to an unrelated, unbound folder — the global config still *caches* nick@dawn (ambient).
    const elsewhere = mkdtempSync(join(tmpdir(), 'musterd-unbound-'));
    cwdSpy.mockReturnValue(elsewhere);

    // `status` is a free read: it still shows the (auth-free) roster, no identity needed.
    const status = await run(statusCommand, []);
    expect(status.out).toContain('nick');

    // `resolveRead` reports the ambient identity as NOT explicit (read-only).
    expect(resolveRead({}).explicit).toBe(false);

    // An act refuses — the ambient config can't act; the guidance names claim + --as.
    await expect(
      run(sendCommand, ['--to', 'nick', '--act', 'message', 'hi']),
    ).rejects.toMatchObject({ exitCode: 4 });

    // Naming the member with --as is explicit intent → the act goes through.
    const sent = await run(sendCommand, ['--as', 'nick', '--to', 'nick', '--act', 'message', 'hi']);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain('sent');
    expect(resolve({ as: 'nick' }).explicit).toBe(true);

    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('team create auto-binds the folder, so the creator acts immediately with no --as', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    await run(teamCommand, ['add', 'bo', '--kind', 'human']);
    // Same (now auto-bound) folder: the binding makes nick explicit without --as.
    expect(resolve({}).identitySource).toBe('binding');
    const sent = await run(sendCommand, ['--to', 'bo', '--act', 'message', 'hi bo']);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain('sent');
  });
});

describe('CLI ergonomics papercuts (ADR 067)', () => {
  async function dawnWithAgent(name: string) {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    await run(teamCommand, ['add', name, '--kind', 'agent', '--json']);
    return claimedAgent('dawn', name);
  }

  it('whoami names the seat this folder resolves to, with its source', async () => {
    const authority = await dawnWithAgent('Ada');
    actAs('dawn', 'Ada', authority.key, authority.sessionLease);
    const who = await run(whoamiCommand, []);
    expect(who.code).toBe(0);
    expect(who.out).toContain('Ada');
    expect(who.out).toContain('dawn');
    expect(who.out).toContain('env'); // identity came from MUSTERD_* env

    const json = await run(whoamiCommand, ['--json']);
    const parsed = JSON.parse(json.out);
    expect(parsed).toMatchObject({ team: 'dawn', member: 'Ada', source: 'env', explicit: true });
  });

  it('inbox --act and --from narrow the listing without advancing the cursor', async () => {
    const authority = await dawnWithAgent('Ada');
    await run(teamCommand, ['add', 'Bo', '--kind', 'agent']);
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'please review']);
    await run(sendCommand, ['--to', '@team', '--act', 'status_update', 'refactoring']);
    actAsNobody(); // nick's bound folder is fine; switch sender to Bo for a from-filter contrast
    await run(sendCommand, ['--as', 'nick', '--to', 'Ada', '--act', 'message', 'from nick only']);

    actAs('dawn', 'Ada', authority.key, authority.sessionLease);
    // --act keeps only the request_help
    const byAct = await run(inboxCommand, ['--act', 'request_help', '--peek']);
    expect(byAct.out).toContain('please review');
    expect(byAct.out).not.toContain('refactoring');
    // --from keeps only nick's (the status_update is @team from nick too, but the act filter is separate)
    const byFrom = await run(inboxCommand, ['--from', 'nick']);
    expect(byFrom.out).toContain('please review');

    // Filtering is a peek — the cursor never advanced, so a plain inbox still shows them unread.
    const plain = await run(inboxCommand, ['--peek']);
    expect(plain.out).toContain('please review');
  });

  it('accept auto-targets the latest open request when no --reply-to is given', async () => {
    const authority = await dawnWithAgent('Ada');
    const ask = await run(sendCommand, [
      '--to',
      'Ada',
      '--act',
      'request_help',
      '--json',
      'can you take the build?',
    ]);
    const askId = JSON.parse(ask.out).id as string;

    actAs('dawn', 'Ada', authority.key, authority.sessionLease);
    const accepted = await run(sendCommand, ['--act', 'accept', '--to', 'nick', '--json', 'on it']);
    const env = JSON.parse(accepted.out);
    expect(env.meta.in_reply_to).toBe(askId);
    expect(env.thread).toBe(askId); // inherited the request's thread
  });

  it('accept errors with guidance when there is no open request to answer', async () => {
    const authority = await dawnWithAgent('Ada');
    actAs('dawn', 'Ada', authority.key, authority.sessionLease);
    await expect(
      run(sendCommand, ['--act', 'accept', '--to', 'nick', 'on it']),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('inbox --waiting — surface waiting acts at the approval prompt (ADR 053)', () => {
  it('prints the directed acts waiting for the bound seat, read-only (cursor stays put)', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    const authority = await claimedAgent('dawn', 'Ada');
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'review the auth PR']);

    actAs('dawn', 'Ada', authority.key, authority.sessionLease);
    const waiting = await run(inboxCommand, ['--waiting']);
    expect(waiting.code).toBe(0);
    expect(waiting.out).toContain('Ada');
    expect(waiting.out).toContain('waiting');
    expect(waiting.out).toContain('review the auth PR');

    // Read-only: it never advanced the cursor, so a second read still surfaces the same act.
    const again = await run(inboxCommand, ['--waiting']);
    expect(again.out).toContain('waiting');

    // The pre-2026-09-03 name still answers, byte-for-byte — installed hooks keep working until
    // `init --refresh-hooks` re-points them.
    const alias = await run(nudgeCommand, []);
    expect(alias.out).toBe(again.out);
  });

  it('prints nothing (exit 0) when no directed act is waiting', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    const authority = await claimedAgent('dawn', 'Ada');
    // Only broadcast journal traffic — nothing directed at Ada.
    await run(sendCommand, ['--to', '@team', '--act', 'status_update', 'refactoring']);

    actAs('dawn', 'Ada', authority.key, authority.sessionLease);
    const waiting = await run(inboxCommand, ['--waiting']);
    expect(waiting.code).toBe(0);
    expect(waiting.out).toBe('');
  });
});

describe('inbox --wait — wake on message (ADR 054)', () => {
  /** Stand up dawn with an agent seat; return its claimed HTTP authority. */
  async function dawnWithAgent(name: string) {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    await run(teamCommand, ['add', name, '--kind', 'agent', '--json']);
    return claimedAgent('dawn', name);
  }

  it('drains the durable inbox: a directed act already waiting wakes it immediately (exit 0)', async () => {
    const authority = await dawnWithAgent('Ada');
    // A request_help is directed at Ada *before* she waits — the startup-race the pre-check guards.
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'review the auth PR']);

    actAs('dawn', 'Ada', authority.key, authority.sessionLease);
    const woke = await run(inboxCommand, ['--wait', '--timeout', '1']);
    expect(woke.code).toBe(0);
    expect(woke.out).toContain('review the auth PR');

    // It advanced the read cursor (not --peek), so a second wait finds nothing and times out (124).
    const again = await run(inboxCommand, ['--wait', '--timeout', '1']);
    expect(again.code).toBe(124);
  });

  it('times out non-zero when nothing directed arrives, and ignores broadcast journal traffic', async () => {
    const authority = await dawnWithAgent('Ada');
    // A plain @team status_update is journal traffic — it must NOT wake a waiting agent.
    await run(sendCommand, ['--to', '@team', '--act', 'status_update', 'still refactoring']);

    actAs('dawn', 'Ada', authority.key, authority.sessionLease);
    const out = await run(inboxCommand, ['--wait', '--timeout', '1']);
    expect(out.code).toBe(124);
  });

  // TODO(p3-cutover): live inbox --wait opens its own WS claim via watchClaim, which doesn't yet
  it('blocks on the live socket, then wakes the instant a directed act is sent', async () => {
    // A live `inbox --wait` IS a WS claim (ADR 075), so Ada attaches with the team agent key + a
    // standing grant (the grant is threaded resolve()→Identity→watchClaim so the live claim occupies
    // instead of going pending). nick (admin, his mscr_ credential) issues the grant.
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    const cfg = JSON.parse(readFileSync(nickConfig, 'utf8'));
    const agentKey = cfg.agentKeys.dawn as string;
    const nickKey = cfg.identities.dawn.key as string;
    const gres = await fetch(`${process.env['MUSTERD_SERVER']}/teams/dawn/grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${nickKey}` },
      body: JSON.stringify({ scope: 'seat', target: 'Ada', lifetime: 'standing' }),
    });
    const grant = ((await gres.json()) as { token: string }).token;

    // One capture for the whole test — `run()` nests stdout spies, which would clobber a pending wait.
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
      chunks.push(String(c));
      return true;
    });
    try {
      // Ada waits, attaching via the agent key + grant (captured synchronously before any await).
      process.env['MUSTERD_TEAM'] = 'dawn';
      process.env['MUSTERD_AGENT_KEY'] = agentKey;
      process.env['MUSTERD_CLAIM'] = 'seat:Ada';
      process.env['MUSTERD_GRANT'] = grant;
      const waitP = inboxCommand(parseArgs(['--wait', '--timeout', '5']));

      // This sleep biases the send toward the live-push path (what this test is named for); it is no
      // longer what makes the test correct. `--wait` starts in two phases — it drains the durable
      // inbox, THEN opens the socket — and an act landing between them used to be caught by neither,
      // so the wait sat until its deadline and exited 124 no matter how generous that deadline was.
      // That was this test's flake: under a loaded suite the socket phase stretched past the sleep.
      // inbox.ts now re-drains once the socket is subscribed, so both sides of the window wake it and
      // a mistimed sleep costs nothing. Deliberately NOT replaced with polling for Ada's presence:
      // the socket's `session` provenance is overwritten by her own next HTTP call, so that
      // "condition" is transient and a poll that samples late spins forever — measured, not guessed.
      await new Promise((r) => setTimeout(r, 300));
      actAsNobody();
      await sendCommand(parseArgs(['--to', 'Ada', '--act', 'request_help', 'wake up please']));

      const code = await waitP;
      expect(code).toBe(0);
      expect(chunks.join('')).toContain('wake up please');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('session capture end-to-end (ADR 131 inc 4)', () => {
  it('captures locally and pushes the harness-class-only attestation to the live daemon', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    await run(teamCommand, ['add', 'scout', '--kind', 'agent']);
    const agentKey = loadConfig().agentKeys['dawn']!;
    const authority = await claimedAgent('dawn', 'scout');

    // A seat workspace whose binding points at the live in-memory daemon — what the SessionStart
    // hook sees after `musterd agent scout`.
    const ws = mkdtempSync(join(tmpdir(), 'musterd-e2e-ws-'));
    try {
      saveBinding(ws, {
        version: 2,
        server: process.env['MUSTERD_SERVER']!,
        team: 'dawn',
        claim: { mode: 'seat', name: 'scout' },
        agent_key: agentKey,
        seat_credential: authority.key,
        session_lease: authority.sessionLease,
      });
      const presencesBefore = server.db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM presence')
        .get()?.n;
      await captureSession('start', {
        session_id: 'sid-e2e',
        transcript_path: join(ws, 't.jsonl'),
        cwd: ws,
      });

      // Local: the full capture (id + transcript path) landed in the gitignored binding.
      const binding = JSON.parse(readFileSync(join(ws, '.musterd', 'binding.json'), 'utf8')) as {
        session?: { id: string; transcript_path?: string };
      };
      expect(binding.session?.id).toBe('sid-e2e');

      // Daemon: harness class + a one-way digest — the audit detail carries NO id and NO path, and
      // the push was presence-neutral (no presence row for scout).
      const audit = server.db
        .prepare<
          [],
          { target: string; detail: string }
        >("SELECT target, detail FROM audit WHERE action = 'residency.session_captured'")
        .all();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.target).toBe('scout');
      expect(audit[0]!.detail).not.toContain('sid-e2e');
      expect(audit[0]!.detail).not.toContain('t.jsonl');
      expect(JSON.parse(audit[0]!.detail)).toEqual({
        harness: 'claude-code',
        enrolled: false,
        session_digest: sessionDigest(agentKey, 'sid-e2e'),
      });
      const presencesAfter = server.db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM presence')
        .get();
      // Session capture is presence-neutral: the existing claim is the sole row.
      expect(presencesAfter?.n ?? 0).toBe(presencesBefore ?? 0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  /**
   * The capability the lane exists for (01KZAEGF2K): today's ledger shows 48 same-seat
   * captured→ended pairs inside ten seconds, and nothing in a row says whether that is one session
   * bouncing or two short ones. This asserts the join is now possible — end matches its own start,
   * a second session does not — through the real hook entry point and a real daemon, not a stub.
   */
  it('a captured/ended pair is joinable by digest, and a second session is separable', async () => {
    await run(teamCommand, ['create', 'dusk', '--as', 'nick', '--role', 'lead']);
    await run(teamCommand, ['add', 'rook', '--kind', 'agent']);
    const agentKey = loadConfig().agentKeys['dusk']!;
    const authority = await claimedAgent('dusk', 'rook');

    const ws = mkdtempSync(join(tmpdir(), 'musterd-e2e-ws-'));
    try {
      saveBinding(ws, {
        version: 2,
        server: process.env['MUSTERD_SERVER']!,
        team: 'dusk',
        claim: { mode: 'seat', name: 'rook' },
        agent_key: agentKey,
        seat_credential: authority.key,
        session_lease: authority.sessionLease,
      });

      await captureSession('start', { session_id: 'sid-one', cwd: ws });
      await captureSession('end', { session_id: 'sid-one', cwd: ws });
      await captureSession('start', { session_id: 'sid-two', cwd: ws });

      const rows = server.db
        .prepare<[], { action: string; detail: string }>(
          "SELECT action, detail FROM audit WHERE target = 'rook' AND action LIKE 'residency.session_%' ORDER BY id",
        )
        .all()
        .map((r) => ({
          action: r.action,
          digest: (JSON.parse(r.detail) as { session_digest?: string }).session_digest,
        }));

      expect(rows.map((r) => r.action)).toEqual([
        'residency.session_captured',
        'residency.session_ended',
        'residency.session_captured',
      ]);
      // The join: rows 0 and 1 are one session's two ends.
      expect(rows[0]!.digest).toBe(rows[1]!.digest);
      // The separation: row 2 is a different session, which is exactly what the seat-only ledger
      // could not say.
      expect(rows[2]!.digest).not.toBe(rows[0]!.digest);
      expect(rows.every((r) => typeof r.digest === 'string' && r.digest.length > 0)).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('hook-path reads must not reclaim the seat (the #1130 claim storm)', () => {
  afterEach(() => {
    delete process.env['MUSTERD_BINDING'];
  });

  /** Bind this folder to agent seat ava with a REVOKED lease — the state every hook one-shot
   *  (gate check, nudge) wakes up in once any other process has claimed since. Returns the LIVE
   *  claimant (the adapter that superseded it), whose lease is the thing a reclaim would kill. */
  async function bindAvaWithStaleLease(): Promise<Awaited<ReturnType<typeof claimedAgent>>> {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    await run(teamCommand, ['add', 'ava', '--kind', 'agent']);
    const auth = await claimedAgent('dawn', 'ava');
    // A second claim supersedes the first, revoking the lease we are about to persist — the storm's
    // steady state, reproduced once.
    const stale = auth.sessionLease;
    const live = await claimedAgent('dawn', 'ava');
    const bindingPath = saveBinding(dir, {
      version: 2,
      server: process.env['MUSTERD_SERVER']!,
      team: 'dawn',
      agent_key: loadConfig().agentKeys['dawn']!,
      seat_credential: auth.key,
      session_lease: stale,
      claim: { mode: 'seat', name: 'ava' },
    });
    process.env['MUSTERD_BINDING'] = bindingPath;
    // The seat credential is minted on the FIRST claim and stable thereafter — a re-claim returns
    // only a fresh lease — so the live claimant's authority is that credential + the live lease.
    return { ...live, key: auth.key };
  }

  it('a hook read (claimSeatPerRequest: false) presents the stale lease and fails closed — it never claims', async () => {
    await bindAvaWithStaleLease();
    const { http, explicit } = resolveRead({}, { claimSeatPerRequest: false });
    expect(explicit).toBe(true);
    // No reclaim: the stale lease is refused by the server and the read fails — instead of the
    // hook seizing the seat, evicting the live adapter's presence, and killing ITS lease.
    await expect(http.inbox('dawn', { unread: true, limit: 1 })).rejects.toThrow(
      /invalid, expired, or revoked/,
    );
  });

  // ADR 337 §4 on the attestation path (lane 01M1F92X69). Measured on seat ryder 2026-09-01: the
  // stored lease is minted once at claim and lives five minutes, so every SessionStart/SessionEnd
  // hook after that was refused, the refusal swallowed as "unreachable", and the ledger got no row.
  it('a session attestation with a refused lease reclaims once and lands on the ledger', async () => {
    await bindAvaWithStaleLease();
    const bindingPath = process.env['MUSTERD_BINDING']!;
    const readBinding = () =>
      JSON.parse(readFileSync(bindingPath, 'utf8')) as {
        session_lease?: string;
        seat_credential?: string;
        session?: { attested_at?: number };
      };
    const captured = () =>
      server.db
        .prepare<[], { action: string }>(
          "SELECT action FROM audit WHERE target = 'ava' AND action LIKE 'residency.session_%' ORDER BY id",
        )
        .all()
        .map((r) => r.action);

    await captureSession('start', { session_id: 'late-hook', cwd: dir });
    expect(captured()).toEqual(['residency.session_captured']);
    const after = readBinding();
    expect(after.session!.attested_at).toBeGreaterThan(0);
    expect(after.seat_credential).toBeDefined(); // the claim renewed authority, not identity

    // The end hook lands too. It claims again — the lease the start hook minted died with the
    // Presence its socket released (ws.ts cleanup → held_until), so there is nothing to reuse.
    await captureSession('end', { session_id: 'late-hook', cwd: dir });
    expect(captured()).toEqual(['residency.session_captured', 'residency.session_ended']);
  });

  it('an interactive read still reclaims (ADR 339 / #1130 preserved)', async () => {
    await bindAvaWithStaleLease();
    // Opting IN is now explicit. #1138 pinned this as the DEFAULT, and that default is what let the
    // storm survive it: every read path that did not think about the flag reclaimed, so the two
    // callsites #1138 opted out were re-claimed anyway by other reads in the same process
    // (reachabilityNudge, inbox --interrupt-check, infra-gate). Measured on main @ fcb92af8:
    // 2 claim.superseded rows per hook invocation, 0 once suppressed.
    const { http } = resolveRead({}, { claimSeatPerRequest: true });
    const res = await http.inbox('dawn', { unread: true, limit: 1 });
    expect(Array.isArray(res.messages)).toBe(true);
  });

  it('DEFAULTS to not reclaiming — a read path that never considered the flag cannot storm', async () => {
    await bindAvaWithStaleLease();
    const { http, explicit } = resolveRead({});
    expect(explicit).toBe(true);
    await expect(http.inbox('dawn', { unread: true, limit: 1 })).rejects.toThrow(
      /invalid, expired, or revoked/,
    );
  });

  // Folded in from #1140 (closed as superseded by this branch). The three cases above pin the
  // resolveRead default; this one drives the whole PostToolUse one-shot — `inbox --interrupt-check`,
  // the probe that fires on EVERY tool call — and asserts the harm the storm actually did: the live
  // claimant's lease is still valid afterwards. Fails on main @ fcb92af8 with the reclaim default on.
  it("the interrupt-check one-shot stays silent AND leaves the live claimant's lease intact", async () => {
    const live = await bindAvaWithStaleLease();

    const probe = await run(inboxCommand, ['--interrupt-check']);
    expect(probe.code).toBe(0);
    expect(probe.out).toBe('');

    // Pre-fix, the probe's reclaim seized the seat and evicted the live adapter's presence row —
    // and a session lease is bound to that row (ADR 337), so this read failed with
    // "invalid, expired, or revoked agent session lease".
    const liveHttp = new HttpClient({
      server: process.env['MUSTERD_SERVER']!,
      team: 'dawn',
      key: live.key,
      seat: 'ava',
      sessionLease: live.sessionLease,
      surface: 'cli',
    });
    const res = await liveHttp.inbox('dawn', { unread: true, limit: 1 });
    expect(Array.isArray(res.messages)).toBe(true);
  });
});
