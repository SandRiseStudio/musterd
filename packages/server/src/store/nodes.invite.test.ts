import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { consumeInvite, mintInvite, NODE_INVITE_TTL_MS } from './nodes.js';
import { createTeam } from './teams.js';

/**
 * Enrollment codes (ADR 328 §2) — trust-on-first-use, bounded by a short window, consumed under a
 * guarded CAS so two daemons racing one invite cannot both enroll.
 */

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  return { db, team };
}

describe('node invites (ADR 328 §2)', () => {
  it('is single-use — the second consumer is refused', () => {
    const { db, team } = seed();
    const { invite } = mintInvite(db, team.id, 'laptop', 'nick');

    expect(consumeInvite(db, team.id, invite, 'node-a')).not.toBeNull();
    expect(consumeInvite(db, team.id, invite, 'node-b')).toBeNull();

    // And the record says who won, so a second claim is answerable rather than merely denied.
    const row = db
      .prepare<[], { consumed_by: string | null }>('SELECT consumed_by FROM node_invites')
      .get();
    expect(row?.consumed_by).toBe('node-a');
    db.close();
  });

  it('refuses an expired code, and accepts the same code inside the window', () => {
    const { db, team } = seed();
    const t0 = 1_000_000;
    const { invite, expires_at } = mintInvite(db, team.id, 'laptop', 'nick', t0);
    expect(expires_at).toBe(t0 + NODE_INVITE_TTL_MS);

    expect(consumeInvite(db, team.id, invite, 'node-a', t0 + NODE_INVITE_TTL_MS + 1)).toBeNull();
    expect(consumeInvite(db, team.id, invite, 'node-a', t0 + 1)).not.toBeNull();
    db.close();
  });

  it('refuses an unknown code', () => {
    const { db, team } = seed();
    mintInvite(db, team.id, 'laptop', 'nick');
    expect(consumeInvite(db, team.id, 'msinv_not-a-real-code', 'node-a')).toBeNull();
    db.close();
  });

  it("refuses another team's code — an invite admits to the team that minted it", () => {
    const db = openDb(':memory:');
    const mine = createTeam(db, { slug: 'revive' });
    const other = createTeam(db, { slug: 'elsewhere' });
    const { invite } = mintInvite(db, mine.id, 'laptop', 'nick');

    expect(consumeInvite(db, other.id, invite, 'node-a')).toBeNull();
    expect(consumeInvite(db, mine.id, invite, 'node-a')).not.toBeNull();
    db.close();
  });

  it('stores only the hash — the plaintext never reaches the table', () => {
    const { db, team } = seed();
    const { invite } = mintInvite(db, team.id, 'laptop', 'nick');
    const rows = db.prepare('SELECT * FROM node_invites').all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain(invite);
    db.close();
  });

  it('mints a code in the msinv_ namespace, distinct every time', () => {
    const { db, team } = seed();
    const a = mintInvite(db, team.id, 'laptop', 'nick').invite;
    const b = mintInvite(db, team.id, 'laptop', 'nick').invite;
    expect(a).toMatch(/^msinv_/);
    expect(b).not.toBe(a);
    db.close();
  });
});
