# 01 — Data Model (SQLite)

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

Store: **SQLite via `better-sqlite3`** (synchronous, embedded). One database file, default `~/.musterd/musterd.db` (override `MUSTERD_DB`). Tests use `:memory:`.

Conventions:
- All ids are **ULIDs** (lexicographically sortable, generated with the `ulid` package) stored as `TEXT`. Exception: human-facing names are slugs (see below).
- Timestamps are **integer epoch milliseconds** (`INTEGER`), UTC. Column name `*_at` or `ts`.
- Booleans are `INTEGER` 0/1.
- `PRAGMA journal_mode = WAL;` and `PRAGMA foreign_keys = ON;` set at open.
- Every table has `created_at`. Mutable rows also have `updated_at`.

## DDL (authoritative)

```sql
-- ============ teams ============
CREATE TABLE teams (
  id          TEXT PRIMARY KEY,              -- ULID
  slug        TEXT NOT NULL UNIQUE,          -- human name, e.g. "dawn"; [a-z0-9-], 1..32
  display     TEXT,                          -- optional pretty name
  default_lifecycle TEXT NOT NULL DEFAULT 'forever',  -- forever|session|until (default for new members)
  archived_at INTEGER,                       -- null = active
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ============ members ============
-- A durable identity. NOT a session. Unique by (team, name).
CREATE TABLE members (
  id          TEXT PRIMARY KEY,              -- ULID
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                 -- e.g. "Ada", "nick"; unique within team (see index)
  kind        TEXT NOT NULL CHECK (kind IN ('agent','human')),
  role        TEXT NOT NULL DEFAULT '',      -- free text, e.g. "backend"
  lifecycle   TEXT NOT NULL DEFAULT 'forever' CHECK (lifecycle IN ('forever','session','until')),
  lifecycle_until INTEGER,                   -- epoch ms; required iff lifecycle='until'
  availability TEXT,                         -- JSON schedule; STORED, NOT ENFORCED in v1 (roadmap)
  token_hash  TEXT,                          -- sha256 of the member's join token (null until issued)
  left_at     INTEGER,                       -- null = still a member
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_members_team_name ON members(team_id, name);
CREATE INDEX idx_members_team ON members(team_id);

-- ============ presence ============
-- Where a member is CURRENTLY attached. One member -> many presences (multiple surfaces).
-- A row exists while a surface is connected; heartbeats keep it fresh; it is deleted/expired on disconnect.
CREATE TABLE presence (
  id            TEXT PRIMARY KEY,            -- ULID (one per attachment/connection)
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  surface       TEXT NOT NULL CHECK (surface IN ('cli','claude-code','codex','cursor','web','ios','slack','other')),
  status        TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','away','offline')),
  conn_id       TEXT,                        -- transport connection id (WS), null for stateless HTTP pings
  last_seen_at  INTEGER NOT NULL,            -- updated on every heartbeat
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_presence_member ON presence(member_id);
CREATE INDEX idx_presence_last_seen ON presence(last_seen_at);

-- ============ messages ============
-- The durable log of all envelopes. Append-only.
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,              -- ULID == envelope.id
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  from_member TEXT NOT NULL REFERENCES members(id),
  to_kind     TEXT NOT NULL CHECK (to_kind IN ('member','team','broadcast')),
  to_member   TEXT REFERENCES members(id),  -- set iff to_kind='member'
  act         TEXT NOT NULL CHECK (act IN
                ('message','status_update','request_help','handoff','accept','decline','wait')),
  body        TEXT NOT NULL DEFAULT '',      -- the human/agent-readable content
  thread_id   TEXT,                          -- ULID of the root message of a thread; null = new thread root
  meta        TEXT,                          -- optional JSON (act-specific fields; see 02-protocol)
  ts          INTEGER NOT NULL,              -- envelope timestamp (epoch ms)
  created_at  INTEGER NOT NULL              -- server receive time (== ts unless clock skew)
);
CREATE INDEX idx_messages_team_ts ON messages(team_id, ts);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_to_member ON messages(to_member);

-- ============ inbox_cursors ============
-- Per (member, scope) high-water mark for at-least-once, cursor-based delivery.
-- A member's unread = messages addressed to them (or their team/broadcast) with ts > cursor_ts.
CREATE TABLE inbox_cursors (
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last_read_message_id TEXT,                 -- ULID of last acknowledged message
  last_read_ts INTEGER NOT NULL DEFAULT 0,   -- ts of that message
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (member_id)
);

-- ============ meta ============
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- seed: ('schema_version','1')
```

