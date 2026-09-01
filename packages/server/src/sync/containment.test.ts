import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { openDb, type Database } from '../db/open.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam } from '../store/teams.js';

/**
 * The 3b-i containment property, and the reason the slice boundary is real rather than asserted.
 *
 * ADR 331 §Consequences warned that a second insert path — one reaching `messages` without going
 * through `insertMessage` — would break the gaplessness the whole ordering substrate rests on.
 * This slice's answer is to not build one: pushed events land in `sync_log` and stop there. The
 * fold into `messages` is 3b-ii, one implementation run by hub and puller alike.
 *
 * Written BEFORE any ingest exists, so it cannot be retrofitted to whatever the code turned out to
 * do. When 3b-ii adds the fold, this file is what says the fold is the ONLY such path.
 */

/** The local state 3b-i must leave alone: the message log, and every origin's next-seq counter. */
function snapshot(db: Database) {
  return {
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get(),
    seqs: db.prepare('SELECT id, next_seq FROM nodes ORDER BY id').all(),
  };
}

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  insertMessage(
    db,
    team.id,
    ada.id,
    null,
    makeEnvelope({
      id: 'm-1',
      team: 'revive',
      from: 'ada',
      to: { kind: 'team' },
      act: 'message',
      body: 'hi',
      ts: 1000,
    }),
  );
  return { db, team };
}

describe('3b-i containment', () => {
  it('has the three staging tables, and they start empty', () => {
    const { db } = seed();

    for (const table of ['sync_log', 'sync_meta', 'sync_push_cursor']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }

    db.close();
  });

  it('leaves the message log and every next_seq untouched when v50 replays', () => {
    const { db } = seed();
    const before = snapshot(db);
    // One message, one local node that has handed out exactly one seq.
    expect(before.messages).toEqual({ n: 1 });
    expect(before.seqs).toEqual([{ id: expect.any(String), next_seq: 2 }]);

    // Rewind past v50 and replay the migration tail. v51–v53 add independent tables and an index;
    // v54 adds the origin index and the pull cursor, and touches no row; v55 adds guarded columns.
    db.prepare("UPDATE schema_meta SET value = '49' WHERE key = 'schema_version'").run();
    expect(runMigrations(db)).toBe(55);

    expect(snapshot(db)).toEqual(before);
    // …and the replay did not drop what was already staged-adjacent: the tables survive it.
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_log').get()).toEqual({ n: 0 });
    db.close();
  });

  it('v52 holds (origin_node, origin_seq) unique in messages and adds the pull cursor', () => {
    const { db, team } = seed();
    const row = db
      .prepare<
        [string],
        { origin_node: string; origin_seq: number }
      >('SELECT origin_node, origin_seq FROM messages WHERE team_id = ? LIMIT 1')
      .get(team.id)!;
    const author = db.prepare<[], { id: string }>('SELECT id FROM members LIMIT 1').get()!.id;
    // A second row under the SAME origin pair must be refused by the schema, not by convention:
    // the fold (3b-ii) is a second writer, and its idempotence key is this pair, not messages.id.
    expect(() =>
      db
        .prepare(
          `INSERT INTO messages (id, team_id, from_member, to_kind, to_member, act, body, ts,
                                 created_at, origin_node, origin_seq)
           VALUES ('dup', ?, ?, 'team', NULL, 'message', 'x', 1, 1, ?, ?)`,
        )
        .run(team.id, author, row.origin_node, row.origin_seq),
    ).toThrow(/UNIQUE|constraint/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_pull_cursor').get()).toEqual({ n: 0 });
    // The read side's future key (spec §"The ts-cursor defect") is indexed by the same migration.
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_team_created'",
        )
        .get(),
    ).toBeDefined();
    db.close();
  });

  it('stages two rows in one team that the fold cannot both write', () => {
    const { db, team } = seed();
    for (const id of ['node-a', 'node-b']) {
      db.prepare('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)').run(
        id,
        team.id,
        id,
      );
    }

    // ADR 335 §Decision 6 scopes envelope-id uniqueness to the ORIGIN, which is the right trade —
    // a wider scope hands one node a lever on another node's liveness. But it did not remove that
    // wedge, it MOVED it, and this test is where the move is written down rather than argued
    // about (dolly, 2026-08-31). Two origins may now stage one id in one team:
    for (const node of ['node-a', 'node-b']) {
      db.prepare(
        `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
         VALUES (?, ?, ?, 1, ?, '{}', 1000)`,
      ).run('COLLIDE', team.id, node, node === 'node-a' ? 1 : 2);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_log').get()).toEqual({ n: 2 });

    // …and `messages.id` is a PRIMARY KEY, so 3b-ii's fold can write exactly one of them. What was
    // one node's push loop failing has become the whole team's fold failing. Standing here, in
    // 3b-i, that is a consequence to state; 3b-ii owns choosing what the fold does about it.
    const author = db.prepare<[], { id: string }>('SELECT id FROM members LIMIT 1').get()!.id;
    const fold = (origin: string) =>
      db
        .prepare(
          `INSERT INTO messages (id, team_id, from_member, to_kind, to_member, act, body, ts,
                                 created_at, origin_node, origin_seq)
           SELECT id, team_id, ?, 'team', NULL, 'message', 'hi', 1000, 1000, origin_node, origin_seq
             FROM sync_log WHERE origin_node = ?`,
        )
        .run(author, origin);

    fold('node-a');
    expect(() => fold('node-b')).toThrow(/UNIQUE|PRIMARY KEY|constraint/i);
    db.close();
  });

  it('keeps the staging tables free of any counter tied to nodes.next_seq', () => {
    const { db } = seed();

    // `hub_seq` is the hub's own canonical order over staged rows; `last_seq` is this machine's
    // memory of how far it has pushed. Neither is an origin's next-seq allocator, and no column
    // here may become one — that allocator lives in `nodes` and is `insertMessage`'s alone.
    for (const table of ['sync_log', 'sync_meta', 'sync_push_cursor']) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      // PRAGMA on a table that does not exist returns nothing, and "nothing" contains no
      // `next_seq` — so assert the table is really there before reading the absence as a result.
      expect(columns.length).toBeGreaterThan(0);
      expect(columns).not.toContain('next_seq');
    }

    db.close();
  });
});
