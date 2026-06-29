import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig } from '../config.js';
import { auditCommand } from './audit.js';
import { reclaimCommand } from './reclaim.js';
import { teamCommand } from './team.js';

describe('audit command', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;
  let nickToken: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-audit-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    // `team create` mints nick as the creator-admin (ADR 071) and auto-binds this folder, so the
    // audit command resolves nick from the binding without an explicit --as.
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
    nickToken = loadConfig().identities['dawn']!.token;
    // Add an agent member to reclaim (the governed op that writes the first audit row).
    await new HttpClient({ server: serverUrl, token: nickToken }).addMember('dawn', {
      name: 'Ada',
      kind: 'agent',
    });
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

  /** Reclaim Ada through the CLI path so a `member.reclaim` audit row is written as nick. */
  async function writeReclaimRow(): Promise<void> {
    await capture(() => reclaimCommand(parseArgs(['Ada'])));
  }

  it('pretty-prints the audit log newest-first with action/target/result', async () => {
    await writeReclaimRow();
    const res = await capture(() => auditCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('audit — dawn (1 entry)');
    expect(res.out).toContain('member.reclaim');
    expect(res.out).toContain('allow');
    expect(res.out).toContain('Ada');
    // The page hint names the oldest entry's ts as the next --before cursor.
    expect(res.out).toMatch(/musterd audit --before \d+ to page older entries/);
  });

  it('emits a parseable JSON array with the protocol shape', async () => {
    await writeReclaimRow();
    const res = await capture(() => auditCommand(parseArgs(['--json'])));
    expect(res.code).toBe(0);
    const arr = JSON.parse(res.out) as unknown[];
    expect(arr).toHaveLength(1);
    const entry = arr[0] as Record<string, unknown>;
    expect(entry).toMatchObject({ action: 'member.reclaim', result: 'allow', target: 'Ada' });
    expect(typeof entry['id']).toBe('string');
    expect(typeof entry['ts']).toBe('number');
  });

  it('caps the listing to --limit', async () => {
    // Two governed ops → two rows, distinct ts (sleep guarantees ms separation for --before paging).
    await writeReclaimRow();
    await new Promise((r) => setTimeout(r, 5));
    await new HttpClient({ server: serverUrl, token: nickToken }).addMember('dawn', {
      name: 'Bo',
      kind: 'agent',
    });
    await capture(() => reclaimCommand(parseArgs(['Bo'])));

    const res = await capture(() => auditCommand(parseArgs(['--limit', '1'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('(1 entry)');
    expect(res.out).toContain('member.reclaim');
    // Only the newest row (Bo) is present, not Ada.
    expect(res.out).toContain('Bo');
    expect(res.out).not.toContain('Ada');
  });

  it('pages older entries with --before <ts>', async () => {
    await writeReclaimRow(); // older row: Ada
    await new Promise((r) => setTimeout(r, 5));
    await new HttpClient({ server: serverUrl, token: nickToken }).addMember('dawn', {
      name: 'Bo',
      kind: 'agent',
    });
    await capture(() => reclaimCommand(parseArgs(['Bo']))); // newer row: Bo

    // Read the newest entry's ts, then page beneath it to surface only the older Ada row.
    const head = await new HttpClient({ server: serverUrl, token: nickToken }).audit('dawn', {
      limit: 1,
    });
    const newestTs = head.audit[0]!.ts;
    const res = await capture(() => auditCommand(parseArgs(['--before', String(newestTs)])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('Ada');
    expect(res.out).not.toContain('Bo');
  });

  it('renders an empty log without error', async () => {
    const res = await capture(() => auditCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('no governed decisions recorded yet');
  });

  it('rejects --limit outside 1..500', async () => {
    await expect(auditCommand(parseArgs(['--limit', '0']))).rejects.toThrow(/1\.\.500/);
    await expect(auditCommand(parseArgs(['--limit', '501']))).rejects.toThrow(/1\.\.500/);
  });

  it('rejects a non-positive --before', async () => {
    await expect(auditCommand(parseArgs(['--before', '0']))).rejects.toThrow(/positive ms-epoch/);
    await expect(auditCommand(parseArgs(['--before', '-1']))).rejects.toThrow(/positive ms-epoch/);
  });

  it('refuses a non-admin token with forbidden (exit 5)', async () => {
    const ada = await new HttpClient({ server: serverUrl, token: nickToken }).addMember('dawn', {
      name: 'Ada2',
      kind: 'agent',
    });
    const client = new HttpClient({ server: serverUrl, token: ada.token });
    await expect(client.audit('dawn')).rejects.toMatchObject({ exitCode: 5 });
  });

  it('treats an unknown action as an open string (parses, does not reject)', async () => {
    // A P3-style verb must survive the schema boundary so the CLI renders it plainly instead of
    // erroring — the open-string action contract (ADR 074). Confirms forward-compat with P3 verbs.
    const { AuditResponseSchema } = await import('@musterd/protocol');
    const parsed = AuditResponseSchema.safeParse({
      audit: [
        {
          id: 'x',
          ts: 1,
          actor: 'nick',
          action: 'grant.role',
          target: 'Ada',
          result: 'allow',
          detail: null,
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.audit[0]?.action).toBe('grant.role');
  });
});
