import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember, hashToken } from './members.js';
import { insertMessage } from './messages.js';
import { authenticateNode, bindNode } from './nodes.js';
import { createTeam } from './teams.js';

/**
 * `bindNode` — the hub's half of enrollment, and where ADR 331's owed refusal path lives.
 *
 * ADR 331 §Decision 1 moved allocation of the node id to the joiner: it presents the ULID migration
 * v47 minted for it rather than receiving a fresh one. That is a change of who allocates the
 * identifier, not of who vouches for it — the hub still authenticates the invite, still writes the
 * binding itself, and still has to be able to refuse. These tests are that refusal.
 */

function seed(slug = 'revive') {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug });
  const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  return { db, team, ada };
}

/** Mint this daemon's own local node row the way a live daemon does — by sending. */
function mintLocalNode(
  db: ReturnType<typeof openDb>,
  teamId: string,
  memberId: string,
  slug = 'revive',
): string {
  insertMessage(
    db,
    teamId,
    memberId,
    null,
    makeEnvelope({
      id: `m-${slug}`,
      team: slug,
      from: 'ada',
      to: { kind: 'team' as const },
      act: 'message',
      body: 'hi',
      ts: 1000,
      meta: null,
    }),
  );
  return db
    .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
    .get(teamId)!.node_id;
}

describe('bindNode (ADR 331 §Decision 1 — presented by the joiner, vouched for by the hub)', () => {
  it('inserts a presented id the hub has never seen', () => {
    const { db, team } = seed();
    expect(bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick')).not.toBeNull();

    const row = db
      .prepare<
        [string],
        { credential_hash: string; enrolled_at: number | null; label: string; next_seq: number }
      >('SELECT credential_hash, enrolled_at, label, next_seq FROM nodes WHERE id = ?')
      .get('node-remote');
    expect(row?.credential_hash).toBe(hashToken('msnode_aaa'));
    expect(row?.enrolled_at).not.toBeNull();
    expect(row?.label).toBe('laptop');
    // A fresh origin starts its sequence at 1 — the remote's stream is its own, not continued.
    expect(row?.next_seq).toBe(1);
    db.close();
  });

  it('refuses an id already bound to a DIFFERENT credential — the ADR 331 debt', () => {
    const { db, team } = seed();
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');

    expect(bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_bbb', 'nick')).toBeNull();
    // The first credential still stands — a refused rebind must not half-apply.
    expect(
      db
        .prepare<
          [string],
          { credential_hash: string }
        >('SELECT credential_hash FROM nodes WHERE id = ?')
        .get('node-remote')?.credential_hash,
    ).toBe(hashToken('msnode_aaa'));
    db.close();
  });

  it("refuses the hub's OWN local node id — a joiner must not bind the hub's origin", () => {
    const { db, team, ada } = seed();
    const ours = mintLocalNode(db, team.id, ada.id);

    // `credential_hash IS NULL` alone would ADMIT this: a hub never enrolls with itself, so its own
    // row is permanently unbound. Binding it would let the joiner stamp events as the hub.
    expect(bindNode(db, team.id, ours, 'impostor', 'msnode_ccc', 'nick')).toBeNull();
    expect(
      db
        .prepare<
          [string],
          { credential_hash: string | null }
        >('SELECT credential_hash FROM nodes WHERE id = ?')
        .get(ours)?.credential_hash,
    ).toBeNull();
    db.close();
  });

  it("does not disturb the hub's own stamping after a remote node enrolls", () => {
    const { db, team, ada } = seed();
    const ours = mintLocalNode(db, team.id, ada.id);
    bindNode(db, team.id, '00000000000000000000000000', 'laptop', 'msnode_aaa', 'nick');

    insertMessage(
      db,
      team.id,
      ada.id,
      null,
      makeEnvelope({
        id: 'm-after',
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' as const },
        act: 'message',
        body: 'still ours',
        ts: 2000,
        meta: null,
      }),
    );

    const row = db
      .prepare<
        [string],
        { origin_node: string; origin_seq: number }
      >('SELECT origin_node, origin_seq FROM messages WHERE id = ?')
      .get('m-after');
    expect(row?.origin_node).toBe(ours);
    expect(row?.origin_seq).toBe(2);
    db.close();
  });

  it("refuses another team's hub-local node id — the cross-team form of the same hole", () => {
    // miley's review finding (2026-08-27, review 01M12KQHT8). The hub hosts two teams. A joiner
    // enrolling into A presents the id of the hub's own local row for B. Every guard scoped to A
    // passes: A's local_node names a different id, and B's row is `credential_hash IS NULL` because
    // a hub never enrolls with itself — permanently. An `ON CONFLICT DO UPDATE` then writes the
    // joiner's credential onto B's origin identity, leaving `team_id` as B, and reports success.
    // The joiner can thereafter authenticate as team B's node.
    const db = openDb(':memory:');
    const a = createTeam(db, { slug: 'alpha' });
    const b = createTeam(db, { slug: 'bravo' });
    const adaA = addMember(db, a, { name: 'ada', kind: 'agent' }).row;
    const adaB = addMember(db, b, { name: 'ada', kind: 'agent' }).row;
    mintLocalNode(db, a.id, adaA.id, 'alpha');
    const hubLocalB = mintLocalNode(db, b.id, adaB.id, 'bravo');

    expect(bindNode(db, a.id, hubLocalB, 'impostor', 'msnode_ccc', 'nick')).toBeNull();

    // B's hub identity must still be unbound and still B's.
    const row = db
      .prepare<
        [string],
        { credential_hash: string | null; team_id: string }
      >('SELECT credential_hash, team_id FROM nodes WHERE id = ?')
      .get(hubLocalB);
    expect(row?.credential_hash).toBeNull();
    expect(row?.team_id).toBe(b.id);
    expect(authenticateNode(db, b.id, 'msnode_ccc')).toBeNull();
    db.close();
  });

  it('binds the same presented id independently per team — a node is a machine-TEAM principal', () => {
    const db = openDb(':memory:');
    const one = createTeam(db, { slug: 'one' });
    const two = createTeam(db, { slug: 'two' });

    expect(bindNode(db, one.id, 'node-a', 'laptop', 'msnode_aaa', 'nick')).not.toBeNull();
    // The SAME id under a second team is a distinct principal by ADR 331 §1 — but `nodes.id` is a
    // global PRIMARY KEY, so the row already exists and is already bound. It must refuse rather
    // than silently re-point the existing row's team.
    expect(bindNode(db, two.id, 'node-a', 'laptop', 'msnode_bbb', 'nick')).toBeNull();
    expect(
      db
        .prepare<[string], { team_id: string }>('SELECT team_id FROM nodes WHERE id = ?')
        .get('node-a')?.team_id,
    ).toBe(one.id);
    db.close();
  });
});
