import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember } from './members.js';
import {
  bindSeatToNode,
  listNodeLiveness,
  seatBinding,
  seatBindings,
  touchNode,
  trustNodeForSeat,
  unbindSeat,
  upsertForeignNode,
} from './nodes.js';
import { createTeam } from './teams.js';

/**
 * The seat→node residence binding ADR 328 §4 decided and ADR 355 recorded without enforcing
 * (gptbot's #1190 decline, 2026-09-02): the hub mints "seat X lives on node N" the first time N
 * speaks for X, first-writer-wins under a guarded CAS, and a later node is refused with the bound
 * node named. Re-binding is an explicit act (`unbindSeat`), never a silent overwrite.
 */

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  db.prepare(
    "INSERT INTO nodes (id, team_id, label, next_seq) VALUES ('nA', ?, 'laptop-a', 1)",
  ).run(team.id);
  db.prepare(
    "INSERT INTO nodes (id, team_id, label, next_seq) VALUES ('nB', ?, 'laptop-b', 1)",
  ).run(team.id);
  db.prepare(
    "INSERT INTO nodes (id, team_id, label, next_seq, revoked_at) VALUES ('nX', ?, 'retired', 1, 5)",
  ).run(team.id);
  return { db, team, ada, nick };
}

describe('seat→node residence binding (ADR 328 §4)', () => {
  it('the first node to speak for a seat binds it; the same node re-binds idempotently', () => {
    const { db, team, ada } = seed();
    expect(bindSeatToNode(db, team.id, ada.id, 'nA', 10)).toEqual({ bound: true });
    expect(bindSeatToNode(db, team.id, ada.id, 'nA', 11)).toEqual({ bound: true });
    expect(seatBinding(db, ada.id)).toEqual({ node_id: 'nA', label: 'laptop-a', bound_at: 10 });
  });

  it('a second node is refused with the bound node named — two nodes racing one seat, exactly one wins', () => {
    const { db, team, ada } = seed();
    expect(bindSeatToNode(db, team.id, ada.id, 'nA', 10)).toEqual({ bound: true });
    expect(bindSeatToNode(db, team.id, ada.id, 'nB', 11)).toEqual({
      bound: false,
      node_id: 'nA',
      label: 'laptop-a',
    });
    expect(seatBinding(db, ada.id)?.node_id).toBe('nA');
  });

  it('unbind is the explicit re-bind act: after it, another node may bind', () => {
    const { db, team, ada } = seed();
    bindSeatToNode(db, team.id, ada.id, 'nA', 10);
    expect(unbindSeat(db, ada.id)).toEqual({ node_id: 'nA' });
    expect(unbindSeat(db, ada.id)).toBeNull();
    expect(bindSeatToNode(db, team.id, ada.id, 'nB', 12)).toEqual({ bound: true });
    expect(seatBinding(db, ada.id)?.node_id).toBe('nB');
  });
});

describe('a human seat trusts a SET of machines (ADR 358)', () => {
  it('a fresh machine cannot self-trust: the speaker must already be in the set, and an empty set has no voucher', () => {
    const { db, team, nick } = seed();
    expect(trustNodeForSeat(db, team.id, nick, 'nB', 'nB', 10)).toEqual({
      trusted: false,
      reason: 'not_resident',
    });
    bindSeatToNode(db, team.id, nick.id, 'nA', 10);
    expect(trustNodeForSeat(db, team.id, nick, 'nB', 'nB', 11)).toEqual({
      trusted: false,
      reason: 'not_resident',
    });
    expect(seatBindings(db, nick.id).map((b) => b.node_id)).toEqual(['nA']);
  });

  it('from a bound node the act adds another; both then speak for the seat; a repeat is idempotent', () => {
    const { db, team, nick } = seed();
    bindSeatToNode(db, team.id, nick.id, 'nA', 10);
    expect(trustNodeForSeat(db, team.id, nick, 'nA', 'nB', 11)).toEqual({
      trusted: true,
      already: false,
    });
    expect(seatBindings(db, nick.id).map((b) => b.node_id)).toEqual(['nA', 'nB']);
    expect(bindSeatToNode(db, team.id, nick.id, 'nB', 12)).toEqual({ bound: true });
    expect(bindSeatToNode(db, team.id, nick.id, 'nA', 12)).toEqual({ bound: true });
    // The first-bound node stays the one a refusal names.
    expect(seatBinding(db, nick.id)?.node_id).toBe('nA');
    expect(trustNodeForSeat(db, team.id, nick, 'nB', 'nA', 13)).toEqual({
      trusted: true,
      already: true,
    });
  });

  it('agents stay one-node, and a target must be an enrolled unrevoked node', () => {
    const { db, team, ada, nick } = seed();
    bindSeatToNode(db, team.id, ada.id, 'nA', 10);
    expect(trustNodeForSeat(db, team.id, ada, 'nA', 'nB', 11)).toEqual({
      trusted: false,
      reason: 'not_human',
    });
    bindSeatToNode(db, team.id, nick.id, 'nA', 10);
    expect(trustNodeForSeat(db, team.id, nick, 'nA', 'nX', 11)).toEqual({
      trusted: false,
      reason: 'unknown_node',
    });
    expect(trustNodeForSeat(db, team.id, nick, 'nA', 'nope', 11)).toEqual({
      trusted: false,
      reason: 'unknown_node',
    });
  });

  it('the admin unbind clears the whole set', () => {
    const { db, team, nick } = seed();
    bindSeatToNode(db, team.id, nick.id, 'nA', 10);
    trustNodeForSeat(db, team.id, nick, 'nA', 'nB', 11);
    expect(unbindSeat(db, nick.id)).toEqual({ node_id: 'nA' });
    expect(seatBindings(db, nick.id)).toEqual([]);
  });
});

describe('node liveness (presence replication, 2026-09-02)', () => {
  it('touchNode stamps last_seen_at; upsertForeignNode never touches next_seq or credentials', () => {
    const { db, team } = seed();
    upsertForeignNode(db, team.id, { id: 'nX', label: 'x', last_seen_at: 5 });
    db.prepare('UPDATE nodes SET next_seq = 40, credential_hash = ? WHERE id = ?').run('h', 'nX');
    upsertForeignNode(db, team.id, { id: 'nX', label: 'x2', last_seen_at: 9 });
    touchNode(db, 'nX', 11);
    expect(
      db
        .prepare('SELECT label, next_seq, credential_hash, last_seen_at FROM nodes WHERE id = ?')
        .get('nX'),
    ).toEqual({ label: 'x2', next_seq: 40, credential_hash: 'h', last_seen_at: 11 });
    expect(listNodeLiveness(db, team.id)).toContainEqual({
      id: 'nX',
      label: 'x2',
      last_seen_at: 11,
    });
  });
});
