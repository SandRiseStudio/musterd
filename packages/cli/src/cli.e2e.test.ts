import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { parseArgs } from './args.js';
import { teamCommand } from './commands/team.js';
import { sendCommand } from './commands/send.js';
import { inboxCommand } from './commands/inbox.js';
import { statusCommand } from './commands/status.js';

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
      JSON.stringify({ server: process.env['MUSTERD_SERVER'], current: 'dawn', identities: { dawn: { name: 'bo', token: boToken, surface: 'cli' } } }),
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
      JSON.stringify({ server: process.env['MUSTERD_SERVER'], current: 'solo', identities: { solo: { name: 'pat2', token: tok, surface: 'cli' } } }),
    );
    process.env['MUSTERD_CONFIG'] = boConfig;
    const inbox = await run(inboxCommand, []);
    expect(inbox.out).toContain("inbox empty — nobody's mustered anything yet");
  });
});
