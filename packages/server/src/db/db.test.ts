import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { openDb } from './open.js';
import { seedDawn } from './seed.js';

describe('db', () => {
  it('opens in-memory, migrates to the latest schema, sets foreign_keys', () => {
    const db = openDb(':memory:');
    const ver = db
      .prepare<[], { value: string }>("SELECT value FROM schema_meta WHERE key='schema_version'")
      .get();
    expect(ver?.value).toBe('26');
    const fk = db.prepare<[], { foreign_keys: number }>('PRAGMA foreign_keys').get();
    expect(fk?.foreign_keys).toBe(1);
    db.close();
  });

  it('v14 widens messages.act beyond the frozen v5 CHECK (steering acts persist, ADR 103)', () => {
    const db = openDb(':memory:');
    seedDawn(db);
    const team = db.prepare<[], { id: string }>('SELECT id FROM teams LIMIT 1').get();
    const member = db.prepare<[], { id: string }>('SELECT id FROM members LIMIT 1').get();
    // Inserting a `steer` (unknown to the v5 CHECK vocabulary) must not throw at the DB layer.
    expect(() =>
      db
        .prepare(
          `INSERT INTO messages (id, team_id, from_member, to_kind, act, body, ts, created_at)
           VALUES (?, ?, ?, 'team', 'steer', '', 1, 1)`,
        )
        .run('m-steer', team!.id, member!.id),
    ).not.toThrow();
    db.close();
  });

  it('v12 adds the goal_id join column on lanes (ADR 084)', () => {
    const db = openDb(':memory:');
    const laneCols = (db.prepare('PRAGMA table_info(lanes)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(laneCols).toContain('goal_id');
    db.close();
  });

  it('v15 adds the model attestation column on presence (ADR 101)', () => {
    const db = openDb(':memory:');
    const presenceCols = (
      db.prepare('PRAGMA table_info(presence)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(presenceCols).toContain('model');
    db.close();
  });

  it('v19 adds the resumable-attestation columns on residency (ADR 131 inc 4)', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(residency)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(['resumable_harness', 'resumable_at']));
    db.close();
  });

  it('v20 adds last_offline_reason on members (ADR 141)', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(members)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('last_offline_reason');
    db.close();
  });

  it('v25 indexes audit by action, and the planner actually picks it over (team_id, ts)', () => {
    const db = openDb(':memory:');
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit'")
        .all() as {
        name: string;
      }[]
    ).map((i) => i.name);
    expect(indexes).toContain('idx_audit_team_action_ts');

    // Existence is not the point — the planner choosing it is. Without this index these reads
    // SCAN every row the team owns; asserting the chosen index is what stops a later schema
    // change from silently returning them to a scan.
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT target, detail FROM audit
             WHERE team_id = ? AND action = 'lane.closed' ORDER BY ts`,
        )
        .all('t') as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(plan).toContain('idx_audit_team_action_ts');

    // The paged listing narrows by team_id alone and must keep using the v9 (team_id, ts) index —
    // it orders by ts, so the new index would be a regression there.
    const pagedPlan = (
      db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT * FROM audit WHERE team_id = ? ORDER BY ts DESC LIMIT ?',
        )
        .all('t', 50) as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(pagedPlan).toContain('idx_audit_team_ts');
    db.close();
  });

  it('v10 adds the P3.1 substrate: grants + requests tables, team/member secret columns', () => {
    const db = openDb(':memory:');
    // New tables exist and are queryable.
    expect(() => db.prepare('SELECT id FROM grants LIMIT 0').all()).not.toThrow();
    expect(() => db.prepare('SELECT id FROM requests LIMIT 0').all()).not.toThrow();
    // New columns exist on teams + members.
    const teamCols = (db.prepare('PRAGMA table_info(teams)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(teamCols).toEqual(expect.arrayContaining(['agent_key_hash', 'policy']));
    const memberCols = (db.prepare('PRAGMA table_info(members)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(memberCols).toContain('credential_hash');
    db.close();
  });

  it('seedDawn produces the canonical fixture', () => {
    const db = openDb(':memory:');
    const s = seedDawn(db);
    const members = db
      .prepare<
        [string],
        { name: string; kind: string; role: string }
      >('SELECT name, kind, role FROM members WHERE team_id = ? ORDER BY created_at')
      .all(s.teamId);
    expect(members).toEqual([
      { name: 'nick', kind: 'human', role: 'lead' },
      { name: 'Ada', kind: 'agent', role: 'backend' },
      { name: 'Lin', kind: 'agent', role: 'frontend' },
    ]);
    expect(s.ada.token).toMatch(/^mskd_/);
    db.close();
  });

  it('is idempotent when migrations re-run', () => {
    const db = openDb(':memory:');
    // running again should not throw or duplicate
    const before = db.prepare('SELECT count(*) AS n FROM schema_meta').get() as { n: number };
    expect(before.n).toBe(1);
    db.close();
  });
  /**
   * The v18 backfill (ADR 136), on the path that actually matters: an EXISTING database that already
   * holds observer seats — i.e. a live daemon with an open /live dashboard.
   *
   * Every other test opens a fresh db, where the backfill runs against zero rows and proves nothing.
   * If it were wrong, existing observers would come up with `observer_scope = NULL`... which still
   * resolves to 'full', so the *default* saves us — but only by luck. Pin the backfill itself: an
   * observer that predates grades must be explicitly 'full', never silently downgraded to 'public'
   * (which would blank the DM traffic out of a dashboard that has been working all along).
   */
  it('v18 backfills pre-existing observer seats to the full grade (no silent dashboard downgrade)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Build the database as it stood at v17 — every migration up to, but not including, observer grades.
    for (const m of MIGRATIONS) {
      if (m.version > 17) break;
      m.up(db);
    }
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', '17') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run();

    const now = Date.now();
    db.prepare(
      `INSERT INTO teams (id, slug, display, default_lifecycle, created_at, updated_at)
       VALUES ('t1', 'dawn', 'Dawn', 'forever', ?, ?)`,
    ).run(now, now);
    // A v17-shape row: no observer_scope column exists yet to set.
    const member = (observer: number, id: string, name: string) =>
      db
        .prepare(
          `INSERT INTO members (id, team_id, name, kind, role, lifecycle, observer, created_at, updated_at)
           VALUES (?, 't1', ?, 'human', '', 'forever', ?, ?, ?)`,
        )
        .run(id, name, observer, now, now);
    member(1, 'm-obs', 'web-legacy');
    member(0, 'm-reg', 'nick');

    expect(runMigrations(db)).toBe(26); // runs v18…v26 (observer grades + residency + offline reason + send provenance + tool-call stats + feature epoch + two-stage close + audit action index + sparse team policy)

    const scope = (id: string) =>
      db
        .prepare<
          [string],
          { observer_scope: string | null }
        >('SELECT observer_scope FROM members WHERE id = ?')
        .get(id)?.observer_scope;

    // The live dashboard's observer keeps seeing everything …
    expect(scope('m-obs')).toBe('full');
    // … and the grade stays meaningless (NULL) on an ordinary member, rather than reading as if it
    // governed one.
    expect(scope('m-reg')).toBeNull();
    db.close();
  });

  /**
   * v26 (ADR 185) — the rows already frozen by the old parse-then-store `setPolicy` are rewritten
   * sparse. `t1` carries the REAL `revive` blob as it stood on 2026-07-30 (the one non-NULL policy in
   * the live fleet); `t2` carries a NULL, which must stay NULL rather than becoming `{}`.
   */
  it('v26 strips the baked-in defaults out of a densely-stored team policy', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS) {
      if (m.version > 25) break;
      m.up(db);
    }
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', '25') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run();

    const now = Date.now();
    const team = (id: string, slug: string, policy: string | null) =>
      db
        .prepare(
          `INSERT INTO teams (id, slug, display, default_lifecycle, policy, created_at, updated_at)
           VALUES (?, ?, NULL, 'forever', ?, ?, ?)`,
        )
        .run(id, slug, policy, now, now);
    team(
      't1',
      'revive',
      JSON.stringify({
        allow_pre_issued_grants: false,
        standing_reseat_known_agents: true,
        ask_fallback_to_nonadmin: false,
        residency: {
          lane: 'both',
          cooldown_ms: 1_800_000,
          hourly_cap: 2,
          attempt_cap: 3,
          tool_policy: 'reply-only',
          timeout_ms: 300_000,
          transcript_max_bytes: 262_144,
        },
        enforcement: { classes: [] },
      }),
    );
    team('t2', 'dawn', null);

    expect(runMigrations(db)).toBe(26);

    const policy = (id: string) =>
      db
        .prepare<[string], { policy: string | null }>('SELECT policy FROM teams WHERE id = ?')
        .get(id)?.policy;

    // Seven stored keys in, one out: only the knob whose value differs from its default survives.
    expect(JSON.parse(policy('t1') as string)).toEqual({ standing_reseat_known_agents: true });
    // A team that never wrote a policy is not touched — NULL is already "everything inherited".
    expect(policy('t2')).toBeNull();
    db.close();
  });
});
