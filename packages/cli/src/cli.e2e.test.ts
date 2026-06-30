import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args.js';
import { reachabilityNudge, resolve, resolveRead } from './commands/helpers.js';
import { inboxCommand } from './commands/inbox.js';
import { joinCommand } from './commands/join.js';
import { nudgeCommand } from './commands/nudge.js';
import { reclaimCommand } from './commands/reclaim.js';
import { sendCommand } from './commands/send.js';
import { statusCommand } from './commands/status.js';
import { teamCommand } from './commands/team.js';
import { whoamiCommand } from './commands/whoami.js';
import { saveBinding } from './config.js';
import { cachedTeamLive } from './onboard/init.js';

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
function actAs(team: string, member: string, token: string): void {
  process.env['MUSTERD_TEAM'] = team;
  // v0.3 (ADR 075): the env carries the Bearer secret (here the member's mskd_ seat token, on the
  // untouched authMember path) + the claim target naming the acting seat.
  process.env['MUSTERD_AGENT_KEY'] = token;
  process.env['MUSTERD_CLAIM'] = `seat:${member}`;
}
function actAsNobody(): void {
  delete process.env['MUSTERD_TEAM'];
  delete process.env['MUSTERD_AGENT_KEY'];
  delete process.env['MUSTERD_CLAIM'];
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

describe('CLI end-to-end (Scenario A: two humans on one team)', () => {
  it('creates a team, adds a second human, exchanges a message', async () => {
    // nick creates dawn
    const created = await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    expect(created.code).toBe(0);
    expect(created.out).toContain('team "dawn" created');

    // nick adds bo (capture bo's token via --json)
    const added = await run(teamCommand, ['add', 'bo', '--kind', 'human', '--json']);
    const boToken = JSON.parse(added.out).token as string;
    expect(boToken).toMatch(/^mskd_/);

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
    expect(inbox1.out).toContain('(1 unread)');
    expect(inbox1.out).toContain('hello bo');

    // reading advanced the cursor → second read shows 0 unread
    const inbox2 = await run(inboxCommand, []);
    expect(inbox2.out).toContain('(0 unread)');
  });

  it('reports an empty inbox with the canonical string', async () => {
    await run(teamCommand, ['create', 'solo', '--as', 'nick']);
    await run(teamCommand, ['add', 'pat', '--kind', 'human']);
    // pat has received nothing
    const added = await run(teamCommand, ['add', 'pat2', '--kind', 'human', '--json']);
    const tok = JSON.parse(added.out).token as string;
    actAs('solo', 'pat2', tok);
    const inbox = await run(inboxCommand, []);
    expect(inbox.out).toContain("inbox empty — nobody's mustered anything yet");
  });
});

describe('comeback summary on status (ADR 024)', () => {
  it('leads status with the count of unread action-needed messages, then clears once read', async () => {
    // nick creates dawn and adds bo (the away human).
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    const added = await run(teamCommand, ['add', 'bo', '--kind', 'human', '--json']);
    const boToken = JSON.parse(added.out).token as string;

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
    const boToken = JSON.parse(added.out).token as string;

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
  it('surfaces a directed act on an unrelated command, then self-clears once the inbox is read', async () => {
    // nick creates dawn and adds Ada (a heads-down agent).
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    const added = await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    const adaToken = JSON.parse(added.out).token as string;

    // nick directs a request_help at Ada.
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'real test please']);

    // Ada acts (explicit via env, ADR 036) — runs an unrelated `send`. The nudge fires for that
    // command, naming the waiting act, even though `send` never shows the inbox itself.
    actAs('dawn', 'Ada', adaToken);
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
    const added = await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    const adaToken = JSON.parse(added.out).token as string;
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'real test please']);
    actAs('dawn', 'Ada', adaToken);

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

  it('re-joining as the same cached member occupies via its credential (v0.3)', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    const ok = await run(joinCommand, ['dawn', '--as', 'nick']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('joined');
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
      server: process.env['MUSTERD_SERVER']!,
      team: 'lab',
      agent_key: 'mskd_ui',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'Ui' },
    });
    process.env['MUSTERD_BINDING'] = bindingPath;

    const r = resolve({});
    expect(r.team).toBe('lab');
    expect(r.identity.name).toBe('Ui');
    expect(r.identity.key).toBe('mskd_ui');
  });

  it('MUSTERD_* env overrides the binding (same precedence as the MCP adapter)', () => {
    const bindingPath = saveBinding(dir, {
      server: process.env['MUSTERD_SERVER']!,
      team: 'lab',
      agent_key: 'mskd_ui',
      surface: 'claude-code',
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
  async function dawnWithAgent(name: string): Promise<string> {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    const added = await run(teamCommand, ['add', name, '--kind', 'agent', '--json']);
    return JSON.parse(added.out).token as string;
  }

  it('whoami names the seat this folder resolves to, with its source', async () => {
    const token = await dawnWithAgent('Ada');
    actAs('dawn', 'Ada', token);
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
    const token = await dawnWithAgent('Ada');
    await run(teamCommand, ['add', 'Bo', '--kind', 'agent']);
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'please review']);
    await run(sendCommand, ['--to', '@team', '--act', 'status_update', 'refactoring']);
    actAsNobody(); // nick's bound folder is fine; switch sender to Bo for a from-filter contrast
    await run(sendCommand, ['--as', 'nick', '--to', 'Ada', '--act', 'message', 'from nick only']);

    actAs('dawn', 'Ada', token);
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
    const token = await dawnWithAgent('Ada');
    const ask = await run(sendCommand, [
      '--to',
      'Ada',
      '--act',
      'request_help',
      '--json',
      'can you take the build?',
    ]);
    const askId = JSON.parse(ask.out).id as string;

    actAs('dawn', 'Ada', token);
    const accepted = await run(sendCommand, ['--act', 'accept', '--to', 'nick', '--json', 'on it']);
    const env = JSON.parse(accepted.out);
    expect(env.meta.in_reply_to).toBe(askId);
    expect(env.thread).toBe(askId); // inherited the request's thread
  });

  it('accept errors with guidance when there is no open request to answer', async () => {
    const token = await dawnWithAgent('Ada');
    actAs('dawn', 'Ada', token);
    await expect(
      run(sendCommand, ['--act', 'accept', '--to', 'nick', 'on it']),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('nudge — surface waiting acts at the approval prompt (ADR 053)', () => {
  it('prints the directed acts waiting for the bound seat, read-only (cursor stays put)', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    const added = await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    const token = JSON.parse(added.out).token as string;
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'review the auth PR']);

    actAs('dawn', 'Ada', token);
    const nudge = await run(nudgeCommand, []);
    expect(nudge.code).toBe(0);
    expect(nudge.out).toContain('Ada');
    expect(nudge.out).toContain('waiting');

    // Read-only: it never advanced the cursor, so a second nudge still surfaces the same act.
    const again = await run(nudgeCommand, []);
    expect(again.out).toContain('waiting');
  });

  it('prints nothing (exit 0) when no directed act is waiting', async () => {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    const added = await run(teamCommand, ['add', 'Ada', '--kind', 'agent', '--json']);
    const token = JSON.parse(added.out).token as string;
    // Only broadcast journal traffic — nothing directed at Ada.
    await run(sendCommand, ['--to', '@team', '--act', 'status_update', 'refactoring']);

    actAs('dawn', 'Ada', token);
    const nudge = await run(nudgeCommand, []);
    expect(nudge.code).toBe(0);
    expect(nudge.out).toBe('');
  });
});

describe('inbox --wait — wake on message (ADR 054)', () => {
  /** Stand up dawn with an agent seat; return the agent's token. */
  async function dawnWithAgent(name: string): Promise<string> {
    await run(teamCommand, ['create', 'dawn', '--as', 'nick', '--role', 'lead']);
    const added = await run(teamCommand, ['add', name, '--kind', 'agent', '--json']);
    return JSON.parse(added.out).token as string;
  }

  it('drains the durable inbox: a directed act already waiting wakes it immediately (exit 0)', async () => {
    const token = await dawnWithAgent('Ada');
    // A request_help is directed at Ada *before* she waits — the startup-race the pre-check guards.
    await run(sendCommand, ['--to', 'Ada', '--act', 'request_help', 'review the auth PR']);

    actAs('dawn', 'Ada', token);
    const woke = await run(inboxCommand, ['--wait', '--timeout', '1']);
    expect(woke.code).toBe(0);
    expect(woke.out).toContain('review the auth PR');

    // It advanced the read cursor (not --peek), so a second wait finds nothing and times out (124).
    const again = await run(inboxCommand, ['--wait', '--timeout', '1']);
    expect(again.code).toBe(124);
  });

  it('times out non-zero when nothing directed arrives, and ignores broadcast journal traffic', async () => {
    const token = await dawnWithAgent('Ada');
    // A plain @team status_update is journal traffic — it must NOT wake a waiting agent.
    await run(sendCommand, ['--to', '@team', '--act', 'status_update', 'still refactoring']);

    actAs('dawn', 'Ada', token);
    const out = await run(inboxCommand, ['--wait', '--timeout', '1']);
    expect(out.code).toBe(124);
  });

  // TODO(p3-cutover): live inbox --wait opens its own WS claim via watchClaim, which doesn't yet
  // thread a grant (Identity carries no grant) — so a granted agent's live claim goes pending and the
  // socket never opens. The durable-drain path (the two tests above) covers wake-on-message over HTTP.
  // Un-skip once the grant is threaded resolve()→Identity→watchClaim. (Follow-up flagged to Cleo.)
  it.skip('blocks on the live socket, then wakes the instant a directed act is sent', async () => {
    const token = await dawnWithAgent('Ada');

    // One capture for the whole test — `run()` nests stdout spies, which would clobber a pending wait.
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
      chunks.push(String(c));
      return true;
    });
    try {
      // Ada waits (identity captured synchronously before any await, so the later env switch is safe).
      actAs('dawn', 'Ada', token);
      const waitP = inboxCommand(parseArgs(['--wait', '--timeout', '5']));

      // Let the socket connect + subscribe, then nick (his bound folder) sends Ada a directed act.
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
