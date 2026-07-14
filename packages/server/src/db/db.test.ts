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
    expect(ver?.value).toBe('21');
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

    expect(runMigrations(db)).toBe(21); // runs v18…v21 (observer grades + residency + offline reason + send provenance)

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
});
