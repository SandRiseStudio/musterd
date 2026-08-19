import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

export type { Database } from 'better-sqlite3';

/**
 * Open (or create) the database at `path` (or ':memory:'), set PRAGMAs, run migrations.
 * Pass ':memory:' for tests.
 */
export function openDb(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  if (path !== ':memory:') {
    // The db holds message bodies, credentials-adjacent audit rows and the whole team's traffic;
    // better-sqlite3 creates it with the process umask (644 on a stock mac — world-readable).
    // Tighten to owner-only on every open, not just create, so installs that predate this fix are
    // repaired the next time the daemon starts. WAL/SHM siblings carry the same bytes in flight,
    // and SQLite creates them with the same umask, so they get the same treatment.
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    }
  }
  return db;
}
