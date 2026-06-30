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
  // Stand up the team; capture the v0.3 composite mint (SPEC A.7): the team agent key + creator token.
  const team = (await new HttpClient({ server: serverUrl }).createTeam('dawn', { name: 'nick' })) as {
    agent_key: string;
    token: string;
  };
  agentKey = team.agent_key;
  adminToken = team.token;
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
  return BindingSchema.parse(JSON.parse(readFileSync(join(cwd, BINDING_DIR, BINDING_FILE), 'utf8')));
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

  it('without a grant, a claim opens a pending request (admin must approve)', async () => {
    await declareSeat('Ada');
    const { code, out } = await run(['Ada', '--team', 'dawn']);
    expect(code).toBe(0);
    expect(out).toMatch(/pending|approve/i);
    // No binding is written for a pending claim (the seat isn't occupied yet).
    expect(existsSync(join(cwd, BINDING_DIR, BINDING_FILE))).toBe(false);
  });

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
    const ga = await grant('Ada');
    await run(['Ada', '--team', 'dawn', '--grant', ga]); // bind + occupy Ada (now live/active)
    const gb = await grant('Bob');
    await expect(run(['Bob', '--team', 'dawn', '--grant', gb])).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('musterd agent'),
    });
    expect(readBinding().claim).toEqual({ mode: 'seat', name: 'Ada' }); // untouched
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
    writePending(cwd, { code: 'AB12', team: 'dawn', workspace: cwd, surface: 'claude-code', connId: 'c1', ts: 1 });
    writePending(cwd, { code: 'CD34', team: 'dawn', workspace: cwd, surface: 'cursor', connId: 'c2', ts: 2 });
    await expect(run(['Ada', '--team', 'dawn', '--grant', g])).rejects.toMatchObject({ exitCode: 2 });
    const ok = await run(['Ada', '--team', 'dawn', '--grant', g, '--for', 'AB12']);
    expect(ok.code).toBe(0);
  });

  it('hands the seat to a waiting session via a resolution sidecar carrying the seat (ADR 034)', async () => {
    await declareSeat('Ada');
    const g = await grant('Ada');
    writePending(cwd, { code: 'AB12', team: 'dawn', workspace: cwd, surface: 'claude-code', connId: 'c1', ts: 1 });
    const { out } = await run(['Ada', '--team', 'dawn', '--grant', g, '--for', 'AB12']);
    expect(out).toContain('going online as Ada now');
    expect(existsSync(join(cwd, BINDING_DIR, PENDING_DIR, 'AB12.json'))).toBe(false);
    const resolved = JSON.parse(
      readFileSync(join(cwd, BINDING_DIR, PENDING_DIR, `AB12${RESOLVED_SUFFIX}`), 'utf8'),
    );
    expect(resolved.seat).toBe('Ada'); // v0.3: the resolution carries the seat, not member+token
  });
});
