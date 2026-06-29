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
import { HttpClient } from '../client.js';
import { saveBinding } from '../config.js';
import { writePending } from '../onboard/pending.js';
import { claimCommand } from './claim.js';

let server: RunningServer;
let dir: string;
let cwd: string;

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), 'musterd-claim-'));
  process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
  cwd = mkdtempSync(join(tmpdir(), 'musterd-claim-cwd-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  // Stand up the team the seats are claimed against.
  await new HttpClient({ server: process.env['MUSTERD_SERVER']! }).createTeam('dawn', {
    name: 'nick',
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  delete process.env['MUSTERD_SERVER'];
  delete process.env['MUSTERD_CONFIG'];
  delete process.env['MUSTERD_TEAM'];
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
  const raw = readFileSync(join(cwd, BINDING_DIR, BINDING_FILE), 'utf8');
  return BindingSchema.parse(JSON.parse(raw));
}

describe('musterd claim (L2 floor, ADR 032)', () => {
  it('claims a named seat by auto-minting it and binds the folder to it', async () => {
    const { code, out } = await run(['Ada', '--team', 'dawn']);
    expect(code).toBe(0);
    expect(out).toContain('Ada');
    const b = readBinding();
    expect(b.member).toBe('Ada');
    expect(b.token).toMatch(/^mskd_/);
    expect(b.claim).toEqual({ mode: 'seat', name: 'Ada' });
  });

  it("re-occupies the folder's own already-bound seat without re-minting (reused)", async () => {
    const first = await run(['Ada', '--team', 'dawn']);
    const token = readBinding().token;
    const again = await run(['Ada', '--team', 'dawn']);
    expect(first.code).toBe(0);
    expect(again.code).toBe(0);
    expect(again.out).toContain('reclaimed your seat');
    expect(readBinding().token).toBe(token); // same token: not a fresh mint
  });

  it('refuses a name already on the team this folder has no token for (claim_conflict)', async () => {
    // Mint Ada from a *different* folder so this one doesn't hold the token.
    await new HttpClient({ server: process.env['MUSTERD_SERVER']! }).addMember('dawn', {
      name: 'Ada',
      kind: 'agent',
    });
    await expect(run(['Ada', '--team', 'dawn'])).rejects.toMatchObject({ exitCode: 9 });
  });

  it('the name-conflict error names a runnable next step (ADR 055 no-dead-end)', async () => {
    await new HttpClient({ server: process.env['MUSTERD_SERVER']! }).addMember('dawn', {
      name: 'Ada',
      kind: 'agent',
    });
    await expect(run(['Ada', '--team', 'dawn'])).rejects.toMatchObject({
      message: expect.stringContaining('musterd claim Ada --token'),
    });
  });

  it('adopts a teammate-created seat by its token, binding the folder with no clobber (ADR 055)', async () => {
    // A teammate's `team add` minted Ada elsewhere and printed its token (the hand-off code).
    const res = await new HttpClient({ server: process.env['MUSTERD_SERVER']! }).addMember('dawn', {
      name: 'Ada',
      kind: 'agent',
    });
    const token = res.token as string;
    const { code, out } = await run(['Ada', '--team', 'dawn', '--token', token]);
    expect(code).toBe(0);
    expect(out).toContain('adopted the seat');
    const b = readBinding();
    expect(b.member).toBe('Ada');
    expect(b.token).toBe(token); // the handed-off token, not a fresh mint
  });

  it('refuses an adopt token that does not authenticate (ADR 055)', async () => {
    await new HttpClient({ server: process.env['MUSTERD_SERVER']! }).addMember('dawn', {
      name: 'Ada',
      kind: 'agent',
    });
    await expect(
      run(['Ada', '--team', 'dawn', '--token', 'mskd_bogusbogusbogus']),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('refuses an adopt token that belongs to a different seat (ADR 055)', async () => {
    const http = new HttpClient({ server: process.env['MUSTERD_SERVER']! });
    await http.addMember('dawn', { name: 'Ada', kind: 'agent' });
    const bob = await http.addMember('dawn', { name: 'Bob', kind: 'agent' });
    await expect(
      run(['Ada', '--team', 'dawn', '--token', bob.token as string]),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('claims the next open pool seat for a role', async () => {
    const first = await run(['--role', 'backend', '--team', 'dawn']);
    expect(first.code).toBe(0);
    expect(readBinding().member).toBe('backend-1');
    const second = await run(['--role', 'backend', '--team', 'dawn']);
    expect(second.code).toBe(0);
    expect(readBinding().member).toBe('backend-2');
  });

  it('uses the folder claim policy when no target is given', async () => {
    saveBinding(cwd, {
      server: process.env['MUSTERD_SERVER']!,
      team: 'dawn',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'Polly' },
    });
    const { code } = await run([]);
    expect(code).toBe(0);
    expect(readBinding().member).toBe('Polly');
  });

  it('refuses to clobber a folder bound to a currently-live different member (ADR 066)', async () => {
    // Bind this folder to Ada and make her live (a presence attachment on the roster).
    await run(['Ada', '--team', 'dawn']);
    const token = readBinding().token;
    await new HttpClient({ server: process.env['MUSTERD_SERVER']!, token }).presence('dawn', 'cli');
    // Claiming a *different* seat here would silently evict the live Ada — refuse (exit 2).
    await expect(run(['Bob', '--team', 'dawn'])).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('musterd agent'),
    });
    // The binding is untouched and no Bob seat was minted (guard runs before any mint).
    expect(readBinding().member).toBe('Ada');
    const { members } = await new HttpClient({ server: process.env['MUSTERD_SERVER']! }).roster(
      'dawn',
    );
    expect(members.some((m) => m.name === 'Bob')).toBe(false);
  });

  it('--force repoints a folder bound to a live member anyway (ADR 066)', async () => {
    await run(['Ada', '--team', 'dawn']);
    const token = readBinding().token;
    await new HttpClient({ server: process.env['MUSTERD_SERVER']!, token }).presence('dawn', 'cli');
    const { code } = await run(['Bob', '--team', 'dawn', '--force']);
    expect(code).toBe(0);
    expect(readBinding().member).toBe('Bob');
  });

  it('does not refuse when the bound member is offline (stale seat is reclaimable, ADR 066)', async () => {
    // Bind to Ada but never register a presence — she is offline, so claiming elsewhere is benign.
    await run(['Ada', '--team', 'dawn']);
    const { code } = await run(['Bob', '--team', 'dawn']);
    expect(code).toBe(0);
    expect(readBinding().member).toBe('Bob');
  });

  it('re-occupying our own live seat is never a clobber (ADR 066)', async () => {
    await run(['Ada', '--team', 'dawn']);
    const token = readBinding().token;
    await new HttpClient({ server: process.env['MUSTERD_SERVER']!, token }).presence('dawn', 'cli');
    const { code, out } = await run(['Ada', '--team', 'dawn']);
    expect(code).toBe(0);
    expect(out).toContain('reclaimed your seat');
  });

  it('lists waiting sessions and requires --for when several are pending', async () => {
    writePending(cwd, {
      code: 'AB12',
      team: 'dawn',
      workspace: cwd,
      surface: 'claude-code',
      connId: 'c1',
      ts: 1,
    });
    writePending(cwd, {
      code: 'CD34',
      team: 'dawn',
      workspace: cwd,
      surface: 'cursor',
      connId: 'c2',
      ts: 2,
    });
    await expect(run(['Ada', '--team', 'dawn'])).rejects.toMatchObject({ exitCode: 2 });
    const ok = await run(['Ada', '--team', 'dawn', '--for', 'AB12']);
    expect(ok.code).toBe(0);
  });

  it('hands the seat to a waiting session via a resolution sidecar, clearing the marker (ADR 034)', async () => {
    writePending(cwd, {
      code: 'AB12',
      team: 'dawn',
      workspace: cwd,
      surface: 'claude-code',
      connId: 'c1',
      ts: 1,
    });
    const { out } = await run(['Ada', '--team', 'dawn', '--for', 'AB12']);
    expect(out).toContain('going online as Ada now');
    // marker consumed, resolution dropped with the token
    expect(existsSync(join(cwd, BINDING_DIR, PENDING_DIR, 'AB12.json'))).toBe(false);
    const resolved = JSON.parse(
      readFileSync(join(cwd, BINDING_DIR, PENDING_DIR, `AB12${RESOLVED_SUFFIX}`), 'utf8'),
    );
    expect(resolved.member).toBe('Ada');
    expect(resolved.token).toMatch(/^mskd_/);
  });
});