## Field notes (load-bearing decisions)

- **Member uniqueness is `(team_id, name)`**, not global. "Ada" can exist in two teams as two Members. This is intentional: a Member belongs to exactly one Team. Cross-team identity linking is a roadmap concern, not v1.
- **`memberships` is folded into `members`.** The plan mentioned a separate `memberships` table; in v1 a Member belongs to exactly one Team, so membership *is* the member row (`team_id` FK + `left_at`). If/when a Member must span Teams, split this out via ADR. (This is a deliberate, recorded simplification — if you implement, log it as ADR 001.)
- **Presence is ephemeral but row-backed.** Rows are created on attach, refreshed by heartbeat (`last_seen_at`), and removed/expired by the presence reaper (`03-server.md`). Querying "is X online" = "does X have a presence row with `last_seen_at` within the timeout".
- **`availability` and `lifecycle_until`** exist now but v1 does **not** enforce schedules or auto-expire `until` members at runtime (a reaper *may* mark expired members `left_at`, but enforcement of availability windows is roadmap). Store, don't enforce. Keep the columns.
- **`token_hash`** stores `sha256(token)`; the plaintext join token is shown once at `team add` time and never stored. The CLI/MCP present the token to authenticate as that Member.
- **Messages are append-only.** No edits/deletes in v1. `accept`/`decline` reference the original via `thread_id`/`meta.in_reply_to`, they don't mutate it.

## Migrations

- Single forward-only migration runner. `schema_meta.schema_version` gates it. v1 ships version `1` = the DDL above. A migration is a `(version, up(db))` pair in `packages/server/src/db/migrations.ts`; the runner applies any with version > current inside a transaction, then bumps `schema_version`.
- No down-migrations in v1.
- **v2 (`musterd/0.2`, ADR 010):** `ALTER TABLE presence ADD COLUMN held_until INTEGER`. Non-null once a connection has cleanly dropped — the row becomes a *reclaim hold* (`conn_id` cleared, `held_until = now + 45s`) instead of being deleted, so the member can reconnect within the grace window. Single-active is decided by *active* presence (`conn_id` set, `held_until` NULL); held rows are excluded from the live roster and swept by the reaper when `held_until` passes. The v1 DDL block above is unchanged; this is an additive ALTER.
- **v3 (`musterd/0.2`, ADR 014):** `ALTER TABLE presence ADD COLUMN provenance TEXT` + `ADD COLUMN workspace TEXT`. The provenance/where-on-attach seed: `provenance` (`session | asked | hook | scheduled | daemon`) records *why* this attachment exists; `workspace` records the gracefully-degrading "where" label (folder, qualified by branch/subpath). Both are nullable, captured once at attach from the client's `hello`, surfaced on the roster, and never guessed by the server. Additive ALTERs; pre-v3 rows read `null`.

## Seed data for tests (`06-testing.md` references this)

```
team:    dawn
members: nick  (human, role "lead",     lifecycle forever)
         Ada   (agent, role "backend",  lifecycle session)
         Lin   (agent, role "frontend", lifecycle session)
```

A test helper `seedDawn(db)` inserts exactly this and returns the created ids. Use it in integration + scenario tests so fixtures stay identical to the Figma terminal frames' sample data.
