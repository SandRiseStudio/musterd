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
  {
    // v0.3 P1 seats data model (ADR 070 / ADR 069). Additive + backward-compatible: a NULL
    // `account_status` is the derived provisioned/active state, and NULL `capabilities` is the
    // generalist default — so existing rows behave exactly as before until reconcile projects the
    // file-backed values. No row-migration code (the durable values come from the git files); the
    // one-shot reset stays the documented fallback for a db-only team (ADR 069 decision 1).
    version: 8,
    up: (db) => {
      // Admin-set account-status override (disabled/banned/archived); NULL ⇒ derived from occupancy.
      db.exec('ALTER TABLE members ADD COLUMN account_status TEXT');
      // Resolved effective capabilities (JSON); NULL ⇒ generalist default.
      db.exec('ALTER TABLE members ADD COLUMN capabilities TEXT');
      // Role defaults (ADR 070), projected from roles/<name>.toml. capabilities is a partial JSON.
      db.exec(
        `CREATE TABLE roles (
           team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           name TEXT NOT NULL,
           capabilities TEXT NOT NULL DEFAULT '{}',
           charter TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (team_id, name)
         )`,
      );
    },
  },
  {
    // v0.3 P2 governance audit log (ADR 071 / ADR 069). The append-only coordination-governance trace:
    // every governed decision (urgent flagged/denied, send denied, member reclaim/remove, observe denied;
    // P3 adds grant/claim/account-status/key/policy/request verbs) writes one row. Additive — existing
    // teams gain an empty log, no reset needed. `actor`/`target` are seat *names* (nullable: system writes
    // have no actor); `result` is the authz outcome (allow|deny); `detail` is a JSON context blob, never
    // secrets. No update/delete — the table is the audit trail.
    version: 9,
    up: (db) => {
      db.exec(
        `CREATE TABLE audit (
           id         TEXT PRIMARY KEY,
           team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           ts         INTEGER NOT NULL,
           actor      TEXT,
           action     TEXT NOT NULL,
           target     TEXT,
           result     TEXT NOT NULL CHECK (result IN ('allow','deny')),
           detail     TEXT,
           created_at INTEGER NOT NULL
         )`,
      );
      db.exec('CREATE INDEX idx_audit_team_ts ON audit(team_id, ts)');
    },
  },
  {
    // v0.3 P3.1 credential/grant substrate (ADR 076 / ADR 069). Additive: team-scoped secrets
    // (agent_key_hash, policy JSON) on `teams`, per-human `credential_hash` on `members`, plus the
    // `grants` + `requests` tables. Nothing is enforced until the P3 cutover wires it — existing
    // token auth is untouched (a team with no agent key / no grants behaves exactly as v0.2). Only
    // hashes are stored (SPEC A.2); plaintext is shown once at mint and never persisted. `scope`,
    // `lifetime`, `kind`, `status` are open TEXT (no CHECK) so widening the vocabulary later needs no
    // table rebuild (the v5 CHECK-rebuild trap). The one-shot reset stays the db-only fallback.
    version: 10,
    up: (db) => {
      // Team-scoped: one rotatable agent key (hash) + governance policy JSON. NULL until an admin sets.
      db.exec('ALTER TABLE teams ADD COLUMN agent_key_hash TEXT');
      db.exec('ALTER TABLE teams ADD COLUMN policy TEXT');
      // Per-human credential (hash); NULL for agent seats and pre-P3 rows.
      db.exec('ALTER TABLE members ADD COLUMN credential_hash TEXT');
      // Admin-issued authorizations to claim a seat/role. token_hash is the sha256 of the msgr_ secret.
      db.exec(
        `CREATE TABLE grants (
           id         TEXT PRIMARY KEY,
           team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           scope      TEXT NOT NULL,
           target     TEXT NOT NULL,
           token_hash TEXT NOT NULL,
           issued_by  TEXT,
           lifetime   TEXT NOT NULL,
           expires_at INTEGER,
           single_use INTEGER NOT NULL DEFAULT 0,
           revoked    INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL
         )`,
      );
      db.exec('CREATE INDEX idx_grants_team ON grants(team_id)');
      db.exec('CREATE INDEX idx_grants_token_hash ON grants(token_hash)');
      // The request/approval lane. Dedup by (team, from_session, target) is enforced in the store.
      // `from_session` holds the WS connId (the claim's origin); `target` is the encoded ClaimTarget
      // (`seat:<n>` | `role:<n>` | `observe`). `surface` + `expires_at` back the admin approval card
      // (ADR 077): the surface badge and the expiry countdown / reaper WHERE clause.
      db.exec(
        `CREATE TABLE requests (
           id           TEXT PRIMARY KEY,
           team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           kind         TEXT NOT NULL,
           from_session TEXT NOT NULL,
           target       TEXT,
           surface      TEXT NOT NULL DEFAULT 'cli',
           status       TEXT NOT NULL,
           decided_by   TEXT,
           created_at   INTEGER NOT NULL,
           expires_at   INTEGER NOT NULL
         )`,
      );
      db.exec('CREATE INDEX idx_requests_team ON requests(team_id, created_at)');
      db.exec('CREATE INDEX idx_requests_expiry ON requests(status, expires_at)');
      db.exec('CREATE INDEX idx_requests_dedup ON requests(team_id, from_session, target)');
    },
  },
  {
    // v11 — coordination lanes, Phase 1 (ADR 083): the { work-item × owner × surface } unit. Additive
    // (one new table, no drops/alters). `surface_globs`/`depends_on` are JSON arrays; `state` is open
    // TEXT (no CHECK — the v5 rebuild trap); `owner_seat` stores the seat *name* (lanes survive a seat
    // being reclaimed; the durable identity is the name, ADR 058). Contention is scoped by
    // (team_id, project) — never across projects.
    version: 11,
    up: (db) => {
      db.exec(
        `CREATE TABLE lanes (
           id            TEXT PRIMARY KEY,
           team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           project       TEXT NOT NULL,
           title         TEXT NOT NULL,
           detail        TEXT,
           owner_seat    TEXT,
           role          TEXT,
           surface_globs TEXT NOT NULL DEFAULT '[]',
           depends_on    TEXT NOT NULL DEFAULT '[]',
           branch        TEXT,
           state         TEXT NOT NULL,
           created_by    TEXT NOT NULL,
           created_at    INTEGER NOT NULL,
           claimed_at    INTEGER,
           resolved_at   INTEGER,
           updated_at    INTEGER NOT NULL
         )`,
      );
      db.exec('CREATE INDEX idx_lanes_team_project ON lanes(team_id, project)');
      db.exec('CREATE INDEX idx_lanes_state ON lanes(team_id, state)');
    },
  },
  {
    // v12 — lanes join the Plan (ADR 084): an optional goal_id links a lane up to a declared Goal, so
    // Goal status derives lanes-first over that grouping (ADR 048 as amended). Additive + nullable — no
    // backfill; pre-084 lanes and lane-less teams simply read null. The join is deliberately flat
    // (Goal → lane), never a recursive parent tree (amprealize's parent_id rot).
    version: 12,
    up: (db) => {
      db.exec('ALTER TABLE lanes ADD COLUMN goal_id TEXT');
      db.exec('CREATE INDEX idx_lanes_goal ON lanes(team_id, goal_id)');
    },
  },
  {
    // v13 — seat memory (ADR 093): a daemon-private continuity blob, one row per member,
    // last-write-wins. Deliberately NOT in the git seat-file — this is live working state
    // (presence's side of the ADR 058 durable/live line), never repo history. FK ON DELETE CASCADE
    // so a removed seat's note is reaped with it.
    version: 13,
    up: (db) => {
      db.exec(`CREATE TABLE seat_memory (
        member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        headline  TEXT NOT NULL,
        body      TEXT NOT NULL,
        saved_at  INTEGER NOT NULL
      )`);
    },
  },
  {
    // v14 — the steering acts (ADR 103: steer/challenge/defer, increment 2 of the interrupt line).
    // The `act` CHECK last froze at v5 ('…','resolve'), so persisting a new act fails at the DB even
    // when envelope validation (ActSchema) passed. Rather than re-freeze a wider CHECK and pay this
    // rebuild again on the next act, we drop the CHECK entirely — `act` becomes open TEXT, exactly the
    // lesson v10 recorded ("no CHECK so widening the vocabulary later needs no table rebuild — the v5
    // CHECK-rebuild trap"). `ActSchema` at the send boundary is the real gate; the DB CHECK was
    // redundant defense that has now cost two rebuilds. Same rebuild-and-copy dance as v5 (SQLite can't
    // drop a CHECK in place); indexes recreated identically. Safe with foreign_keys ON — no table
    // references `messages`, and copied rows still reference live teams/members.
    version: 14,
    up: (db) => {
      db.exec(`
        CREATE TABLE messages_new (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          from_member TEXT NOT NULL REFERENCES members(id),
          to_kind     TEXT NOT NULL CHECK (to_kind IN ('member','team','broadcast')),
          to_member   TEXT REFERENCES members(id),
          act         TEXT NOT NULL,
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
    // v15 — model attestation (ADR 101): the harness-attested model id rides the occupancy record
    // (the presence row), never the durable seat — a different harness can occupy the same chair
    // tomorrow with a different model (ADR 087). Additive + nullable, like the v3/v4 provenance/
    // workspace/driver columns: pre-101 rows and non-attesting adapters read null and render as
    // `unknown` (warn-never-block). Switch history lives in the audit log (occupancy.model_attested),
    // not here. `requests.model` carries a grant-less claimant's attestation across the admin-approval
    // gap so the approved occupancy is attested (else every approved session would start `unknown`).
    version: 15,
    up: (db) => {
      db.exec('ALTER TABLE presence ADD COLUMN model TEXT');
      db.exec('ALTER TABLE requests ADD COLUMN model TEXT');
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
