import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { authenticateNode, bindNode, listNodes, revokeNode, rotateNode } from './nodes.js';
import { createTeam } from './teams.js';

/**
 * Node lifecycle (ADR 328 §5) — "rotation keeps the node; revocation keeps the history".
 *
 * The two halves are load-bearing for different reasons. Rotation must not touch `nodes.id`, or
 * every `origin_node` already stamped in the log stops naming its origin. Revocation must not touch
 * the log, or revoking a credential becomes retro-repudiating what was said under it.
 */

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  return { db, team, ada };
}

describe('node lifecycle (ADR 328 §5)', () => {
  it('rotation keeps the node id, so origin stamps survive it', () => {
    const { db, team } = seed();
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');

    const rotated = rotateNode(db, team.id, 'node-remote');
    expect(rotated).not.toBeNull();
    expect(rotated!.credential).toMatch(/^msnode_/);
    expect(rotated!.credential).not.toBe('msnode_aaa');

    // The old credential is dead, the new one works, and the identity is untouched — which is the
    // entire reason ADR 328 §5 made the id a ULID on the row rather than deriving it from the key.
    expect(authenticateNode(db, team.id, 'msnode_aaa')).toBeNull();
    expect(authenticateNode(db, team.id, rotated!.credential)?.id).toBe('node-remote');
    db.close();
  });

  it('refuses to rotate a revoked node — re-arming a retired credential is an enrollment', () => {
    const { db, team } = seed();
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');
    revokeNode(db, team.id, 'node-remote');

    expect(rotateNode(db, team.id, 'node-remote')).toBeNull();
    db.close();
  });

  it("refuses to rotate another team's node", () => {
    const db = openDb(':memory:');
    const one = createTeam(db, { slug: 'one' });
    const two = createTeam(db, { slug: 'two' });
    bindNode(db, one.id, 'node-a', 'laptop', 'msnode_aaa', 'nick');

    expect(rotateNode(db, two.id, 'node-a')).toBeNull();
    expect(authenticateNode(db, one.id, 'msnode_aaa')?.id).toBe('node-a');
    db.close();
  });

  it('a revoked node authenticates nowhere, and revoking twice does not lie about it', () => {
    const { db, team } = seed();
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');

    expect(revokeNode(db, team.id, 'node-remote')).toBe(true);
    expect(authenticateNode(db, team.id, 'msnode_aaa')).toBeNull();
    // Idempotent, but honest: the second call did not revoke anything, and says so.
    expect(revokeNode(db, team.id, 'node-remote')).toBe(false);
    expect(revokeNode(db, team.id, 'no-such-node')).toBe(false);
    db.close();
  });

  it('revocation keeps the history that node attested', () => {
    const { db, team, ada } = seed();
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');
    // A message stamped to that origin — the shape a synced event will have in 3b.
    insertMessage(
      db,
      team.id,
      ada.id,
      null,
      makeEnvelope({
        id: 'm-1',
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' as const },
        act: 'message',
        body: 'said under that credential',
        ts: 1000,
        meta: null,
      }),
    );
    db.prepare("UPDATE messages SET origin_node = 'node-remote' WHERE id = 'm-1'").run();

    revokeNode(db, team.id, 'node-remote');

    // The log is append-only and those events are attested history: revoking a credential is not
    // retro-repudiating what was said under it (ADR 328 §5).
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE origin_node = ?').get('node-remote'),
    ).toEqual({ n: 1 });
    // And the row itself stays, so the origin remains resolvable.
    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE id = ?').get('node-remote')).toEqual({
      n: 1,
    });
    db.close();
  });

  it('authenticates only a bound, unrevoked credential of the right team', () => {
    const db = openDb(':memory:');
    const one = createTeam(db, { slug: 'one' });
    const two = createTeam(db, { slug: 'two' });
    bindNode(db, one.id, 'node-a', 'laptop', 'msnode_aaa', 'nick');

    expect(authenticateNode(db, one.id, 'msnode_aaa')?.label).toBe('laptop');
    // A node speaks only for the team it was admitted to — ADR 325's one team, one authority.
    expect(authenticateNode(db, two.id, 'msnode_aaa')).toBeNull();
    expect(authenticateNode(db, one.id, 'msnode_wrong')).toBeNull();
    expect(authenticateNode(db, one.id, '')).toBeNull();
    db.close();
  });

  it('never returns a credential or a hash in a listing', () => {
    const { db, team, ada } = seed();
    // The daemon's own row is unenrolled; the remote one is bound.
    insertMessage(
      db,
      team.id,
      ada.id,
      null,
      makeEnvelope({
        id: 'm-1',
        team: 'revive',
        from: 'ada',
        to: { kind: 'team' as const },
        act: 'message',
        body: 'hi',
        ts: 1000,
        meta: null,
      }),
    );
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_secret-value', 'nick');

    const listed = listNodes(db, team.id);
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain('msnode_secret-value');
    expect(JSON.stringify(listed)).not.toContain('credential_hash');

    const remote = listed.find((n) => n.id === 'node-remote')!;
    expect(remote.credential_prefix).toBe('msnode_');
    expect(remote.enrolled_at).not.toBeNull();

    // The unenrolled local row reads as unenrolled rather than as missing — "enrolled" is a state
    // to check, not something the row's existence guarantees (ADR 331 §Consequences).
    const local = listed.find((n) => n.id !== 'node-remote')!;
    expect(local.credential_prefix).toBeNull();
    expect(local.enrolled_at).toBeNull();
    db.close();
  });
});
