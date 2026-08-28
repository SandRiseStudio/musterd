import { PROTOCOL_VERSION } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createTeam } from '../store/teams.js';
import {
  hubHead,
  highestContiguousSeq,
  ingestBatch,
  SyncGapError,
  SyncOriginError,
} from './log.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  for (const id of ['node-a', 'node-b']) {
    db.prepare('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)').run(
      id,
      team.id,
      id,
    );
  }
  return { db, team };
}

function ev(node: string, seq: number, id = `${node}-${seq}`) {
  return {
    envelope: {
      id,
      v: PROTOCOL_VERSION,
      team: 'revive',
      from: 'ada',
      to: { kind: 'team' as const },
      act: 'message' as const,
      body: 'hi',
      ts: 1000 + seq,
    },
    origin_node: node,
    origin_seq: seq,
    from_provenance: null,
  };
}

const staged = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT COUNT(*) AS n FROM sync_log').get();

describe('hub ingest (ADR 325)', () => {
  it("refuses a batch carrying another node's origin", () => {
    const { db, team } = seed();
    // ADR 328 §1: an event's origin is a fact the hub authenticated, not a string the sender chose.
    // Without this check that sentence is aspiration — one compromised machine could mint events
    // attributed to any other.
    expect(() => ingestBatch(db, team.id, 'node-a', [ev('node-b', 1)])).toThrow(SyncOriginError);
    expect(staged(db)).toEqual({ n: 0 });
    db.close();
  });

  it('refuses a node that is not a member of the team it is pushing to', () => {
    const { db } = seed();
    const other = createTeam(db, { slug: 'dawn' });
    // `nodes.id` is a GLOBAL primary key while a node belongs to exactly one team, so an
    // authenticated node id proves identity but NOT that it may write to this team's log. The same
    // global-PK-versus-team-scope confusion was the one confirmed hole in increment 3a (izzo,
    // 2026-08-27); it does not get to recur one increment later.
    expect(() => ingestBatch(db, other.id, 'node-a', [ev('node-a', 1)])).toThrow(SyncOriginError);
    expect(staged(db)).toEqual({ n: 0 });
    db.close();
  });

  it('refuses a gap and names the resume point', () => {
    const { db, team } = seed();
    ingestBatch(db, team.id, 'node-a', [ev('node-a', 1)]);
    try {
      ingestBatch(db, team.id, 'node-a', [ev('node-a', 3)]);
      throw new Error('expected a gap refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(SyncGapError);
      // A pusher that cannot self-correct retries the same rejected batch forever.
      expect((err as SyncGapError).expectedSeq).toBe(2);
    }
    db.close();
  });

  it('is idempotent — a replayed batch inserts nothing and still acks', () => {
    const { db, team } = seed();
    const first = ingestBatch(db, team.id, 'node-a', [ev('node-a', 1), ev('node-a', 2)]);
    expect(first.accepted).toBe(2);
    // A lost ack is the realistic case; the pusher resends the same batch.
    const replay = ingestBatch(db, team.id, 'node-a', [ev('node-a', 1), ev('node-a', 2)]);
    expect(replay.accepted).toBe(0);
    expect(replay.hub_seq_high).toBe(first.hub_seq_high);
    expect(staged(db)).toEqual({ n: 2 });
    db.close();
  });

  it('accepts the unheld tail of a partially replayed batch', () => {
    const { db, team } = seed();
    ingestBatch(db, team.id, 'node-a', [ev('node-a', 1)]);
    // The pusher's cursor lagged: it resends 1 (held) alongside 2 (new). Skipping the replay must
    // not be read as a gap, and the new tail must still land.
    const res = ingestBatch(db, team.id, 'node-a', [ev('node-a', 1), ev('node-a', 2)]);
    expect(res.accepted).toBe(1);
    expect(highestContiguousSeq(db, 'node-a')).toBe(2);
    db.close();
  });

  it('keeps two origins independent and hub_seq dense across them', () => {
    const { db, team } = seed();
    ingestBatch(db, team.id, 'node-a', [ev('node-a', 1)]);
    ingestBatch(db, team.id, 'node-b', [ev('node-b', 1), ev('node-b', 2)]);
    ingestBatch(db, team.id, 'node-a', [ev('node-a', 2)]);

    const rows = db
      .prepare<
        [],
        { origin_node: string; origin_seq: number; hub_seq: number }
      >('SELECT origin_node, origin_seq, hub_seq FROM sync_log ORDER BY hub_seq')
      .all();
    // Order of INGEST, not of ts — wall-clock across machines is what ADR 331 §Context says cannot
    // be trusted; arrival at the one authority is a fact the authority observed.
    expect(rows.map((r) => r.hub_seq)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => `${r.origin_node}:${r.origin_seq}`)).toEqual([
      'node-a:1',
      'node-b:1',
      'node-b:2',
      'node-a:2',
    ]);
    expect(hubHead(db, team.id)).toBe(4);
    db.close();
  });

  it('starts hub_seq at 1 and leaves next_hub_seq one ahead', () => {
    const { db, team } = seed();
    ingestBatch(db, team.id, 'node-a', [ev('node-a', 1)]);
    // The allocator hands out the PRE-increment value. Copying the schema's DEFAULT 1 into the
    // insert instead would hand out hub_seq 1 twice — the shape of the bug ADR 331's first draft
    // carried, and the reason idx_sync_log_hub is UNIQUE.
    expect(db.prepare('SELECT hub_seq FROM sync_log').get()).toEqual({ hub_seq: 1 });
    expect(db.prepare('SELECT next_hub_seq FROM sync_meta').get()).toEqual({ next_hub_seq: 2 });
    db.close();
  });

  it('a rejected batch stages nothing — the refusal rolls back', () => {
    const { db, team } = seed();
    // Second event gaps: better-sqlite3 COMMITS a transaction whose function RETURNS, so the
    // refusal has to throw. A half-applied batch would leave a hole the pusher cannot see.
    expect(() => ingestBatch(db, team.id, 'node-a', [ev('node-a', 1), ev('node-a', 3)])).toThrow(
      SyncGapError,
    );
    expect(staged(db)).toEqual({ n: 0 });
    expect(hubHead(db, team.id)).toBe(0);
    db.close();
  });

  it('refuses a distinct event that reuses a staged envelope id, rather than dropping it', () => {
    const { db, team } = seed();
    ingestBatch(db, team.id, 'node-a', [ev('node-a', 1)]);
    // seq 2 carrying seq 1's envelope id is not a replay — the idempotence key (origin_node,
    // origin_seq) says these are different events. Swallowing it would advance the origin's
    // sequence past an event the hub never stored: silent loss wearing an ack, which is precisely
    // the loss-versus-silence ambiguity ADR 331 exists to prevent. It must be loud.
    expect(() => ingestBatch(db, team.id, 'node-a', [ev('node-a', 2, 'node-a-1')])).toThrow();
    expect(staged(db)).toEqual({ n: 1 });
    // And the refusal took the allocated hub_seq back down with it, so the order stays dense.
    expect(hubHead(db, team.id)).toBe(1);
    expect(db.prepare('SELECT next_hub_seq FROM sync_meta').get()).toEqual({ next_hub_seq: 2 });
    db.close();
  });

  it('reports no held sequence for a node that has pushed nothing', () => {
    const { db, team } = seed();
    expect(highestContiguousSeq(db, 'node-b')).toBe(0);
    expect(hubHead(db, team.id)).toBe(0);
    db.close();
  });

  it('writes nothing to messages and moves no next_seq', () => {
    const { db, team } = seed();
    ingestBatch(db, team.id, 'node-a', [ev('node-a', 1), ev('node-a', 2)]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(db.prepare<[], { next_seq: number }>('SELECT next_seq FROM nodes').all()).toEqual([
      { next_seq: 1 },
      { next_seq: 1 },
    ]);
    db.close();
  });
});
