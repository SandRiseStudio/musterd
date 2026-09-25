import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { type Migration, runMigrations, schemaVersion } from './migrations.js';

/**
 * The trace store (ADR 445 §3): a **separate database file**, `trace.db` beside `musterd.db`, with
 * its own forward-only ladder. Per-call rows with (from increment 1b) up to 256 KiB of content each
 * outgrow the coordination store within weeks, and the daemon wedged twice on 2026-09-24 in
 * synchronous SQLite work on `musterd.db` — so the trace store must add nothing to that file's size,
 * lock contention or backup weight. Nothing joins across the two files at write time: `team_id` and
 * the seat name are carried as plain text (no FK can cross a database), and the join key to the
 * coordination store is `(session_digest, tool_use_id)`, present in both.
 *
 * The ladder is checked by `pnpm migrations:check` alongside the main one (both files are parsed);
 * the version lives in this file's own `schema_meta`, never `musterd.db`'s.
 */
export const TRACE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE schema_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        -- One row per hook event (ADR 445 §3): structural columns only in increment 1a. The
        -- \`content\` column exists so 1b needs no rebuild, and stays NULL until the credential scrub
        -- and the \`trace.content\` team setting land — the store's writer has no parameter for it.
        CREATE TABLE trace_events (
          id              TEXT PRIMARY KEY,
          team_id         TEXT NOT NULL,
          seat            TEXT NOT NULL,
          session_digest  TEXT NOT NULL,
          seq             INTEGER NOT NULL,
          ts              INTEGER NOT NULL,
          received_at     INTEGER NOT NULL,
          harness         TEXT NOT NULL,
          kind            TEXT NOT NULL,
          tool_name       TEXT,
          tool_use_id     TEXT,
          agent_id        TEXT,
          parent_agent_id TEXT,
          duration_ms     INTEGER,
          outcome         TEXT,
          detail          TEXT,
          content         TEXT,
          redactions      INTEGER,
          truncated       INTEGER NOT NULL DEFAULT 0,
          UNIQUE (team_id, session_digest, seq)
        );
        CREATE INDEX idx_trace_events_seat_ts ON trace_events (team_id, seat, ts);
        CREATE INDEX idx_trace_events_tool_use ON trace_events (team_id, tool_use_id);
      `);
    },
  },
];

/**
 * Open (creating if needed) the trace store and bring it to the current ladder. Same pragmas and
 * 0600 posture as {@link openDb}; `:memory:` for tests.
 */
export function openTraceDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, TRACE_MIGRATIONS);
  if (path !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    }
  }
  return db;
}

/** The trace ladder's applied version (0 if unmigrated) — for `/health` and the serve log. */
export function traceSchemaVersion(db: Database.Database): number {
  return schemaVersion(db);
}
