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

  it('leaves the message log and every next_seq untouched when v50 applies', () => {
    const { db } = seed();
    const before = snapshot(db);
    // One message, one local node that has handed out exactly one seq.
    expect(before.messages).toEqual({ n: 1 });
    expect(before.seqs).toEqual([{ id: expect.any(String), next_seq: 2 }]);

    // Rewind past v50 and replay it, which is the only thing this slice does to a live database.
    db.prepare("UPDATE schema_meta SET value = '49' WHERE key = 'schema_version'").run();
    expect(runMigrations(db)).toBe(50);

    expect(snapshot(db)).toEqual(before);
    // …and the replay did not drop what was already staged-adjacent: the tables survive it.
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_log').get()).toEqual({ n: 0 });
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
