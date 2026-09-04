import { makeEnvelope, type SyncPullEvent } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb, type Database } from '../db/open.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam } from '../store/teams.js';
import { foldBatch, foldNodeLiveness, readPullCursor } from './fold.js';

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
    expect(res).toMatchObject({ applied: 3, skipped: 0, last_hub_seq: 3, stop: null });
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
    expect(res).toMatchObject({ applied: 0, skipped: 1, last_hub_seq: 7, stop: null });
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
    expect(res).toMatchObject({ applied: 0, skipped: 1, last_hub_seq: 7, stop: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
    db.close();
  });

  it('is idempotent on (origin_node, origin_seq) — a replay applies nothing and advances the cursor', () => {
    const { db, team } = seed();
    foldBatch(db, team.id, [foreign('f-1', 1, 1)]);
    const res = foldBatch(db, team.id, [foreign('f-1', 1, 1), foreign('f-2', 2, 2)]);
    expect(res).toMatchObject({ applied: 1, skipped: 1, last_hub_seq: 2, stop: null });
    db.close();
  });

  it('blocks at an unresolvable FROM: prefix applied, cursor at the blocker, nothing after', () => {
    const { db, team } = seed();
    const res = foldBatch(db, team.id, [
      foreign('f-1', 1, 1),
      foreign('f-2', 2, 2, { from: 'ghost' }),
      foreign('f-3', 3, 3),
    ]);
    expect(res).toMatchObject({
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
    expect(foldBatch(db, team.id, batch)).toMatchObject({
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

/** A replicated `lane.*` row from the foreign origin (lane-replication spec §"The wire, decided"). */
function foreignLane(
  id: string,
  seq: number,
  hubSeq: number,
  action: string,
  detail: Record<string, unknown>,
): SyncPullEvent {
  return {
    kind: 'lane',
    team: 'revive',
    event: {
      id,
      ts: 3000 + seq,
      actor: 'nick',
      action,
      target: (detail['lane'] as string) ?? null,
      result: 'allow',
      detail,
    },
    origin_node: FOREIGN,
    origin_seq: seq,
    hub_seq: hubSeq,
  };
}

describe('foldBatch — the lane kind', () => {
  it('projects a birth into lanes, holds the row in audit with its stamp, and leaves the allocator alone', () => {
    const { db, team } = seed();
    const before = localNextSeq(db, team.id);
    const res = foldBatch(db, team.id, [
      foreignLane('e-1', 1, 1, 'lane.opened', {
        lane: 'L1',
        title: 'from afar',
        project: 'musterd',
        scope: ['a/**'],
        stakes: 'high',
        created_by: 'nick',
        created_at: 5,
      }),
      foreignLane('e-2', 2, 2, 'lane.claimed', { lane: 'L1', owner: 'nick', kind: 'claim' }),
    ]);
    expect(res).toMatchObject({ applied: 2, skipped: 0, last_hub_seq: 2, stop: null });
    expect(localNextSeq(db, team.id)).toBe(before);
    expect(
      db
        .prepare(
          'SELECT title, project, surface_globs, stakes, owner_seat, state, created_at FROM lanes WHERE id = ?',
        )
        .get('L1'),
    ).toEqual({
      title: 'from afar',
      project: 'musterd',
      surface_globs: '["a/**"]',
      stakes: 'high',
      owner_seat: 'nick',
      state: 'claimed',
      created_at: 5,
    });
    expect(
      db
        .prepare(
          'SELECT id, origin_node, origin_seq FROM audit WHERE origin_node = ? ORDER BY origin_seq',
        )
        .all(FOREIGN),
    ).toEqual([
      { id: 'e-1', origin_node: FOREIGN, origin_seq: 1 },
      { id: 'e-2', origin_node: FOREIGN, origin_seq: 2 },
    ]);
    db.close();
  });

  it('blocks on a verb it cannot project — the wire outran the reader', () => {
    const { db, team } = seed();
    const res = foldBatch(db, team.id, [
      foreignLane('e-1', 1, 1, 'lane.opened', { lane: 'L1', title: 't' }),
      foreignLane('e-2', 2, 2, 'lane.teleported', { lane: 'L1' }),
    ]);
    expect(res.applied).toBe(1);
    expect(res.stop).toEqual({ kind: 'unknown_lane_event', action: 'lane.teleported', hub_seq: 2 });
    expect(readPullCursor(db, team.id)).toBe(1);
    db.close();
  });

  it('blocks on a transition for a lane it never saw born, before the row lands in audit', () => {
    const { db, team } = seed();
    const res = foldBatch(db, team.id, [
      foreignLane('e-1', 1, 1, 'lane.claimed', { lane: 'GHOST', owner: 'nick', kind: 'claim' }),
    ]);
    expect(res.stop).toEqual({
      kind: 'lane_unborn',
      lane: 'GHOST',
      action: 'lane.claimed',
      hub_seq: 1,
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM audit WHERE origin_node = ?').get(FOREIGN),
    ).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM lanes WHERE id = ?').get('GHOST')).toEqual({
      n: 0,
    });
    db.close();
  });

  it('a message and a lane row from one origin share one dense sequence — no gap between kinds', () => {
    const { db, team } = seed();
    const res = foldBatch(db, team.id, [
      foreign('f-1', 1, 1),
      foreignLane('e-2', 2, 2, 'lane.opened', { lane: 'L1', title: 't' }),
      foreign('f-3', 3, 3),
    ]);
    expect(res).toMatchObject({ applied: 3, skipped: 0, last_hub_seq: 3, stop: null });
    db.close();
  });
});

/** A replicated `presence.*` row from the foreign origin (presence replication, 2026-09-02). */
function foreignPresence(
  id: string,
  seq: number,
  hubSeq: number,
  action: string,
  detail: Record<string, unknown>,
  actor = 'ada',
): SyncPullEvent {
  return {
    kind: 'presence',
    team: 'revive',
    event: { id, ts: 4000 + seq, actor, action, target: actor, result: 'allow', detail },
    origin_node: FOREIGN,
    origin_seq: seq,
    hub_seq: hubSeq,
  };
}

describe('foldBatch — the presence kind', () => {
  it('presence.attached inserts a remote row keyed on the origin node; reattested updates it; detached deletes it', () => {
    const { db, team } = seed();
    const att = foreignPresence('p-1', 1, 1, 'presence.attached', {
      presence: 'pB',
      surface: 'codex',
      model: 'gpt-5',
      model_source: 'observed',
      workspace: '~/b',
      driver: 'nick',
      provenance: 'session',
      build: null,
      epoch: 17,
    });
    expect(foldBatch(db, team.id, [att]).stop).toBeNull();
    expect(
      db
        .prepare(
          "SELECT node, surface, model, workspace, driver, conn_id, held_until, wake_lease FROM presence WHERE id = 'pB'",
        )
        .get(),
    ).toEqual({
      node: FOREIGN,
      surface: 'codex',
      model: 'gpt-5',
      workspace: '~/b',
      driver: 'nick',
      conn_id: null,
      held_until: null,
      wake_lease: null,
    });
    const re = foreignPresence('p-2', 2, 2, 'presence.reattested', {
      presence: 'pB',
      model: 'gpt-5-mini',
      model_source: 'observed',
      surface: 'codex',
    });
    expect(foldBatch(db, team.id, [re]).stop).toBeNull();
    expect(db.prepare("SELECT model FROM presence WHERE id = 'pB'").get()).toEqual({
      model: 'gpt-5-mini',
    });
    const det = foreignPresence('p-3', 3, 3, 'presence.detached', {
      presence: 'pB',
      reason: 'goodbye',
    });
    expect(foldBatch(db, team.id, [det]).stop).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM presence WHERE id = 'pB'").get()).toEqual({
      n: 0,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'presence.%' AND origin_node = ?",
        )
        .get(FOREIGN),
    ).toEqual({ n: 3 });
    // The allocator never moved for any of it.
    expect(localNextSeq(db, team.id)).toBe(2);
    db.close();
  });

  // Until ADR 384 the reattest half of this stopped as `presence_unborn`. It cannot: the row it
  // waits for is one this daemon's own reaper takes during a long replay, so the wait never ends —
  // it wedged the first real joiner at hub_seq 9659 with hundreds of sessions queued behind it.
  // Both halves now advance, and neither invents a row from a partial fact.
  it('a reattested for a session never seen attach advances like the detached for one, inventing no row', () => {
    const { db, team } = seed();
    const det = foreignPresence('p-1', 1, 1, 'presence.detached', {
      presence: 'ghost',
      reason: 'reaped',
    });
    expect(foldBatch(db, team.id, [det])).toMatchObject({
      stop: null,
      applied: 1,
      last_hub_seq: 1,
    });
    const re = foreignPresence('p-2', 2, 2, 'presence.reattested', {
      presence: 'ghost',
      model: 'x',
      model_source: null,
      surface: 'codex',
    });
    expect(foldBatch(db, team.id, [re])).toMatchObject({ stop: null, applied: 1, last_hub_seq: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE id = 'p-2'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM presence WHERE id = 'ghost'").get()).toEqual({
      n: 0,
    });
    expect(readPullCursor(db, team.id)).toBe(2);
    db.close();
  });

  it('an unknown presence verb or a surface this build cannot store stops as unknown_presence_event', () => {
    const { db, team } = seed();
    const weird = foreignPresence('p-1', 1, 1, 'presence.attached', {
      presence: 'p',
      surface: 'holodeck',
    });
    expect(foldBatch(db, team.id, [weird]).stop).toMatchObject({ kind: 'unknown_presence_event' });
    const verb = foreignPresence('p-1', 1, 1, 'presence.teleported', { presence: 'p' });
    expect(foldBatch(db, team.id, [verb]).stop).toMatchObject({ kind: 'unknown_presence_event' });
    db.close();
  });

  // Until ADR 382 this stopped as `unresolved_seat`, like a message. It cannot: a seat minted
  // db-only — a web sign-in — is never in git, so the wait never ends, and one wedged the first
  // real joiner permanently. Presence for a seat we do not hold projects into nothing, so it
  // advances with its audit row. The message half of the old rule is unchanged and is asserted by
  // its own test above; the two-daemon control lives in `sync/presence.test.ts`.
  it('a presence for a seat this roster lacks advances with its audit row, unlike a message', () => {
    const { db, team } = seed();
    const ev = foreignPresence(
      'p-1',
      1,
      1,
      'presence.attached',
      { presence: 'p', surface: 'codex' },
      'stranger',
    );
    const result = foldBatch(db, team.id, [ev]);
    expect(result.stop).toBeNull();
    expect(result.applied).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE id = 'p-1'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM presence WHERE id = 'p'").get()).toEqual({ n: 0 });
    db.close();
  });

  it('foldNodeLiveness upserts foreign nodes without touching the local allocator', () => {
    const { db, team } = seed();
    const localNode = db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(team.id)!.node_id;
    db.prepare('UPDATE nodes SET next_seq = 7 WHERE id = ?').run(localNode);
    foldNodeLiveness(db, team.id, [
      { id: localNode, label: 'me', last_seen_at: 1 },
      { id: 'nB', label: 'b', last_seen_at: 2 },
    ]);
    expect(db.prepare('SELECT next_seq FROM nodes WHERE id = ?').get(localNode)).toEqual({
      next_seq: 7,
    });
    expect(db.prepare("SELECT label, last_seen_at FROM nodes WHERE id = 'nB'").get()).toEqual({
      label: 'b',
      last_seen_at: 2,
    });
    db.close();
  });
});
