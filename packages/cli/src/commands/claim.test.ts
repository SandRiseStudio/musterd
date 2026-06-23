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
