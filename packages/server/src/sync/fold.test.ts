import { makeEnvelope, type SyncPullEvent } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb, type Database } from '../db/open.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam } from '../store/teams.js';
import { foldBatch, readPullCursor } from './fold.js';

/**
 * The fold (3b-ii) — the second insert path ADR 331 §Consequences warned about, built once and
 * falsified here. The first test is the falsifier: folding foreign events must not move this
 * daemon's own allocator.
 */

const FOREIGN = '01FOREIGNNODE00000000000000';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  // One local message so the local node row exists and has handed out one seq.
  insertMessage(
    db,
    team.id,
    ada.id,
    null,
    makeEnvelope({
      id: 'local-1',
      team: 'revive',
      from: 'ada',
      to: { kind: 'team' },
      act: 'message',
      body: 'hi',
      ts: 1000,
    }),
  );
  // messages.origin_node carries no FK (v47 ALTER) but sync_log.origin_node does; a nodes row for
  // the foreign origin lets a later test stage through ingestBatch if it wants to.
  db.prepare('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)').run(
    FOREIGN,
    team.id,
    'foreign',
  );
  return { db, team, ada, nick };
}

function localNextSeq(db: Database, teamId: string): number {
  return db
    .prepare<
      [string],
      { next_seq: number }
    >('SELECT n.next_seq FROM nodes n JOIN local_node l ON l.node_id = n.id WHERE l.team_id = ?')
    .get(teamId)!.next_seq;
}

function foreign(
  id: string,
  seq: number,
  hubSeq: number,
  overrides: Partial<{
    from: string;
    to: { kind: 'member'; name: string } | { kind: 'team' };
    act: string;
    ts: number;
  }> = {},
): SyncPullEvent {
  const envelope = makeEnvelope({
    id,
    team: 'revive',
    from: overrides.from ?? 'nick',
    to: overrides.to ?? { kind: 'team' },
    act: 'message',
    body: `b-${seq}`,
    ts: overrides.ts ?? 2000 + seq,
  });
  // makeEnvelope validates the act; an origin on a NEWER build would mint one this build's enum
  // refuses, so the override goes on after the parse — that is what "the wire outran the reader"
  // looks like from here.
  if (overrides.act) (envelope as { act: string }).act = overrides.act;
  return {
    envelope,
    origin_node: FOREIGN,
    origin_seq: seq,
    from_provenance: 'session',
    hub_seq: hubSeq,
  };
}

