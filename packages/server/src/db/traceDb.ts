import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
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
  {
    version: 2,
    up: (db) => {
      db.exec(`
        -- The content lifecycle (ADR 445 increment 3a). A pruned row keeps every structural column
        -- and says WHEN its content went, so a NULL content column reads as "pruned" or "never
        -- captured" rather than one ambiguous absence.
        ALTER TABLE trace_events ADD COLUMN content_pruned_at INTEGER;
        -- The prune's scan: only rows still holding content, oldest first. Partial, so it stays the
        -- size of the live content window, not of the whole structural history.
        CREATE INDEX idx_trace_events_content_age ON trace_events (received_at)
          WHERE content IS NOT NULL;
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        -- Replication (ADR 453 §2): which node minted the row. NULL means this daemon did; a node
        -- id means the hub received it over /sync/trace from that joiner. Indexed for the
        -- replication read-back and the eval's "replicated?" split.
        ALTER TABLE trace_events ADD COLUMN origin_node TEXT;
        CREATE INDEX idx_trace_events_origin ON trace_events (team_id, origin_node);
      `);
    },
  },
];

/**
 * ADR 453 §2: the joiner's per-machine key for digesting opaque harness ids on their way to the hub.
 * A random 32-byte secret, generated once into this file's `schema_meta`, never sent or logged, and
 * kept for the file's lifetime so one id always digests the same way here. NOT the agent key behind
 * `session_digest` — the daemon holds only that key's hash (ADR 131 §5).
 */
export const SYNC_TRACE_ID_KEY = 'sync_trace_id_key';

/** ADR 453 §4: the pusher's cursor per team — the highest `rowid` the hub has acked. Lives in the
 *  trace store because it describes rows of THIS file, never in `musterd.db`. */
export function syncTraceCursorKey(teamId: string): string {
  return `sync_trace_cursor:${teamId}`;
}

/**
 * The `schema_meta` key `pnpm corpus:snapshot` stamps after it has captured `trace.db`: the highest
 * `received_at` in the captured image (ADR 445 §3, "pruned unless corpus:snapshot captured it").
 * Its presence is what makes this machine an archiving one — see {@link pruneTraceContent}.
 */
export const CONTENT_CAPTURED_THROUGH_KEY = 'content_captured_through';

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

/**
 * The trace store's size on disk — the file plus its WAL, which is where a busy tap's recent writes
 * sit until checkpoint (ADR 445 §Consequences: "`musterd status` reports the file's size"). Undefined
 * for `:memory:` or an unreadable path: absence, never a made-up zero.
 */
export function traceDbBytes(path: string): number | undefined {
  if (path === ':memory:' || path === '') return undefined;
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try {
      total += statSync(path + suffix).size;
    } catch {
      if (suffix === '') return undefined;
    }
  }
  return total;
}
