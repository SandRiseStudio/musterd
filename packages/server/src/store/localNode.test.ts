import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { createTeam } from './teams.js';

/**
 * The `local_node` marker (increment 3a) — which `nodes` row is THIS daemon's, per team.
 *
 * Increment 2 picked it with `ORDER BY id LIMIT 1`, whose own comment conceded the assumption:
 * "before increment 3 lands enrollment there is exactly one row per team". Enrollment is precisely
 * what adds the second row, and a remote ULID that happens to sort lower would then take over our
 * stamp — our sequence gains a permanent hole, theirs gains numbers naming events it never wrote.
 * That is the loss-versus-silence ambiguity ADR 331 exists to prevent, so the marker lands here,
 * ahead of any code path that can insert a remote row.
 */

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  return { db, team, ada };
}

function env(id: string, ts: number) {
  return makeEnvelope({
    id,
    team: 'revive',
    from: 'ada',
    to: { kind: 'team' as const },
    act: 'message',
    body: 'hi',
    ts,
    meta: null,
  });
}

function localNodeId(db: ReturnType<typeof openDb>, teamId: string): string {
  return db
    .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
    .get(teamId)!.node_id;
}

describe('local_node — the marker that survives a second node row', () => {
  it('marks the row v47 minted, one per team', () => {
    const { db, team, ada } = seed();
    insertMessage(db, team.id, ada.id, null, env('m-1', 1001));

    const stamped = db
      .prepare<[string], { origin_node: string }>('SELECT origin_node FROM messages WHERE id = ?')
      .get('m-1')!.origin_node;
    expect(localNodeId(db, team.id)).toBe(stamped);
    db.close();
  });

  it('stamps OUR node even when a remote row sorts below it', () => {
    const { db, team, ada } = seed();
    insertMessage(db, team.id, ada.id, null, env('m-1', 1001));
    const ours = localNodeId(db, team.id);

    // An id that sorts strictly below ours — exactly what `ORDER BY id LIMIT 1` would prefer.
    // All-zeros rather than a mutated copy of `ours`: a real ULID's leading character is already
    // '0' for any timestamp this century, so patching the first byte yields the same string back.
    const lower = '0'.repeat(26);
    expect(lower < ours).toBe(true);
    db.prepare('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)').run(
      lower,
      team.id,
      'someone-elses-laptop',
    );

    insertMessage(db, team.id, ada.id, null, env('m-2', 1002));

    const stamped = db
      .prepare<[string], { origin_node: string }>('SELECT origin_node FROM messages WHERE id = ?')
      .get('m-2')!.origin_node;
    expect(stamped).toBe(ours);

    // And the remote node's counter is untouched — a stolen stamp corrupts two sequences, not one.
    expect(
      db
        .prepare<[string], { next_seq: number }>('SELECT next_seq FROM nodes WHERE id = ?')
        .get(lower)!.next_seq,
    ).toBe(1);
    db.close();
  });

  it('keeps one marker per team on a daemon hosting two', () => {
    const db = openDb(':memory:');
    const t1 = createTeam(db, { slug: 'one' });
    const t2 = createTeam(db, { slug: 'two' });
    const a1 = addMember(db, t1, { name: 'ada', kind: 'agent' }).row;
    const a2 = addMember(db, t2, { name: 'ada', kind: 'agent' }).row;
    insertMessage(db, t1.id, a1.id, null, env('m-1', 1001));
    insertMessage(db, t2.id, a2.id, null, env('m-2', 1002));

    expect(localNodeId(db, t1.id)).not.toBe(localNodeId(db, t2.id));
    expect(db.prepare('SELECT COUNT(*) AS n FROM local_node').get()).toEqual({ n: 2 });
    db.close();
  });
});