describe('foldBatch', () => {
  it('never moves the local allocator (the ADR 331 falsifier)', () => {
    const { db, team } = seed();
    const before = localNextSeq(db, team.id);
    const res = foldBatch(db, team.id, [
      foreign('f-1', 1, 1),
      foreign('f-2', 2, 2),
      foreign('f-3', 3, 3),
    ]);
    expect(res).toEqual({ applied: 3, skipped: 0, last_hub_seq: 3, stop: null });
    expect(localNextSeq(db, team.id)).toBe(before);
    const rows = db
      .prepare<
        [string],
        { id: string; origin_node: string; origin_seq: number; from_provenance: string }
      >('SELECT id, origin_node, origin_seq, from_provenance FROM messages WHERE origin_node = ? ORDER BY origin_seq')
      .all(FOREIGN);
    expect(rows).toEqual([
      { id: 'f-1', origin_node: FOREIGN, origin_seq: 1, from_provenance: 'session' },
      { id: 'f-2', origin_node: FOREIGN, origin_seq: 2, from_provenance: 'session' },
      { id: 'f-3', origin_node: FOREIGN, origin_seq: 3, from_provenance: 'session' },
    ]);
    expect(readPullCursor(db, team.id)).toBe(3);
    db.close();
  });

  it("resolves from/to by NAME to this daemon's member ids", () => {
    const { db, team, nick, ada } = seed();
    foldBatch(db, team.id, [
      foreign('f-1', 1, 1, { from: 'nick', to: { kind: 'member', name: 'ada' } }),
    ]);
    const row = db
      .prepare<
        [string],
        { from_member: string; to_member: string; to_kind: string }
      >('SELECT from_member, to_member, to_kind FROM messages WHERE id = ?')
      .get('f-1')!;
    expect(row).toEqual({ from_member: nick.id, to_member: ada.id, to_kind: 'member' });
    db.close();
  });

  it("stamps created_at with the fold's own clock, never the envelope's ts", () => {
    // Spec §"The ts-cursor defect": the readers moving off ts land on created_at, so a wire value
    // here would reintroduce the defect under the fixed column. ts travels; created_at does not.
    const { db, team } = seed();
    const now = 9_000_000;
    foldBatch(db, team.id, [foreign('f-1', 1, 1, { ts: 12 })], now);
    const row = db
      .prepare<
        [string],
        { ts: number; created_at: number }
      >('SELECT ts, created_at FROM messages WHERE id = ?')
      .get('f-1')!;
    expect(row).toEqual({ ts: 12, created_at: now });
    db.close();
  });

  it('skips its own origin — already in messages via insertMessage', () => {
    const { db, team } = seed();
    const local = db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(team.id)!.node_id;
    const own: SyncPullEvent = { ...foreign('local-1', 1, 7), origin_node: local };
    const res = foldBatch(db, team.id, [own]);
    expect(res).toEqual({ applied: 0, skipped: 1, last_hub_seq: 7, stop: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
    db.close();
  });

  it('skips its own origin even when nothing local holds that (origin, seq) — Rule 1 on its own', () => {
    // The test above passes with Rule 1 deleted: seq 1 IS already in messages, so Rule 2 (the
    // idempotence check) skips it first and masks the missing rule. An own-origin event with a seq
    // this daemon never allocated is the one only Rule 1 catches — and it must still be skipped,
    // because applying it would write a row under OUR origin stamp that WE never sent (dolly, #1155
    // review F2).
    const { db, team } = seed();
    const local = db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(team.id)!.node_id;
    const own: SyncPullEvent = { ...foreign('local-99', 99, 7), origin_node: local };
    const res = foldBatch(db, team.id, [own]);
    expect(res).toEqual({ applied: 0, skipped: 1, last_hub_seq: 7, stop: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
    db.close();
  });

  it('is idempotent on (origin_node, origin_seq) — a replay applies nothing and advances the cursor', () => {
    const { db, team } = seed();
    foldBatch(db, team.id, [foreign('f-1', 1, 1)]);
    const res = foldBatch(db, team.id, [foreign('f-1', 1, 1), foreign('f-2', 2, 2)]);
    expect(res).toEqual({ applied: 1, skipped: 1, last_hub_seq: 2, stop: null });
    db.close();
  });

  it('blocks at an unresolvable FROM: prefix applied, cursor at the blocker, nothing after', () => {
    const { db, team } = seed();
    const res = foldBatch(db, team.id, [
      foreign('f-1', 1, 1),
      foreign('f-2', 2, 2, { from: 'ghost' }),
      foreign('f-3', 3, 3),
    ]);
    expect(res).toEqual({
      applied: 1,
      skipped: 0,
      last_hub_seq: 1,
      stop: { kind: 'unresolved_seat', seat: 'ghost', hub_seq: 2 },
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE origin_node = ?').get(FOREIGN),
    ).toEqual({ n: 1 });
    expect(readPullCursor(db, team.id)).toBe(1);
    db.close();
  });

  it('blocks at an unresolvable TO — a directed act never silently becomes a broadcast', () => {
    const { db, team } = seed();
    const res = foldBatch(db, team.id, [
      foreign('f-1', 1, 1, { to: { kind: 'member', name: 'ghost' } }),
    ]);
    expect(res.stop).toEqual({ kind: 'unresolved_seat', seat: 'ghost', hub_seq: 1 });
    expect(res.applied).toBe(0);
    expect(readPullCursor(db, team.id)).toBe(0);
    db.close();
  });

  it('resumes past a blocker once the roster knows the seat', () => {
    const { db, team } = seed();
    const batch = [foreign('f-1', 1, 1, { from: 'late' })];
    expect(foldBatch(db, team.id, batch).stop?.kind).toBe('unresolved_seat');
    addMember(db, team, { name: 'late', kind: 'agent' });
    expect(foldBatch(db, team.id, batch)).toEqual({
      applied: 1,
      skipped: 0,
      last_hub_seq: 1,
      stop: null,
    });
    db.close();
  });

  it('advances the cursor in the same transaction as the applied rows', () => {
    const { db, team } = seed();
    // An act this build's CHECK refuses on the second event: a classified STOP, not a throw, so
    // the prefix and the cursor commit together.
    const res = foldBatch(db, team.id, [
      foreign('f-1', 1, 1),
      foreign('f-2', 2, 2, { act: 'not-an-act' }),
    ]);
    expect(res.stop).toEqual({ kind: 'unknown_act', act: 'not-an-act', hub_seq: 2 });
    expect(res.applied).toBe(1);
    expect(readPullCursor(db, team.id)).toBe(1);
    db.close();
  });

  it('treats an envelope id already held under a DIFFERENT origin pair as terminal', () => {
    const { db, team } = seed();
    // 'local-1' exists under the local origin; a foreign event reusing that id is rule 5.
    const res = foldBatch(db, team.id, [foreign('local-1', 1, 1)]);
    expect(res.stop?.kind).toBe('id_collision');
    expect((res.stop as { held_origin: string }).held_origin).not.toBe(FOREIGN);
    expect(res.applied).toBe(0);
    db.close();
  });

  it('refuses an origin gap on the read side', () => {
    const { db, team } = seed();
    const res = foldBatch(db, team.id, [foreign('f-1', 1, 1), foreign('f-3', 3, 2)]);
    expect(res.stop).toEqual({
      kind: 'origin_gap',
      origin: FOREIGN,
      expected: 2,
      got: 3,
      hub_seq: 2,
    });
    expect(res.applied).toBe(1);
    expect(readPullCursor(db, team.id)).toBe(1);
    db.close();
  });
});
