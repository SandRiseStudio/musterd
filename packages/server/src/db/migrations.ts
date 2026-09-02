import { hostname } from 'node:os';
import { sparsifyPolicy } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { monotonicFactory as monotonicUlid } from 'ulid';
import { SCHEMA_V1_SQL } from './schema.js';

export interface Migration {
  version: number;
  up: (db: Database) => void;
  /**
   * Run with `PRAGMA foreign_keys = OFF` (toggled OUTSIDE the transaction — SQLite refuses the
   * pragma inside one). Needed only by table REBUILDS of an FK-referenced parent (`members`):
   * with enforcement on, the DROP half of copy-drop-rename fails against every child row. The
   * runner re-enables enforcement and runs `PRAGMA foreign_key_check` afterwards, so a rebuild
   * that orphaned rows fails the boot instead of shipping silent corruption.
   */
  fkOff?: boolean;
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
  {
    // v16 — harness residency (ADR 131, increment 2): the wake ledger. `residency` is the per-seat
    // enrollment (opt-in, admin-authorized, one host per seat via the UNIQUE member index —
    // last-enrolled-wins is an upsert, audited). `wake_leases` is the stored mutual-exclusion record
    // for wake *actuation* — the argued exception to ADR 090's derive-everything maxim: audit rows
    // are best-effort by contract and cannot bear correctness, so leases follow the `requests` table
    // precedent (short TTL, reaper-expired). Everything rate-shaped (cooldown, hourly cap, per-act
    // attempt cap) stays DERIVED from `residency.*` audit rows, never stored. `policy` is a reserved
    // nullable JSON column for per-seat enrollment overrides (increment 5's knobs — no v17 needed).
    version: 16,
    up: (db) => {
      db.exec(`
        CREATE TABLE residency (
          id            TEXT PRIMARY KEY,
          team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          harness       TEXT NOT NULL,
          host          TEXT NOT NULL,
          grant_id      TEXT,
          authorized_by TEXT,
          policy        TEXT,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_residency_member ON residency(member_id);
        CREATE INDEX idx_residency_team ON residency(team_id);

        CREATE TABLE wake_leases (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          act_id      TEXT NOT NULL,
          host        TEXT NOT NULL,
          lane        TEXT NOT NULL CHECK (lane IN ('immediate','batched')),
          status      TEXT NOT NULL DEFAULT 'leased' CHECK (status IN ('leased','reported','expired')),
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL
        );
        CREATE INDEX idx_wake_leases_member ON wake_leases(member_id, status);
        CREATE INDEX idx_wake_leases_team ON wake_leases(team_id, status);
      `);
    },
  },
  {
    // ADR 135 build provenance: the connecting client's dist build ref (git SHA, optionally
    // `-dirty`), attested on claim / ambient touch exactly like `model` (v15). Additive + nullable —
    // pre-migration rows and unstamped clients read NULL and every surface renders silence.
    version: 17,
    up: (db) => {
      db.exec('ALTER TABLE presence ADD COLUMN build TEXT');
    },
  },
  {
    // v18 — observer grades (ADR 136). `members.observer` said *that* a seat was a read-only watcher;
    // it could not say *how much it may see*, so every observer was full-visibility and a shared
    // watch-link carried the team's DMs. `observer_scope` is that second bit: 'full' (the local
    // dashboard — the trusted operator's own window) or 'public' (a shared link — team/broadcast only).
    //
    // Additive + nullable. NULL means 'full', and existing observer rows are backfilled to it
    // explicitly rather than left to the default: an observer minted before this migration was, by
    // definition, minted by a trusted local operator (ADR 134 now enforces that), so silently
    // downgrading it would break the live dashboard for no security gain.
    version: 18,
    up: (db) => {
      db.exec('ALTER TABLE members ADD COLUMN observer_scope TEXT');
      db.exec("UPDATE members SET observer_scope = 'full' WHERE observer = 1");
    },
  },
  {
    // v19 — session capture (ADR 131 §5, increment 4): the resumable attestation. Harness CLASS +
    // timestamp only — the daemon never learns a session id or a transcript path (those stay in the
    // workspace's binding.session). Additive + nullable per the v15 precedent: pre-capture rows read
    // null and `residency status` renders nothing. Lives on the enrollment row (not presence) because
    // capture is presence-neutral by contract (ADR 057) — it must never touch an occupancy record.
    version: 19,
    up: (db) => {
      db.exec('ALTER TABLE residency ADD COLUMN resumable_harness TEXT');
      db.exec('ALTER TABLE residency ADD COLUMN resumable_at INTEGER');
    },
  },
  {
    // v20 — sticky offline reason (ADR 141): how the seat last went dark (`disconnected` |
    // `signed_off`). Projected as MemberSummary.offline_reason with reclaimable/off_hours overlays.
    // Additive + nullable; never-connected seats read null → `unknown` on the roster.
    version: 20,
    up: (db) => {
      db.exec('ALTER TABLE members ADD COLUMN last_offline_reason TEXT');
    },
  },
  {
    // v21 — send-time provenance (ADR 131 §4, increment 5): the sender's presence provenance
    // stamped onto each message at insert, SERVER-derived by construction (no wire field — a
    // caller cannot supply it), so the wake ledger can demote interrupt-class acts sent from a
    // provenance-`wake` occupancy to the batched lane (the ping-pong bound). Additive + nullable:
    // pre-v21 rows and senders with no live presence read NULL, which demotes nothing.
    version: 21,
    up: (db) => {
      db.exec('ALTER TABLE messages ADD COLUMN from_provenance TEXT');
    },
  },
  {
    // v22 — tool-call telemetry (ADR 144 increment 1): hour-bucketed per-(seat, tool, outcome)
    // counters behind the surface-redesign evals. Tool calls are an order of magnitude chattier
    // than coordination acts, so this is an UPSERT aggregate (the ambient-presence "a thousand
    // commands leave one row" rule) — never one row per call, and deliberately NOT audit rows
    // (the ledger stays coordination-grained; the once-per-session rendered-surface weight lands
    // there instead, as `mcp.surface_rendered`). `role` is stamped server-side at ingest (the v21
    // from_provenance rule) and stays out of the key: it annotates the seat's calls, last write
    // wins. `outcome` is open TEXT (the v5 CHECK-rebuild trap).
    version: 22,
    up: (db) => {
      db.exec(`
        CREATE TABLE tool_call_stats (
          team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          seat              TEXT NOT NULL,
          role              TEXT,
          tool              TEXT NOT NULL,
          outcome           TEXT NOT NULL,
          bucket_start      INTEGER NOT NULL,
          calls             INTEGER NOT NULL DEFAULT 0,
          total_duration_ms INTEGER NOT NULL DEFAULT 0,
          max_duration_ms   INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (team_id, seat, tool, outcome, bucket_start)
        );
        CREATE INDEX idx_tool_call_stats_team_bucket ON tool_call_stats(team_id, bucket_start);
      `);
    },
  },
  {
    // v23 — feature epoch (ADR 148). Sibling to the v17 `build` column: the client-attested monotonic
    // capability counter (`FEATURE_EPOCH`) the connecting dist was built against. The roster renders
    // skew from this — a seat behind the daemon's epoch lacks later features — instead of the raw build
    // SHA, which fired a "stale" alarm on every benign drift. Nullable; older clients read null.
    version: 23,
    up: (db) => {
      db.exec('ALTER TABLE presence ADD COLUMN epoch INTEGER');
    },
  },
  {
    // v24 — two-stage close (ADR 169). `risk` is the declared risk-tag list (JSON array; any tag
    // routes the review ask human-first — declared, never inferred). `merged_json` persists the
    // worker's ADR 109 merge attestation at `ready_for_review` so a counterpart's later confirm
    // carries the *worker's* claim verbatim into `git.pr_merged`. The new lane state itself needs
    // no DDL: `state` is open TEXT by design (the v5 CHECK-rebuild trap). Verified-ness is derived
    // from the `lane.closed` audit row, never stored — so there is deliberately no column for it.
    version: 24,
    up: (db) => {
      db.exec('ALTER TABLE lanes ADD COLUMN risk TEXT');
      db.exec('ALTER TABLE lanes ADD COLUMN merged_json TEXT');
    },
  },
  {
    // v25 — index audit by `action`. Every audit read but the paged listing narrows by team_id and
    // then filters on `action`, but v9's only index is (team_id, ts), so each one SCANNED the whole
    // team's rows. Measured on a 118,976-row copy of the real dogfood DB (~2 years at the observed
    // 134 rows/day): the derived reads cost 62–85 ms each and drop to 0.04–1.2 ms with this index,
    // which EXPLAIN QUERY PLAN confirms SQLite actually picks. Today, at 3.6k rows, they are 0.4 ms
    // — this is bought before the table is large, not because anything is slow now.
    //
    // `audit` is append-only and hot, so the write cost was measured too, not assumed: a third index
    // costs +10 µs/insert (~35% of a 28 µs insert), which at 134 rows/day is 1.35 ms/day across the
    // whole team. Index storage is ~7 MB at 118k rows.
    //
    // Deliberately NOT paired with a query rewrite: the json_extract predicates cost the same as
    // plain-column ones (28.6 vs 32.0 ms at scale) — the scan was the cost, never the extraction.
    version: 25,
    up: (db) => {
      db.exec('CREATE INDEX idx_audit_team_action_ts ON audit(team_id, action, ts)');
    },
  },
  {
    // v26 — sparse team policy (ADR 185). `setPolicy` used to parse-then-store, so the first write of
    // any single knob froze EVERY default into `teams.policy` and the schema default was dead for that
    // team forever. Defaults now apply on read; this rewrites the rows already frozen.
    //
    // The rule is keep-if-differs, strip-if-equal. A value that differs from the current default is
    // unambiguously deliberate. A value that equals it is ambiguous — the old audit row recorded the
    // post-parse result, so intent was never written down anywhere — but stripping it is inert unless
    // the default later moves, and at that moment tracking the new default is the likelier intent for
    // a value nobody can show was chosen. No DDL: this is a data rewrite of one TEXT column.
    version: 26,
    up: (db) => {
      const rows = db
        .prepare<
          [],
          { id: string; policy: string }
        >('SELECT id, policy FROM teams WHERE policy IS NOT NULL')
        .all();
      const update = db.prepare('UPDATE teams SET policy = ? WHERE id = ?');
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.policy);
        } catch {
          continue; // unparseable blob: leave it alone rather than destroy it
        }
        update.run(JSON.stringify(sparsifyPolicy(parsed)), row.id);
      }
    },
  },
  {
    // v27 — outcome acceptance rename (ADR 192). Rewrite live rows from the ADR 169 spelling
    // `ready_for_review` to canonical `awaiting_acceptance`. No DDL: `state` is open TEXT.
    // Audit action strings stay frozen (`lane.ready_for_review`, …) — do not rewrite history.
    version: 27,
    up: (db) => {
      db.exec(`UPDATE lanes SET state = 'awaiting_acceptance' WHERE state = 'ready_for_review'`);
    },
  },
  {
    // v28 — dispatch continuation (ADR 199): board-derived work-orders have no triggering act.
    // Rebuild wake_leases so act_id is nullable; add lane_id for exhaustion / report detail.
    version: 28,
    up: (db) => {
      db.exec(`
        CREATE TABLE wake_leases_v28 (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          act_id      TEXT,
          lane_id     TEXT,
          host        TEXT NOT NULL,
          lane        TEXT NOT NULL CHECK (lane IN ('immediate','batched')),
          status      TEXT NOT NULL DEFAULT 'leased' CHECK (status IN ('leased','reported','expired')),
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL
        );
        INSERT INTO wake_leases_v28 (id, team_id, member_id, act_id, lane_id, host, lane, status, created_at, expires_at)
          SELECT id, team_id, member_id, act_id, NULL, host, lane, status, created_at, expires_at FROM wake_leases;
        DROP TABLE wake_leases;
        ALTER TABLE wake_leases_v28 RENAME TO wake_leases;
        CREATE INDEX idx_wake_leases_member ON wake_leases(member_id, status);
        CREATE INDEX idx_wake_leases_team ON wake_leases(team_id, status);
      `);
    },
  },
  {
    // v29 — recurring Team/Member working hours (ADR 206). Nullable JSON keeps the schedule
    // informational and preserves the v1 DDL; the shared WorkingHoursSchema validates writes.
    version: 29,
    up: (db) => {
      db.exec('ALTER TABLE teams ADD COLUMN working_hours TEXT');
      db.exec('ALTER TABLE members ADD COLUMN working_hours TEXT');
    },
  },
  {
    // v30 — initial revive Team schedule (ADR 206). Only fill an unset value: an operator's
    // explicit schedule must survive an upgrade, while the shipped revive Team gets its first
    // durable schedule without requiring a settings surface.
    version: 30,
    up: (db) => {
      db.prepare(
        `UPDATE teams SET working_hours = ?
         WHERE slug = 'revive' AND working_hours IS NULL`,
      ).run(
        JSON.stringify({
          timezone: 'America/Los_Angeles',
          days: ['mon', 'tue', 'wed', 'thu', 'fri'],
          start: '11:00',
          end: '15:00',
        }),
      );
    },
  },
  {
    // v31 — discoverable roles (ADR 227 increment 1): `members.roles` is every role the seat holds
    // (JSON array, projected by reconcile; NULL ⇒ derive from the legacy single `role` display
    // label), and `roles.summary` is the role file's one-line discoverable face.
    version: 31,
    up: (db) => {
      // Guarded ALTERs: the version-rewind pattern the migration tests use (set schema_version back,
      // re-run the tail) replays this on a schema that already has the columns.
      const memberCols = db.prepare("SELECT name FROM pragma_table_info('members')").pluck().all();
      if (!memberCols.includes('roles')) db.exec('ALTER TABLE members ADD COLUMN roles TEXT');
      const roleCols = db.prepare("SELECT name FROM pragma_table_info('roles')").pluck().all();
      if (!roleCols.includes('summary')) db.exec('ALTER TABLE roles ADD COLUMN summary TEXT');
    },
  },
  {
    // v32 — ledger seats (ADR 232 increment 1): widen the members.kind CHECK to admit 'service'.
    // The CHECK is frozen in the v1 DDL and SQLite cannot ALTER it in place, so rebuild the table
    // (the migration-5 pattern) — but members is the FK parent of half the schema, hence `fkOff`.
    // Column list read from the live table, not hardcoded: nine migrations have widened members
    // since v1, and a rebuild that enumerates them by hand breaks the version-rewind replay the
    // migration tests use.
    version: 32,
    fkOff: true,
    up: (db) => {
      const cols = db
        .prepare("SELECT name FROM pragma_table_info('members')")
        .pluck()
        .all() as string[];
      const colList = cols.map((c) => `"${c}"`).join(', ');
      db.exec(`
        CREATE TABLE members_new (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          kind        TEXT NOT NULL CHECK (kind IN ('agent','human','service')),
          role        TEXT NOT NULL DEFAULT '',
          lifecycle   TEXT NOT NULL DEFAULT 'forever' CHECK (lifecycle IN ('forever','session','until')),
          lifecycle_until INTEGER,
          availability TEXT,
          token_hash  TEXT,
          left_at     INTEGER,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          bound_at    INTEGER,
          observer    INTEGER NOT NULL DEFAULT 0,
          account_status TEXT,
          capabilities TEXT,
          credential_hash TEXT,
          observer_scope TEXT,
          last_offline_reason TEXT,
          working_hours TEXT,
          roles TEXT,
          slack_user_id TEXT
        );
        INSERT INTO members_new (${colList}) SELECT ${colList} FROM members;
        DROP TABLE members;
        ALTER TABLE members_new RENAME TO members;
        CREATE UNIQUE INDEX idx_members_team_name ON members(team_id, name);
        CREATE INDEX idx_members_team ON members(team_id);
      `);
    },
  },
  {
    // v33 — declared acceptance stakes (ADR 234). Deliberately a NEW column rather than a reuse of
    // `risk`: risk already routes the ask human-first on any tag, and hanging a second consumer with
    // opposite needs off one value is the shared-predicate trap ADR 225 names. Nullable, and read as
    // `normal` when absent, so every pre-234 lane keeps exactly its current meaning and no backfill
    // is needed — the absence of a declaration is itself the default, not missing data.
    //
    // Nothing routes on this in increment 1. The column exists so the ledger can answer "do declared
    // stakes predict the answer rate" BEFORE the routing flip is built on the assumption they do.
    version: 33,
    up: (db) => {
      // Guarded, per v31's note: the migration tests rewind schema_version and replay the tail.
      const laneCols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!laneCols.includes('stakes')) db.exec('ALTER TABLE lanes ADD COLUMN stakes TEXT');
    },
  },
  {
    // v34 — the wake correlation token (ADR 241). Sibling to the v17 `build` and v23 `epoch`
    // columns in shape, but not in kind: those describe the session, and this IDENTIFIES what
    // caused it. Every other column on a presence row is a description, and two sessions on one
    // seat are indistinguishable under any description — which is how wake verification came to
    // credit a prior wake's still-fresh row to a later lease and report an undelivered act as
    // delivered. Nullable, never backfilled: an occupancy no wake caused genuinely has no lease,
    // and the verifier treats absence as "not mine" rather than as missing data (ADR 236).
    version: 34,
    up: (db) => {
      // Guarded, per v31's note: the migration tests rewind schema_version and replay the tail.
      const cols = db.prepare("SELECT name FROM pragma_table_info('presence')").pluck().all();
      if (!cols.includes('wake_lease')) db.exec('ALTER TABLE presence ADD COLUMN wake_lease TEXT');
    },
  },
  {
    // v35 — seat footprint samples (seat-footprint design, 2026-08-05). Two tables, one tick:
    // machine row (swap/free) keyed by ts, and zero-or-more sidecar-stack rows sharing that ts.
    // Machine-level rows deliberately carry no team_id: the sampler measures the HOST, and one
    // team = one daemon (ADR 040) makes the daemon's db the machine's ledger. Retention is the
    // sampler's job (pruneFootprint), so this table can never become its own resource problem.
    // IF NOT EXISTS throughout, per v33's note: the migration tests rewind schema_version and
    // replay the tail.
    version: 35,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS footprint_stacks (
          ts INTEGER NOT NULL,
          classification TEXT NOT NULL,
          seat TEXT,
          procs INTEGER NOT NULL,
          rss_kb INTEGER NOT NULL,
          pids TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_footprint_stacks_ts ON footprint_stacks(ts);
        CREATE TABLE IF NOT EXISTS footprint_machine (
          ts INTEGER PRIMARY KEY,
          swap_used_mb INTEGER,
          swap_total_mb INTEGER,
          free_mem_mb INTEGER
        );
      `);
    },
  },
  {
    // ADR 244: WHO set the stakes. Null reads back as 'declared' — every lane written before a
    // policy could set stakes had them from a seat (or from silence, which ADR 234 §2 rules is
    // itself the worker's declaration), so the backfill is correct rather than merely convenient.
    //
    // v36 after a rebase, not by original choice: this was written as v35 while v34 and v35 were
    // both unmerged on other branches (ryder's wake_lease, kimi's footprint tables). Coordinating
    // in-band beat discovering it in a merge conflict — which is all that caught the v32 collision
    // izzo and I both wrote last week, and that one could have produced a database whose applied
    // schema depended on merge order. The sequence stays dense; a `migrations:check` gate on
    // duplicate versions is still owed.
    version: 36,
    up: (db) => {
      const laneCols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!laneCols.includes('stakes_provenance'))
        db.exec('ALTER TABLE lanes ADD COLUMN stakes_provenance TEXT');
    },
  },
  {
    // ADR 248: the seeds ingest cursor — the daemon's own record of the last relay seed it turned
    // into a lane. A dedicated table on purpose: the `seed.ingested` audit row exists for
    // observability, and reading it back as ingest state would put one row under two consumers with
    // different needs (ADR 247). Advanced per seed, inside the same transaction as the lane insert,
    // so a crash mid-batch resumes without duplicating lanes.
    version: 37,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS seeds_ingest_cursor (
          team_id TEXT PRIMARY KEY,
          last_seed_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // ADR 251 §7: the native backend's two substrate rails, one row per loop turn. Per-turn usage
    // into the wake ledger (cost exists even when a run dies unreported — the #745 report-survivor
    // bias, closed for this backend) and daemon-owned transcript capture (the substrate phase-2
    // resume will replay). UNIQUE(lease_id, turn) makes a re-posted turn an overwrite, never a
    // duplicate. member_id denormalized from the lease at insert so the capture stays keyed to the
    // occupancy even if lease rows are ever pruned.
    version: 38,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS wake_turns (
          id              TEXT PRIMARY KEY,
          team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          lease_id        TEXT NOT NULL,
          member_id       TEXT NOT NULL,
          turn            INTEGER NOT NULL,
          usage_json      TEXT NOT NULL,
          cost_usd        REAL,
          stop_reason     TEXT,
          transcript_json TEXT,
          created_at      INTEGER NOT NULL,
          UNIQUE(lease_id, turn)
        );
        CREATE INDEX IF NOT EXISTS idx_wake_turns_lease ON wake_turns(team_id, lease_id, turn);
      `);
    },
  },
  {
    // ADR 251 §2: the `musterd` surface makes a native-hosted occupancy roster-distinct — but the
    // v1 CHECK was written before that surface existed and never grew it, so a native claim's
    // presence INSERT threw inside the WS handler and the client hung with no response (measured
    // live 2026-08-12, the second native wake: 60s to a client-side timeout, no error frame, and a
    // misleading "waiting for admin approval" fallback message). The protocol enum had reserved
    // `musterd` since increment 3; only the storage layer disagreed, and the disagreement was
    // invisible because the binding re-read overwrote the surface before it was ever sent.
    //
    // SQLite cannot ALTER a CHECK, so this is the copy-drop-rename rebuild (the v5 precedent). The
    // column list is enumerated rather than `SELECT *` because the table has grown eight columns
    // across later migrations and positional copy would silently transpose them. `fkOff` is NOT
    // needed: no table references `presence`.
    version: 39,
    up: (db) => {
      db.exec(`
        CREATE TABLE presence_new (
          id            TEXT PRIMARY KEY,
          member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          surface       TEXT NOT NULL CHECK (surface IN
                          ('cli','claude-code','codex','cursor','web','ios','slack','other','musterd')),
          status        TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','away','offline')),
          conn_id       TEXT,
          last_seen_at  INTEGER NOT NULL,
          created_at    INTEGER NOT NULL,
          held_until    INTEGER,
          provenance    TEXT,
          workspace     TEXT,
          driver        TEXT,
          model         TEXT,
          build         TEXT,
          epoch         INTEGER,
          wake_lease    TEXT
        );
        INSERT INTO presence_new (id, member_id, surface, status, conn_id, last_seen_at, created_at,
                                  held_until, provenance, workspace, driver, model, build, epoch, wake_lease)
          SELECT id, member_id, surface, status, conn_id, last_seen_at, created_at,
                 held_until, provenance, workspace, driver, model, build, epoch, wake_lease
          FROM presence;
        DROP TABLE presence;
        ALTER TABLE presence_new RENAME TO presence;
        CREATE INDEX idx_presence_member ON presence(member_id);
        CREATE INDEX idx_presence_last_seen ON presence(last_seen_at);
      `);
    },
  },
  {
    // ADR 262: per-edge firing ledger. `edge` is the work-order board edge (review /
    // dispatch_handoff / dispatch_continuation); NULL on inbox wakes. `spawned_at` is the host
    // exec ack (POST wake-progress). Do not backfill — inferring edge from act shape is the
    // ADR 250 measurement trap.
    version: 40,
    up: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('wake_leases')").pluck().all();
      if (!cols.includes('edge')) db.exec('ALTER TABLE wake_leases ADD COLUMN edge TEXT');
      if (!cols.includes('spawned_at'))
        db.exec('ALTER TABLE wake_leases ADD COLUMN spawned_at INTEGER');
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_wake_leases_edge ON wake_leases(team_id, lane_id, edge)',
      );
    },
  },
  {
    // Incident convergence increment 1 (spec 2026-08-14, lane 01M00PNG2Q): lanes grow a nullable
    // `kind` (null = ordinary lane; 'incident' = daemon-opened shared-blocker lane), and
    // incident_reports records every blocked_by report so clustering can count distinct seats per
    // (team, gate) and duplicate reporters can be answered. `lane_id` is stamped once the incident
    // lane opens; rows with lane_id NULL are the pre-threshold pool.
    version: 41,
    up: (db) => {
      const laneCols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!laneCols.includes('kind')) db.exec('ALTER TABLE lanes ADD COLUMN kind TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS incident_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id TEXT NOT NULL,
          gate TEXT NOT NULL,
          seat TEXT NOT NULL,
          sig TEXT,
          ref TEXT,
          message_id TEXT,
          lane_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_incident_reports_team_gate ON incident_reports(team_id, gate);
      `);
    },
  },
  {
    // ADR 101 increment: an occupancy records WHICH TIER produced its model — `observed` (a harness
    // probe saw it), `environment`, or `binding` (a declaration). NULL for every pre-existing row
    // and for any client that does not send it, which is the honest answer: those rows genuinely do
    // not know, and backfilling a guess would be the exact substitution this column exists to end.
    version: 42,
    up: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('presence')").pluck().all();
      if (!cols.includes('model_source'))
        db.exec('ALTER TABLE presence ADD COLUMN model_source TEXT');
      // `requests` carries the claimant's attestation across the approval gap, so the tier must
      // cross it too — otherwise an approval-gated claim lands a model whose tier is permanently
      // unknowable, which is the exact hole this column closes one path over.
      const reqCols = db.prepare("SELECT name FROM pragma_table_info('requests')").pluck().all();
      if (!reqCols.includes('model_source'))
        db.exec('ALTER TABLE requests ADD COLUMN model_source TEXT');
    },
  },
  {
    // ADR 291: the durable shared-Seed projection. Relay capture stays outside the database; this
    // table owns the Team-visible lifecycle and is keyed by immutable relay provenance.
    version: 43,
    up: (db) => {
      const memberCols = db.prepare("SELECT name FROM pragma_table_info('members')").pluck().all();
      if (!memberCols.includes('slack_user_id'))
        db.exec('ALTER TABLE members ADD COLUMN slack_user_id TEXT');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_members_team_slack_user
          ON members(team_id, slack_user_id) WHERE slack_user_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS seeds (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          relay_id TEXT NOT NULL,
          source TEXT NOT NULL,
          body TEXT NOT NULL,
          captured_at INTEGER NOT NULL,
          slack_user_id TEXT NOT NULL,
          submitted_by TEXT NOT NULL REFERENCES members(id),
          state TEXT NOT NULL,
          explorer_id TEXT REFERENCES members(id),
          final_brief TEXT,
          conclusion TEXT,
          linked_lane_id TEXT REFERENCES lanes(id),
          promotion_kind TEXT,
          research_skipped INTEGER,
          promoted_at INTEGER,
          completed_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(team_id, relay_id)
        );
        CREATE INDEX IF NOT EXISTS idx_seeds_team_state ON seeds(team_id, state, updated_at);
        CREATE TABLE IF NOT EXISTS seed_thread_entries (
          id TEXT PRIMARY KEY,
          seed_id TEXT NOT NULL REFERENCES seeds(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          body TEXT NOT NULL,
          member_id TEXT NOT NULL REFERENCES members(id),
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_seed_thread_entries_seed ON seed_thread_entries(seed_id, created_at);
      `);
    },
  },
  {
    // ADR 321 §2: `opencode` joins the Surface enum as a first-class harness. Same drift shape
    // migration 39 closed for `musterd`: the protocol enum widened (zod accepts the value) while
    // this table's CHECK still refused it, so an opencode claim would throw inside the WS handler —
    // loud since the ADR 251 fix, but still broken. SQLite cannot ALTER a CHECK, so: copy-drop-
    // rename rebuild, columns enumerated because positional copy transposes silently (v39's rule).
    // `model_source` (migration 42) postdates v39's column list and must ride along.
    version: 44,
    up: (db) => {
      db.exec(`
        CREATE TABLE presence_new (
          id            TEXT PRIMARY KEY,
          member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          surface       TEXT NOT NULL CHECK (surface IN
                          ('cli','claude-code','codex','opencode','cursor','web','ios','slack',
                           'other','musterd')),
          status        TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','away','offline')),
          conn_id       TEXT,
          last_seen_at  INTEGER NOT NULL,
          created_at    INTEGER NOT NULL,
          held_until    INTEGER,
          provenance    TEXT,
          workspace     TEXT,
          driver        TEXT,
          model         TEXT,
          build         TEXT,
          epoch         INTEGER,
          wake_lease    TEXT,
          model_source  TEXT
        );
        INSERT INTO presence_new (id, member_id, surface, status, conn_id, last_seen_at, created_at,
                                  held_until, provenance, workspace, driver, model, build, epoch,
                                  wake_lease, model_source)
          SELECT id, member_id, surface, status, conn_id, last_seen_at, created_at,
                 held_until, provenance, workspace, driver, model, build, epoch,
                 wake_lease, model_source
          FROM presence;
        DROP TABLE presence;
        ALTER TABLE presence_new RENAME TO presence;
        CREATE INDEX idx_presence_member ON presence(member_id);
        CREATE INDEX idx_presence_last_seen ON presence(last_seen_at);
      `);
    },
  },
  {
    // ADR 325 prereq: `incident_reports.id` was the schema's only INTEGER AUTOINCREMENT id — an
    // ordering that exists only in this database file, which collides the moment rows originate on
    // more than one machine. Rebuild on ULID TEXT ids (the convention every other table follows).
    // New ids are minted in old-integer-id order through a monotonic factory seeded per-row at
    // created_at: the pool's `ORDER BY id` promise (= arrival order) survives the rebuild even for
    // rows whose created_at disagrees with their arrival, and the new ids still carry an honest
    // timestamp prefix.
    version: 45,
    up: (db) => {
      db.exec(`
        CREATE TABLE incident_reports_new (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          gate TEXT NOT NULL,
          seat TEXT NOT NULL,
          sig TEXT,
          ref TEXT,
          message_id TEXT,
          lane_id TEXT,
          created_at INTEGER NOT NULL
        );
      `);
      const mint = monotonicUlid();
      const rows = db
        .prepare<
          [],
          {
            id: number;
            team_id: string;
            gate: string;
            seat: string;
            sig: string | null;
            ref: string | null;
            message_id: string | null;
            lane_id: string | null;
            created_at: number;
          }
        >('SELECT * FROM incident_reports ORDER BY id')
        .all();
      const ins = db.prepare(
        `INSERT INTO incident_reports_new (id, team_id, gate, seat, sig, ref, message_id, lane_id, created_at)
         VALUES (@id, @team_id, @gate, @seat, @sig, @ref, @message_id, @lane_id, @created_at)`,
      );
      for (const row of rows) ins.run({ ...row, id: mint(row.created_at) });
      db.exec(`
        DROP TABLE incident_reports;
        ALTER TABLE incident_reports_new RENAME TO incident_reports;
        CREATE INDEX idx_incident_reports_team_gate ON incident_reports(team_id, gate);
      `);
    },
  },
  {
    // ADR 327: the team-memory retrieval fold — a derived FTS5 index over `insight` acts in the
    // message log. Triggers keep it current on the append-only log's insert/delete; the INSERT..
    // SELECT below is the rebuild path's first run (store/insights.ts `rebuildInsightsFts` can
    // repeat it at any time). The table is a declared cache (ADR 259): dropping it loses nothing
    // the log does not hold.
    version: 46,
    up: (db) => {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS insights_fts USING fts5(
          message_id UNINDEXED,
          team_id UNINDEXED,
          headline,
          body,
          tags
        );
        CREATE TRIGGER IF NOT EXISTS insights_fts_ins AFTER INSERT ON messages WHEN NEW.act = 'insight' BEGIN
          INSERT INTO insights_fts (message_id, team_id, headline, body, tags)
          VALUES (NEW.id,
                  NEW.team_id,
                  COALESCE(json_extract(NEW.meta, '$.headline'), ''),
                  NEW.body,
                  COALESCE(json_extract(NEW.meta, '$.tags'), ''));
        END;
        CREATE TRIGGER IF NOT EXISTS insights_fts_del AFTER DELETE ON messages WHEN OLD.act = 'insight' BEGIN
          DELETE FROM insights_fts WHERE message_id = OLD.id;
        END;
      `);
      // Backfill = the rebuild path's first run; delete-first so a rewound-and-replayed
      // migration cannot double-index.
      db.exec('DELETE FROM insights_fts');
      db.exec(`
        INSERT INTO insights_fts (message_id, team_id, headline, body, tags)
        SELECT m.id,
               m.team_id,
               COALESCE(json_extract(m.meta, '$.headline'), ''),
               m.body,
               COALESCE(json_extract(m.meta, '$.tags'), '')
        FROM messages m
        WHERE m.act = 'insight';
      `);
    },
  },
  {
    // ADR 331: the ordering substrate. `nodes` arrives in ADR 328's shape with the three departures
    // that ADR names (`next_seq`, nullable `credential_hash`/`enrolled_at`), one self-minted row per
    // hosted team — per (daemon, team), not per daemon. `(origin_node, origin_seq)` land NOT NULL on
    // `messages`, backfilled per team as a gapless prefix in (ts, id) order. Guarded ALTERs and
    // insert-if-absent because the migration tests rewind-and-replay; the backfill recomputes, so a
    // replayed partition renumbers rather than doubling. `next_seq` holds the NEXT value to assign.
    version: 47,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          id              TEXT PRIMARY KEY,
          team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          label           TEXT NOT NULL,
          credential_hash TEXT,
          enrolled_at     INTEGER,
          enrolled_by     TEXT,
          revoked_at      INTEGER,
          last_seen_at    INTEGER,
          next_seq        INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_nodes_team ON nodes(team_id);
      `);
      const msgCols = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      // NOT NULL via ALTER needs a default; insertMessage always stamps, and the backfill below
      // overwrites the default on every pre-existing row, so '' / 0 never survive the migration.
      if (!msgCols.includes('origin_node'))
        db.exec("ALTER TABLE messages ADD COLUMN origin_node TEXT NOT NULL DEFAULT ''");
      if (!msgCols.includes('origin_seq'))
        db.exec('ALTER TABLE messages ADD COLUMN origin_seq INTEGER NOT NULL DEFAULT 0');

      const mint = monotonicUlid();
      const now = Date.now();
      const teams = db.prepare<[], { id: string }>('SELECT id FROM teams ORDER BY id').all();
      const nodeFor = db.prepare<[string], { id: string }>(
        'SELECT id FROM nodes WHERE team_id = ? ORDER BY id LIMIT 1',
      );
      const stamp = db.prepare('UPDATE messages SET origin_node = ?, origin_seq = ? WHERE id = ?');
      for (const team of teams) {
        let node = nodeFor.get(team.id);
        if (!node) {
          node = { id: mint(now) };
          db.prepare('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)').run(
            node.id,
            team.id,
            hostname(),
          );
        }
        const rows = db
          .prepare<
            [string],
            { id: string }
          >('SELECT id FROM messages WHERE team_id = ? ORDER BY ts, id')
          .all(team.id);
        rows.forEach((row, i) => stamp.run(node!.id, i + 1, row.id));
        db.prepare('UPDATE nodes SET next_seq = ? WHERE id = ?').run(rows.length + 1, node.id);
      }
    },
  },
  {
    // Which `nodes` row is THIS daemon's, per team — ADR 325 residence 3 (local-only, never
    // replicated), so a separate table rather than a column: "is this row me" is machine-relative,
    // and `nodes` is hub-authoritative state that will replicate, where a self-referring boolean is
    // false on every receiver.
    //
    // v47 picked the local row with `ORDER BY id LIMIT 1`, correct only while enrollment did not
    // exist. Increment 3a is what adds the second row, so this precedes it: a remote ULID sorting
    // lower would otherwise take over our stamp, holing our sequence and putting numbers in theirs
    // that name events they never wrote — the loss-versus-silence ambiguity ADR 331 exists to
    // prevent. Backfills from v47's rows, every one of which is local by construction because
    // nothing has ever enrolled. `INSERT OR IGNORE` for the rewind-and-replay harness, and
    // `ORDER BY id` so that if the one-row-per-team assumption is ever violated the row picked is
    // deterministic rather than whatever the scan happened to reach first (miley, 2026-08-27).
    version: 48,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_node (
          team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL REFERENCES nodes(id)
        );
        INSERT OR IGNORE INTO local_node (team_id, node_id)
          SELECT team_id, id FROM nodes ORDER BY id;
      `);
    },
  },
  {
    // Enrollment codes (ADR 328 §2): a one-time code, not a copied secret. Hashed like every other
    // token kind — the plaintext is shown once at mint and never persisted. Single-use is enforced
    // by the guarded CAS in store/nodes.ts (`WHERE consumed_at IS NULL`), not by this schema: the
    // uniqueness here is on the code, so a replayed mint collides rather than shadowing.
    //
    // No backfill — an invite is a live object with a 15-minute life, and history has none.
    version: 49,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS node_invites (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          code_hash   TEXT NOT NULL,
          label       TEXT,
          created_by  TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          consumed_at INTEGER,
          consumed_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_node_invites_team ON node_invites(team_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_node_invites_code ON node_invites(code_hash);
      `);
    },
  },
  {
    // ADR 325 increment 3b-i: the hub's staging log for pushed events, and the daemon's push cursor.
    //
    // Pushed events land HERE, never in `messages`. The fold into `messages` is 3b-ii, and it is one
    // implementation run by hub and puller alike, so exactly one piece of code ever writes a
    // foreign-origin row into the local log — the second insert path ADR 331 §Consequences warned
    // about, built once and reviewed as its own slice. Nothing in this migration relates to
    // `nodes.next_seq`; `src/sync/containment.test.ts` is what holds that true.
    version: 50,
    up: (db) => {
      db.exec(`
        -- id is NOT a primary key. It is the envelope's id, minted by the ORIGIN daemon, so it is
        -- attacker-chosen for any enrolled node; a global unique on it lets one node permanently
        -- wedge another's sync by staging that node's next id first (dolly, 2026-08-28, #1102). The
        -- refusal is correct in isolation and terminal in aggregate: the batch rolls back, the
        -- cursor rightly does not move, and the next tick resends into the same constraint forever.
        -- Team-scoping it would only narrow the wedge to same-team nodes — the population federation
        -- exists to serve. Uniqueness is scoped to the ORIGIN instead: an origin is answerable for
        -- its own ids and for nobody else's, and it cannot honestly mint one twice (messages.id is
        -- its own local primary key), so a repeat is its own corruption wedging only itself.
        CREATE TABLE IF NOT EXISTS sync_log (
          id           TEXT NOT NULL,
          team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          origin_node  TEXT NOT NULL REFERENCES nodes(id),
          origin_seq   INTEGER NOT NULL,
          hub_seq      INTEGER NOT NULL,
          payload      TEXT NOT NULL,
          received_at  INTEGER NOT NULL
        );
        -- The idempotence key (a replayed push is a no-op) and the canonical-order key. The second
        -- is UNIQUE rather than a plain index on purpose: it enforces hub_seq's density in the
        -- schema instead of trusting the allocator, and it is the index 3b-ii's cursor read walks.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_log_origin ON sync_log(origin_node, origin_seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_log_hub ON sync_log(team_id, hub_seq);
        -- Envelope-id uniqueness, scoped to the origin per the note above. NOTE for 3b-ii: this
        -- scoping did not REMOVE the wedge, it MOVED it. Two rows in one team may now share an
        -- envelope id, and messages.id is a PRIMARY KEY, so the fold cannot write both -- what was
        -- one node's push loop failing is now the whole team's fold failing, and 3b-ii inherits it.
        -- Still the right trade (refusing at the door hands one node a lever on another's
        -- liveness), but a real cost, not a footnote. The fold must key on (origin_node,
        -- origin_seq), and choosing what it does with the second row is 3b-ii's call.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_log_origin_id ON sync_log(origin_node, id);

        -- The hub's canonical-order allocator, per team. next_hub_seq names the NEXT value to
        -- assign, the same convention nodes.next_seq uses, so the allocator must hand out the
        -- PRE-increment value: copying this DEFAULT into an insert hands out 1 twice.
        CREATE TABLE IF NOT EXISTS sync_meta (
          team_id       TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          next_hub_seq  INTEGER NOT NULL DEFAULT 1
        );

        -- Local-only (ADR 325 residence 3): this describes THIS machine's conversation with a hub,
        -- not team state, so it is never replicated.
        CREATE TABLE IF NOT EXISTS sync_push_cursor (
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          node_id     TEXT NOT NULL,
          last_seq    INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (team_id, node_id)
        );
      `);
    },
  },
  {
    // Agent HTTP authority (ADR 337): an agent's durable, self-identifying credential is stored in
    // the existing per-member credential slot, kind-bound by the auth query. Each successful claim
    // additionally mints a short-lived lease tied to the exact presence it created. A presence
    // deletion therefore invalidates its lease even if an eviction path cannot explicitly revoke it.
    version: 51,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_leases (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          presence_id TEXT NOT NULL REFERENCES presence(id) ON DELETE CASCADE,
          token_hash  TEXT NOT NULL UNIQUE,
          expires_at  INTEGER NOT NULL,
          revoked_at  INTEGER,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_leases_lookup
          ON session_leases(team_id, member_id, presence_id, expires_at);
      `);
    },
  },
  {
    // ADR 344 replaces the Team-wide bootstrap-key column with independently scoped records.
    // Existing keys become explicit legacy records so an installed Workspace remains usable until
    // the separately ADR-gated compatibility removal.
    version: 52,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_bootstrap_credentials (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          key_hash    TEXT NOT NULL UNIQUE,
          use_kind    TEXT NOT NULL CHECK (use_kind IN ('claim_seat', 'claim_role', 'host', 'legacy')),
          target      TEXT,
          label       TEXT,
          state       TEXT NOT NULL CHECK (state IN ('active', 'rotated', 'revoked')),
          expires_at  INTEGER,
          created_by  TEXT,
          created_at  INTEGER NOT NULL,
          rotated_at  INTEGER,
          revoked_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_agent_bootstrap_credentials_lookup
          ON agent_bootstrap_credentials(team_id, key_hash, state, expires_at);
        INSERT OR IGNORE INTO agent_bootstrap_credentials
          (id, team_id, key_hash, use_kind, target, state, created_at)
        SELECT 'legacy-' || id, id, agent_key_hash, 'legacy', NULL, 'active', updated_at
        FROM teams
        WHERE agent_key_hash IS NOT NULL;
      `);
    },
  },
  {
    // The read cursors move off `messages.ts` (the origin's clock, which travels — ADR 335) onto
    // `created_at` (this daemon's receipt clock) so an event that arrives after a seat last read
    // but was stamped before it is the next unread rather than invisible forever (the ts-cursor
    // defect, lane 01M1FAYTHQA881M35PDPXRTGM1). Nothing in messages indexed created_at until now;
    // every inbox, interrupt-check and unread-count read scans by it from here on.
    version: 53,
    up: (db) => {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_messages_team_created ON messages(team_id, created_at);`,
      );
    },
  },
  {
    // Federation 3b-ii (spec 2026-09-01-sync-fold-design.md §Schema). v47 added the origin pair to
    // messages; nothing enforced its uniqueness because insertMessage was the only writer and it
    // allocates gaplessly. The fold is a second writer, so the schema holds the invariant now.
    // The fold's idempotence key = this index. NOT messages.id (ADR 335 scoped id uniqueness to the
    // origin, so two origins may legitimately stage one id in one team). The created_at index the
    // spec put here landed as v53 (ADR 349, the ts-cursor fix) — this migration adds only its own.
    version: 54,
    up: (db) => {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_origin ON messages(origin_node, origin_seq);

        -- Local-only (ADR 325 residence 3), like sync_push_cursor: this daemon's memory of how far
        -- it has applied the team's canonical order to its own messages. One row per team — a
        -- daemon is a puller for a team or it is not. The hub uses the same row for its own fold.
        CREATE TABLE IF NOT EXISTS sync_pull_cursor (
          team_id       TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          last_hub_seq  INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // v54 is reserved by the open federation 3b-ii branch. Gaps are valid; using v55 avoids the
    // collision that would make the second same-number migration silently never run.
    // ADR 350: persist migration provenance, first scoped use, and per-Team legacy cutover.
    version: 55,
    up: (db) => {
      // Guard ALTERs for the version-rewind migration tests, which replay the tail against an
      // already-widened schema. The production runner still applies this exactly once.
      const credentialCols = db
        .prepare("SELECT name FROM pragma_table_info('agent_bootstrap_credentials')")
        .pluck()
        .all();
      if (!credentialCols.includes('migration_target_member_id')) {
        db.exec(
          'ALTER TABLE agent_bootstrap_credentials ' +
            'ADD COLUMN migration_target_member_id TEXT REFERENCES members(id)',
        );
      }
      if (!credentialCols.includes('first_used_at')) {
        db.exec('ALTER TABLE agent_bootstrap_credentials ADD COLUMN first_used_at INTEGER');
      }
      const teamCols = db.prepare("SELECT name FROM pragma_table_info('teams')").pluck().all();
      if (!teamCols.includes('bootstrap_cutover_at')) {
        db.exec('ALTER TABLE teams ADD COLUMN bootstrap_cutover_at INTEGER');
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_bootstrap_migration_target
        ON agent_bootstrap_credentials(
          team_id,
          migration_target_member_id,
          state,
          first_used_at
        );
      `);
    },
  },
  {
    // v54 never ran on any DB that had already reached v55. #1164 (ADR 350) landed v55 on main
    // first; #1155 (3b-ii) then landed v54 behind it, and runMigrations is a high-water mark, so a
    // lower number arriving later is skipped. The dogfood daemon sat at schema 55 with no
    // idx_messages_origin and no sync_pull_cursor (ryder, 3b-ii acceptance, 2026-09-02). Re-issue
    // v54's body verbatim; every statement is IF NOT EXISTS, so a DB that ran v54 is untouched.
    version: 56,
    up: (db) => {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_origin ON messages(origin_node, origin_seq);
        CREATE TABLE IF NOT EXISTS sync_pull_cursor (
          team_id       TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          last_hub_seq  INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // ADR 352: `grok` joins the Surface enum. SQLite cannot ALTER a CHECK, so rebuild presence
    // the way v39 (`musterd`) and v44 (`opencode`) did. Column list matches the live table
    // (v44 + model_source from v42); v1 DDL in schema.ts is deliberately left stale.
    version: 57,
    up: (db) => {
      db.exec(`
        CREATE TABLE presence_new (
          id            TEXT PRIMARY KEY,
          member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          surface       TEXT NOT NULL CHECK (surface IN
                          ('cli','claude-code','codex','opencode','grok','cursor','web','ios','slack',
                           'other','musterd')),
          status        TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','away','offline')),
          conn_id       TEXT,
          last_seen_at  INTEGER NOT NULL,
          created_at    INTEGER NOT NULL,
          held_until    INTEGER,
          provenance    TEXT,
          workspace     TEXT,
          driver        TEXT,
          model         TEXT,
          build         TEXT,
          epoch         INTEGER,
          wake_lease    TEXT,
          model_source  TEXT
        );
        INSERT INTO presence_new (id, member_id, surface, status, conn_id, last_seen_at, created_at,
                                  held_until, provenance, workspace, driver, model, build, epoch,
                                  wake_lease, model_source)
          SELECT id, member_id, surface, status, conn_id, last_seen_at, created_at,
                 held_until, provenance, workspace, driver, model, build, epoch,
                 wake_lease, model_source
          FROM presence;
        DROP TABLE presence;
        ALTER TABLE presence_new RENAME TO presence;
        CREATE INDEX idx_presence_member ON presence(member_id);
        CREATE INDEX idx_presence_last_seen ON presence(last_seen_at);
      `);
    },
  },
  {
    // Lane-replication slice (spec 2026-09-01 §"The wire, decided"): a `lane.*` audit row is the
    // second replicated kind. It draws `(origin_node, origin_seq)` from the same `nodes.next_seq`
    // allocator as messages (ADR 335 §8) at the moment the store writes it. Every other audit row,
    // and every row older than this migration, keeps the DEFAULTs and reads as "not replicated";
    // the unique index is partial on `origin_seq > 0` so those rows never collide with each other.
    // This is the fold's idempotence key, the shape v54 gave `idx_messages_origin`.
    //
    // v58 lands after v57 (#1181, presence CHECK): runMigrations is a high-water mark, so a lower
    // number arriving later never runs (the v54/v55 lesson, #1174).
    version: 58,
    up: (db) => {
      const cols = db
        .prepare<[], { name: string }>('PRAGMA table_info(audit)')
        .all()
        .map((c) => c.name);
      if (!cols.includes('origin_node'))
        db.exec("ALTER TABLE audit ADD COLUMN origin_node TEXT NOT NULL DEFAULT ''");
      if (!cols.includes('origin_seq'))
        db.exec('ALTER TABLE audit ADD COLUMN origin_seq INTEGER NOT NULL DEFAULT 0');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_origin ON audit(origin_node, origin_seq) WHERE origin_seq > 0',
      );
    },
  },
  {
    // ADR 328 §4, enforced (ADR 355 amendment, 2026-09-02): the hub-minted seat→node residence
    // binding. "Seat X binds to node N the first time N speaks for X", first-writer-wins — the
    // primary key on `member_id` IS the guarded CAS (`INSERT … ON CONFLICT DO NOTHING`, the
    // `bindNode` shape). Re-binding is an explicit act (a DELETE under admin authority), never a
    // silent overwrite. Hub-local: `member_id` is this daemon's private anchor (ADR 325), which is
    // exactly right for a table only the arbitrating daemon reads. On a single-machine install
    // every seat binds to the local node on its first self-claim, so when a second machine enrolls
    // the seats that have been building here are already the hub's — the honest reading of "where
    // does this seat live" and the case ADR 328 §Experiment watches.
    version: 59,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS seat_nodes (
          member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
          team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          bound_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_seat_nodes_node ON seat_nodes(node_id);
      `);
    },
  },
  {
    // Presence replication (spec 2026-09-02, ADR 356): a presence row folded from another machine
    // carries the `nodes.id` it lives on; NULL is a local row (a socket or an ambient touch animates
    // it). Every reader's liveness predicate branches on this column (store/presence.ts
    // LIVE_PRESENCE_SQL), and the reaper's heartbeat cutoff applies to local rows only.
    version: 61,
    up: (db) => {
      const cols = db
        .prepare<[], { name: string }>('PRAGMA table_info(presence)')
        .all()
        .map((c) => c.name);
      if (!cols.includes('node')) db.exec('ALTER TABLE presence ADD COLUMN node TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_presence_node ON presence(node)');
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
    if (m.fkOff) {
      // The pragma is refused inside a transaction, so it brackets the tx. See Migration.fkOff.
      db.pragma('foreign_keys = OFF');
      try {
        tx();
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length > 0)
          throw new Error(
            `migration ${m.version} left ${broken.length} broken foreign-key reference(s)`,
          );
      } finally {
        db.pragma('foreign_keys = ON');
      }
    } else {
      tx();
    }
    applied = m.version;
  }
  return applied;
}
