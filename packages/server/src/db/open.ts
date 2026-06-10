import { mkdirSync } from 'node:fs';
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
  return db;
}
