import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { seedDawn } from '../db/seed.js';
import {
  consumeGrant,
  issueGrant,
  listGrants,
  refreshGrant,
  revokeGrant,
  validateGrant,
} from './grants.js';

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

  // ADR 087: a resume token is a ttl grant refreshed on each occupy so an active seat never expires.
  it('refreshGrant bumps a ttl grant expires_at forward', () => {
    const { db, teamId } = setup();
    const { grant } = issueGrant(
      db,
      teamId,
      { scope: 'seat', target: 'Ada', lifetime: 'ttl', ttl_hours: 1 },
      'nick',
    );
    const before = grant.expires_at!;
    expect(before).toBeGreaterThan(Date.now());
    refreshGrant(db, grant.id, 24 * 3_600_000); // 24h window
    const after = db
      .prepare<[string], { expires_at: number }>('SELECT expires_at FROM grants WHERE id = ?')
      .get(grant.id);
    expect(after!.expires_at).toBeGreaterThan(before);
  });

  it('refreshGrant is a no-op for a single_use (once) grant and a revoked grant', () => {
    const { db, teamId } = setup();
    const once = issueGrant(db, teamId, { scope: 'seat', target: 'Ada', lifetime: 'once' }, 'nick');
    // once grants have no expires_at; refresh must not create one (they aren't resume tokens)
    refreshGrant(db, once.grant.id, 24 * 3_600_000);
    const onceRow = db
      .prepare<
        [string],
        { expires_at: number | null }
      >('SELECT expires_at FROM grants WHERE id = ?')
      .get(once.grant.id);
    expect(onceRow!.expires_at).toBeNull();

    const ttl = issueGrant(
      db,
      teamId,
      { scope: 'seat', target: 'Lin', lifetime: 'ttl', ttl_hours: 1 },
      'nick',
    );
    revokeGrant(db, teamId, ttl.grant.id);
    const before = ttl.grant.expires_at!;
    refreshGrant(db, ttl.grant.id, 999 * 3_600_000);
    const revoked = db
      .prepare<[string], { expires_at: number }>('SELECT expires_at FROM grants WHERE id = ?')
      .get(ttl.grant.id);
    expect(revoked!.expires_at).toBe(before); // untouched — a revoked grant can't be resurrected
  });
});
