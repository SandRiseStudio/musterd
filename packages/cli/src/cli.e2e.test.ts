import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args.js';
import { resolve } from './commands/helpers.js';
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
let boConfig: string;

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), 'musterd-cli-'));
  nickConfig = join(dir, 'nick.json');
  boConfig = join(dir, 'bo.json');
  process.env['MUSTERD_CONFIG'] = nickConfig;
});

afterEach(async () => {
  await server.close();
  delete process.env['MUSTERD_SERVER'];
  delete process.env['MUSTERD_CONFIG'];
});

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

    // switch to bo's config and read inbox
    writeFileSync(
      boConfig,
      JSON.stringify({
        server: process.env['MUSTERD_SERVER'],
        current: 'dawn',
        identities: { dawn: { name: 'bo', token: boToken, surface: 'cli' } },
      }),
    );
    process.env['MUSTERD_CONFIG'] = boConfig;

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
    writeFileSync(
      boConfig,
      JSON.stringify({
        server: process.env['MUSTERD_SERVER'],
        current: 'solo',
        identities: { solo: { name: 'pat2', token: tok, surface: 'cli' } },
      }),
    );
    process.env['MUSTERD_CONFIG'] = boConfig;
    const inbox = await run(inboxCommand, []);
    expect(inbox.out).toContain("inbox empty — nobody's mustered anything yet");
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
