import type { Database } from 'better-sqlite3';
import { SCHEMA_V1_SQL } from './schema.js';

export interface Migration {
  version: number;
  up: (db: Database) => void;
}

/** Forward-only migrations, applied in order. No down-migrations in v1. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(SCHEMA_V1_SQL);
      // schema_version is recorded by the migration runner's upsert after up() returns.
    },
  },
  {
    // musterd/0.2 (ADR 010): single-active + 45s reclaim grace. A presence keeps lingering
    // after its connection drops, with `held_until` marking when the hold frees; the reaper
    // sweeps expired holds.
    version: 2,
    up: (db) => {
      db.exec('ALTER TABLE presence ADD COLUMN held_until INTEGER');
    },
  },
];

function currentVersion(db: Database): number {
  const row = db
    .prepare<[], { value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    )
    .get();
  return row ? Number(row.value) : 0;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(name);
  return Boolean(row);
}

/** Apply any migrations with version greater than the stored schema_version, each in a transaction. */
export function runMigrations(db: Database): number {
  const have = tableExists(db, 'schema_meta') ? currentVersion(db) : 0;
  let applied = have;
  for (const m of MIGRATIONS) {
    if (m.version <= applied) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(String(m.version));
    });
    tx();
    applied = m.version;
  }
  return applied;
}
