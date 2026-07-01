import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig } from '../config.js';
import { requestsCommand } from './requests.js';
import { teamCommand } from './team.js';

describe('requests command', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;
  let agentKey: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-requests-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    // `team create` mints nick as the creator-admin (ADR 071) and auto-binds this folder, so
    // `requests` resolves nick from the binding without an explicit --as.
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
    agentKey = loadConfig().agentKeys['dawn']!;
    await new HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
    }).addMember('dawn', { name: 'Ada', kind: 'agent' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  /** Open a claim request for Ada (no grant → the server holds it pending) and return its id. */
  async function openPendingClaim(): Promise<string> {
    const outcome = await new HttpClient({ server: serverUrl, surface: 'cli' }).claim('dawn', {
      key: agentKey,
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    if (outcome.state !== 'pending') throw new Error(`expected pending, got ${outcome.state}`);
    return outcome.requestId;
  }

  it('renders an empty list without error', async () => {
    const res = await capture(() => requestsCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('no requests waiting');
  });

  it('lists a pending request', async () => {
    await openPendingClaim();
    const res = await capture(() => requestsCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('requests — dawn (1 entry)');
    expect(res.out).toContain('Ada');
    expect(res.out).toContain('pending');
  });

  it('--pending filters to open requests only', async () => {
    const id = await openPendingClaim();
    await new HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
    }).decideRequest('dawn', id, { decision: 'deny' });
    const res = await capture(() => requestsCommand(parseArgs(['--pending'])));
    expect(res.out).toContain('no requests waiting');
  });

  it('emits a parseable JSON array with the protocol shape', async () => {
    await openPendingClaim();
    const res = await capture(() => requestsCommand(parseArgs(['--json'])));
    const arr = JSON.parse(res.out) as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(1);
    expect(arr[0]).toMatchObject({ kind: 'claim', target: 'seat:Ada', status: 'pending' });
  });

  it('decide --approve issues a once grant by default and reports non-delivery', async () => {
    const id = await openPendingClaim();
    const res = await capture(() => requestsCommand(parseArgs(['decide', id, '--approve'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('approved request');
    // The HTTP-originated claim above already returned/exited, so nothing was live to deliver to.
    expect(res.out).toContain('re-run `musterd claim');
  });

  it('decide --approve --ttl-hours mints a ttl-lifetime grant', async () => {
    const id = await openPendingClaim();
    const res = await capture(() =>
      requestsCommand(parseArgs(['decide', id, '--approve', '--ttl-hours', '2'])),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('approved request');
  });

  it('decide --approve --standing mints a standing (survives-relaunch) grant', async () => {
    const id = await openPendingClaim();
    const res = await capture(() =>
      requestsCommand(parseArgs(['decide', id, '--approve', '--standing'])),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('approved request');
  });

  it('decide --deny denies the request', async () => {
    const id = await openPendingClaim();
    const res = await capture(() => requestsCommand(parseArgs(['decide', id, '--deny'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('denied request');
  });

  it('rejects decide with neither or both of --approve/--deny', async () => {
    const id = await openPendingClaim();
    await expect(requestsCommand(parseArgs(['decide', id]))).rejects.toThrow(
      /exactly one of --approve or --deny/,
    );
    await expect(requestsCommand(parseArgs(['decide', id, '--approve', '--deny']))).rejects.toThrow(
      /exactly one of --approve or --deny/,
    );
  });

  it('rejects decide with no id', async () => {
    await expect(requestsCommand(parseArgs(['decide']))).rejects.toThrow(/musterd requests decide/);
  });

  it('rejects combining two grant-lifetime flags', async () => {
    const id = await openPendingClaim();
    await expect(
      requestsCommand(parseArgs(['decide', id, '--approve', '--once', '--ttl-hours', '2'])),
    ).rejects.toThrow(/only one of --once, --standing, or --ttl-hours/);
    await expect(
      requestsCommand(parseArgs(['decide', id, '--approve', '--once', '--standing'])),
    ).rejects.toThrow(/only one of --once, --standing, or --ttl-hours/);
    await expect(
      requestsCommand(parseArgs(['decide', id, '--approve', '--standing', '--ttl-hours', '2'])),
    ).rejects.toThrow(/only one of --once, --standing, or --ttl-hours/);
  });

  it('refuses a non-admin credential with forbidden (exit 5)', async () => {
    await new HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
    }).addMember('dawn', { name: 'Bo', kind: 'agent' });
    const client = new HttpClient({ server: serverUrl, key: agentKey, seat: 'Bo' });
    await expect(client.requests('dawn')).rejects.toMatchObject({ exitCode: 5 });
  });
});
