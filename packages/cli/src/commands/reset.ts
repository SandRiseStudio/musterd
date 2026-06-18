import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { flagStr, type Parsed } from '../args.js';
import { configPath, loadConfig, saveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

/**
 * Wipe the local daemon back to a clean slate (ADR 022): delete the SQLite db (every team, member,
 * presence, and message) and clear the local CLI identities/bindings, so a fresh `musterd serve`
 * starts empty. Pure filesystem + config — it never imports the server (ADR 002) or opens the db;
 * it talks to a running daemon only through the read-only `/health` probe to refuse while live.
 */
export async function resetCommand(parsed: Parsed): Promise<number> {
  const force = Boolean(parsed.flags['force'] || parsed.flags['yes']);
  const noBackup = Boolean(parsed.flags['no-backup']);
  const dbPath = resolveDbPath();
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? process.env['MUSTERD_SERVER'] ?? config.server;

  // 1) Refuse while a daemon is live on *this* db — deleting an open SQLite file leaves the daemon
  // writing to a ghost inode (the wrong-db dogfood failure, ADR 016). A daemon on another db is fine.
  const servedDb = await probeServedDb(server);
  if (servedDb && samePath(servedDb, dbPath)) {
    throw new CliError(
      `a daemon is live and serving this db (${dbPath}).\n` +
        `  Stop it first (ctrl-c in its terminal), then re-run musterd reset.`,
      11,
    );
  }

  const identityCount = Object.keys(config.identities).length;
  const dbExists = existsSync(dbPath);
  if (!dbExists && identityCount === 0 && Object.keys(config.bindings).length === 0) {
    process.stdout.write(`${theme.ok('✓')} already a clean slate — nothing to reset\n`);
    return 0;
  }

  // 2) Confirm — interactive y/N on a TTY; otherwise require --force so scripts can't wipe silently.
  if (!force) {
    if (!process.stdin.isTTY) {
      throw new CliError('refusing to reset without confirmation — re-run with --force', 2);
    }
    process.stdout.write(
      `${theme.accent('musterd reset')} will permanently wipe:\n` +
        `  • the database at ${theme.meta(dbPath)} (all teams, members, sessions, messages)\n` +
        `  • ${identityCount} local ${identityCount === 1 ? 'identity' : 'identities'} in ${theme.meta(configPath())}\n` +
        (noBackup
          ? `  ${theme.err('no backup')} (--no-backup)\n`
          : `  (a backup is written first)\n`),
    );
    if (!(await confirm('proceed?'))) {
      process.stdout.write('aborted — nothing was changed\n');
      return 0;
    }
  }

  // 3) Back up the db + config before destroying (unless opted out).
  let backupNote = '';
  if (!noBackup && (dbExists || existsSync(configPath()))) {
    const stamp = timestamp();
    const backupDir = join(dirname(dbPath), 'backups');
    mkdirSync(backupDir, { recursive: true });
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, configPath()]) {
      if (existsSync(f)) copyFileSync(f, join(backupDir, `${basename(f)}.${stamp}.bak`));
    }
    backupNote = `\n  ${theme.meta(`backup: ${backupDir}/*.${stamp}.bak`)}`;
  }

  // 4) Wipe the db (+ wal/shm) and reset the local config to a clean slate, keeping the server URL.
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  saveConfig({ server: config.server, identities: {}, bindings: {} });

  process.stdout.write(
    `${theme.ok('✓')} reset — wiped ${theme.meta(dbPath)}; ` +
      `cleared ${identityCount} local ${identityCount === 1 ? 'identity' : 'identities'}.` +
      backupNote +
      `\n  Start fresh: ${theme.accent('musterd serve')} then ${theme.accent('musterd init')}.\n`,
  );
  return 0;
}

/** The db path the daemon would open — re-derived here to avoid importing @musterd/server (ADR 002). */
function resolveDbPath(): string {
  return process.env['MUSTERD_DB'] ?? join(homedir(), '.musterd', 'musterd.db');
}

/** Probe a daemon's unauthenticated /health and return the db path it serves, or null if none. */
async function probeServedDb(server: string): Promise<string | null> {
  try {
    const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { db?: string };
    return body.db ?? null;
  } catch {
    return null;
  }
}

/** Compare two filesystem paths, resolving symlinks/spelling where the files exist. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolvePath(p);
    }
  };
  return norm(a) === norm(b);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      res(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
