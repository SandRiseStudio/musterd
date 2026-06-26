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
  {
    // musterd/0.2 (ADR 014): provenance/where-on-attach seed. Two facts captured once at attach —
    // `provenance` (why this presence exists) and `workspace` (the gracefully-degrading "where"
    // label). Both nullable; pre-0.2 rows and clients that don't send them simply read null.
    version: 3,
    up: (db) => {
      db.exec('ALTER TABLE presence ADD COLUMN provenance TEXT');
      db.exec('ALTER TABLE presence ADD COLUMN workspace TEXT');
    },
  },
  {
    // musterd/0.2 (ADR 021): driver co-presence. `driver` names the human steering an agent's
    // session, captured once at attach so the roster can say "driven by nick" instead of showing
    // the driving human offline. Nullable; clients that don't send it (or non-human-driven
    // presences) simply read null. Additive, like the ADR 014 columns above.
    version: 4,
    up: (db) => {
      db.exec('ALTER TABLE presence ADD COLUMN driver TEXT');
    },
  },
  {
    // musterd/0.3 (ADR 025): the terminal `resolve` act (thread-close). The `act` CHECK is frozen in
    // the v1 DDL and SQLite can't ALTER a CHECK in place, so rebuild the `messages` table with the
    // widened constraint and copy the log across. Safe with foreign_keys ON: no table references
    // `messages`, and the copied rows still reference live teams/members.
    version: 5,
    up: (db) => {
      db.exec(`
        CREATE TABLE messages_new (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          from_member TEXT NOT NULL REFERENCES members(id),
          to_kind     TEXT NOT NULL CHECK (to_kind IN ('member','team','broadcast')),
          to_member   TEXT REFERENCES members(id),
          act         TEXT NOT NULL CHECK (act IN
                        ('message','status_update','request_help','handoff','accept','decline','wait','resolve')),
          body        TEXT NOT NULL DEFAULT '',
          thread_id   TEXT,
          meta        TEXT,
          ts          INTEGER NOT NULL,
          created_at  INTEGER NOT NULL
        );
        INSERT INTO messages_new SELECT * FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;
        CREATE INDEX idx_messages_team_ts ON messages(team_id, ts);
        CREATE INDEX idx_messages_thread ON messages(thread_id);
        CREATE INDEX idx_messages_to_member ON messages(to_member);
      `);
    },
  },
  {
    // musterd/0.3 (ADR 058, seat-lifecycle-as-files.md + migration-bootstrap.md): the held/unheld bit.
    // `bound_at` is set on a seat's first authenticated touch and distinguishes a *held* seat (a
    // teammate holds its token) from a merely *declared* one — durable across the holder going offline,
    // which presence deliberately is not (ADR 057). Backfill every existing row to `created_at`: under
    // the pre-058 model mint == delivery, so each legacy member is already held; a null would let a
    // stray `claim` rotate a live token out from under an active session.
    version: 6,
    up: (db) => {
      db.exec('ALTER TABLE members ADD COLUMN bound_at INTEGER');
      db.exec('UPDATE members SET bound_at = created_at');
    },
  },
  {
    // Read-only observer seats (ADR 063): a member that watches the firehose but is hidden from the
    // roster/counts/presence and can't send. Existing rows are participants (0).
    version: 7,
    up: (db) => {
      db.exec('ALTER TABLE members ADD COLUMN observer INTEGER NOT NULL DEFAULT 0');
    },
  },
];

function currentVersion(db: Database): number {
  const row = db
    .prepare<[], { value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get();
  return row ? Number(row.value) : 0;
}

/** The applied schema version (0 if unmigrated). Surfaced in `/health` + serve logs for diagnostics. */
export function schemaVersion(db: Database): number {
  return tableExists(db, 'schema_meta') ? currentVersion(db) : 0;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare<
      [string],
      { name: string }
    >("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
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
