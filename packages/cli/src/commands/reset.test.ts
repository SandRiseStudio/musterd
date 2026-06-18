import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { CliError } from '../errors.js';
import { resetCommand } from './reset.js';

let dir: string;
let dbPath: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-reset-'));
  dbPath = join(dir, 'musterd.db');
  configPath = join(dir, 'config.json');
  process.env['MUSTERD_DB'] = dbPath;
  process.env['MUSTERD_CONFIG'] = configPath;
  // Point at a dead port so the live-daemon probe fails (→ proceed) unless a test starts one.
  process.env['MUSTERD_SERVER'] = 'http://127.0.0.1:1';
});

afterEach(() => {
  delete process.env['MUSTERD_DB'];
  delete process.env['MUSTERD_CONFIG'];
  delete process.env['MUSTERD_SERVER'];
});

/** Run resetCommand with captured stdout. */
async function run(argv: string[]) {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    chunks.push(String(c));
    return true;
  });
  try {
    const code = await resetCommand(parseArgs(argv));
    return { code, out: chunks.join('') };
  } finally {
    spy.mockRestore();
  }
}

function seedState() {
  writeFileSync(dbPath, 'sqlite-bytes');
  writeFileSync(`${dbPath}-wal`, 'wal');
  writeFileSync(`${dbPath}-shm`, 'shm');
  writeFileSync(
    configPath,
    JSON.stringify({
      server: 'http://localhost:4849',
      current: 'dawn',
      identities: { dawn: { name: 'nick', token: 'mskd_x', surface: 'cli' } },
      bindings: {},
    }),
  );
}

describe('musterd reset (ADR 022)', () => {
  it('wipes the db (+ wal/shm) and clears local identities', async () => {
    seedState();
    const { code, out } = await run(['--force', '--no-backup']);
    expect(code).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.identities).toEqual({});
    expect(config.bindings).toEqual({});
    expect(config.current).toBeUndefined();
    expect(config.server).toBe('http://127.0.0.1:1'); // server URL preserved (resolved value, not wiped)
    expect(out).toContain('reset');
  });

  it('writes a backup before destroying unless --no-backup', async () => {
    seedState();
    await run(['--force']);
    const backups = readdirSync(join(dir, 'backups'));
    expect(backups.some((f) => f.startsWith('musterd.db.'))).toBe(true);
    expect(backups.some((f) => f.startsWith('config.json.'))).toBe(true);
    expect(existsSync(dbPath)).toBe(false); // still wiped after backup
  });

  it('refuses while a daemon is live on the target db', async () => {
    let server: RunningServer | undefined;
    try {
      server = createServer({ dbPath, port: 0 });
      const { port } = await server.listen();
      process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
      await expect(run(['--force'])).rejects.toMatchObject({
        exitCode: 11,
      } satisfies Partial<CliError>);
      expect(existsSync(dbPath)).toBe(true); // not wiped
    } finally {
      await server?.close();
    }
  });

  it('refuses to wipe without confirmation on a non-TTY (no --force)', async () => {
    seedState();
    await expect(run([])).rejects.toBeInstanceOf(CliError);
    expect(existsSync(dbPath)).toBe(true); // untouched
  });

  it('is a friendly no-op when already a clean slate', async () => {
    const { code, out } = await run(['--force']);
    expect(code).toBe(0);
    expect(out).toContain('clean slate');
  });
});
