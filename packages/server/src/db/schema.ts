/**
 * v1 DDL — authoritative copy is docs/architecture/01-data-model.md.
 * Stored as a TS constant rather than a .sql asset to avoid build asset-copying (ADR 003).
 * Must stay character-equivalent to the doc; a divergence is a bug.
 */
export const SCHEMA_V1_SQL = `
CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  display     TEXT,
  default_lifecycle TEXT NOT NULL DEFAULT 'forever',
  archived_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE members (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('agent','human')),
  role        TEXT NOT NULL DEFAULT '',
  lifecycle   TEXT NOT NULL DEFAULT 'forever' CHECK (lifecycle IN ('forever','session','until')),
  lifecycle_until INTEGER,
  availability TEXT,
  token_hash  TEXT,
  left_at     INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_members_team_name ON members(team_id, name);
CREATE INDEX idx_members_team ON members(team_id);

CREATE TABLE presence (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  surface       TEXT NOT NULL CHECK (surface IN ('cli','claude-code','codex','cursor','web','ios','slack','other')),
  status        TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','away','offline')),
  conn_id       TEXT,
  last_seen_at  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_presence_member ON presence(member_id);
CREATE INDEX idx_presence_last_seen ON presence(last_seen_at);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  from_member TEXT NOT NULL REFERENCES members(id),
  to_kind     TEXT NOT NULL CHECK (to_kind IN ('member','team','broadcast')),
  to_member   TEXT REFERENCES members(id),
  act         TEXT NOT NULL CHECK (act IN
                ('message','status_update','request_help','handoff','accept','decline','wait')),
  body        TEXT NOT NULL DEFAULT '',
  thread_id   TEXT,
  meta        TEXT,
  ts          INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_messages_team_ts ON messages(team_id, ts);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_to_member ON messages(to_member);

CREATE TABLE inbox_cursors (
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last_read_message_id TEXT,
  last_read_ts INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (member_id)
);

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
