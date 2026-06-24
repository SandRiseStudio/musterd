import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args.js';
import { reachabilityNudge, resolve, resolveRead } from './commands/helpers.js';
import { inboxCommand } from './commands/inbox.js';
import { joinCommand } from './commands/join.js';
import { reclaimCommand } from './commands/reclaim.js';
import { sendCommand } from './commands/send.js';
import { statusCommand } from './commands/status.js';
import { teamCommand } from './commands/team.js';
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
  process.env['MUSTERD_MEMBER'] = member;
  process.env['MUSTERD_TOKEN'] = token;
}
function actAsNobody(): void {
  delete process.env['MUSTERD_TEAM'];
  delete process.env['MUSTERD_MEMBER'];
  delete process.env['MUSTERD_TOKEN'];
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

  it('re-joining as the same cached member reuses the token (no --token needed)', async () => {
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
        identities: { lab: { name: 'Api', token: 'mskd_api', surface: 'cli' } },
      }),
    );
    // But this workspace is bound to Ui — the CLI must resolve to Ui, not the global Api.
    const bindingPath = saveBinding(dir, {
      server: process.env['MUSTERD_SERVER']!,
      team: 'lab',
      member: 'Ui',
      token: 'mskd_ui',
      surface: 'claude-code',
    });
    process.env['MUSTERD_BINDING'] = bindingPath;

    const r = resolve({});
    expect(r.team).toBe('lab');
    expect(r.identity.name).toBe('Ui');
    expect(r.identity.token).toBe('mskd_ui');
  });

  it('MUSTERD_* env overrides the binding (same precedence as the MCP adapter)', () => {
    const bindingPath = saveBinding(dir, {
      server: process.env['MUSTERD_SERVER']!,
      team: 'lab',
      member: 'Ui',
      token: 'mskd_ui',
      surface: 'claude-code',
    });
    process.env['MUSTERD_BINDING'] = bindingPath;
    process.env['MUSTERD_TEAM'] = 'lab';
    process.env['MUSTERD_MEMBER'] = 'Api';
    process.env['MUSTERD_TOKEN'] = 'mskd_env';

    const r = resolve({});
    expect(r.identity.name).toBe('Api');
    expect(r.identity.token).toBe('mskd_env');
  });
});

describe('cachedTeamLive (init reuse probe, ADR 016)', () => {
  it('is true for a live team+token, false for a stale token or a missing team', async () => {
    const server = process.env['MUSTERD_SERVER']!;
    await run(teamCommand, ['create', 'dawn', '--as', 'nick']);
    const token = JSON.parse(readFileSync(nickConfig, 'utf8')).identities.dawn.token as string;

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
