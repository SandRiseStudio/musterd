import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { seedDawn } from '../db/seed.js';
import { consumeGrant, issueGrant, listGrants, revokeGrant, validateGrant } from './grants.js';

function setup() {
  const db = openDb(':memory:');
  const { teamId } = seedDawn(db);
  return { db, teamId };
}

describe('grants store (ADR 076)', () => {
  it('mints an msgr_ token, stores only its hash, and validates by token', () => {
    const { db, teamId } = setup();
    const { grant, token } = issueGrant(
      db,
      teamId,
      { scope: 'seat', target: 'Ada', lifetime: 'standing' },
      'nick',
    );
    expect(token).toMatch(/^msgr_/);
    // the plaintext is never stored — only the hash
    const stored = db
      .prepare<[string], { token_hash: string }>('SELECT token_hash FROM grants WHERE id = ?')
      .get(grant.id);
    expect(stored?.token_hash).toBeTruthy();
    expect(stored?.token_hash).not.toBe(token);
    const v = validateGrant(db, teamId, token);
    expect(v.ok).toBe(true);
  });

  it('a once grant is single_use and refuses after consumption', () => {
    const { db, teamId } = setup();
    const { grant, token } = issueGrant(
      db,
      teamId,
      { scope: 'seat', target: 'Ada', lifetime: 'once' },
      null,
    );
    expect(grant.single_use).toBe(true);
    expect(validateGrant(db, teamId, token).ok).toBe(true);
    consumeGrant(db, grant.id);
    const after = validateGrant(db, teamId, token);
    expect(after).toEqual({ ok: false, reason: 'revoked' });
  });

  it('a ttl grant refuses once expired', () => {
    const { db, teamId } = setup();
    const { token } = issueGrant(
      db,
      teamId,
      { scope: 'role', target: 'backend', lifetime: 'ttl', ttl_hours: -1 }, // already past
      null,
    );
    expect(validateGrant(db, teamId, token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('revoke invalidates a standing grant; an unknown token is not_found', () => {
    const { db, teamId } = setup();
    const { grant, token } = issueGrant(
      db,
      teamId,
      { scope: 'seat', target: 'Ada', lifetime: 'standing' },
      'nick',
    );
    expect(revokeGrant(db, teamId, grant.id)).toBe(true);
    expect(revokeGrant(db, teamId, grant.id)).toBe(false); // already revoked
    expect(validateGrant(db, teamId, token)).toEqual({ ok: false, reason: 'revoked' });
    expect(validateGrant(db, teamId, 'msgr_nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('lists a team grants newest-first (public shape, no hash)', () => {
    const { db, teamId } = setup();
    issueGrant(db, teamId, { scope: 'seat', target: 'Ada', lifetime: 'standing' }, 'nick');
    issueGrant(db, teamId, { scope: 'seat', target: 'Lin', lifetime: 'once' }, 'nick');
    const grants = listGrants(db, teamId);
    expect(grants).toHaveLength(2);
    expect(grants[0]).not.toHaveProperty('token_hash'); // public shape, no secret
    expect(grants.map((g) => g.target).sort()).toEqual(['Ada', 'Lin']);
  });
});
