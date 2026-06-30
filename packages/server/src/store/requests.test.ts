import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { seedDawn } from '../db/seed.js';
import { createRequest, decideRequest, expireRequests, listRequests } from './requests.js';

function setup() {
  const db = openDb(':memory:');
  const { teamId } = seedDawn(db);
  return { db, teamId };
}

describe('requests store (ADR 076)', () => {
  it('creates a pending request with surface + a computed expires_at', () => {
    const { db, teamId } = setup();
    const r = createRequest(db, teamId, {
      kind: 'claim',
      from_session: 's1',
      target: 'seat:Ada',
      surface: 'claude-code',
    });
    expect(r.status).toBe('pending');
    expect(r.kind).toBe('claim');
    expect(r.target).toBe('seat:Ada');
    expect(r.surface).toBe('claude-code');
    expect(r.expires_at).toBeGreaterThan(r.ts); // expires_at = ts + 1h
    // surface defaults to 'cli' when unspecified
    const d = createRequest(db, teamId, { kind: 'teammate', from_session: 's2', target: null });
    expect(d.surface).toBe('cli');
  });

  it('dedups by (team, from_session, target) while open — incl. null target', () => {
    const { db, teamId } = setup();
    const a = createRequest(db, teamId, { kind: 'claim', from_session: 's1', target: 'Ada' });
    const b = createRequest(db, teamId, { kind: 'claim', from_session: 's1', target: 'Ada' });
    expect(b.id).toBe(a.id); // same open request, not a duplicate
    const t1 = createRequest(db, teamId, { kind: 'teammate', from_session: 's2', target: null });
    const t2 = createRequest(db, teamId, { kind: 'teammate', from_session: 's2', target: null });
    expect(t2.id).toBe(t1.id); // null target dedups too
    // a different session is a distinct request
    const other = createRequest(db, teamId, { kind: 'claim', from_session: 's3', target: 'Ada' });
    expect(other.id).not.toBe(a.id);
  });

  it('decide settles a pending request once; a re-decide is a no-op (null)', () => {
    const { db, teamId } = setup();
    const r = createRequest(db, teamId, { kind: 'claim', from_session: 's1', target: 'Ada' });
    const approved = decideRequest(db, teamId, r.id, 'approved', 'nick');
    expect(approved?.status).toBe('approved');
    expect(approved?.decided_by).toBe('nick');
    // already settled → null
    expect(decideRequest(db, teamId, r.id, 'denied', 'nick')).toBeNull();
    // a settled request no longer dedups — a re-claim opens a fresh one
    const fresh = createRequest(db, teamId, { kind: 'claim', from_session: 's1', target: 'Ada' });
    expect(fresh.id).not.toBe(r.id);
  });

  it('expireRequests reaps pending requests past the ttl', () => {
    const { db, teamId } = setup();
    const r = createRequest(db, teamId, { kind: 'claim', from_session: 's1', target: 'Ada' });
    // nothing expired yet (expires_at = created_at + 1h, in the future)
    expect(expireRequests(db, Date.now())).toBe(0);
    // jump now forward past the stored expires_at
    const future = Date.now() + 2 * 60 * 60 * 1000;
    expect(expireRequests(db, future)).toBe(1);
    const after = listRequests(db, teamId).find((x) => x.id === r.id);
    expect(after?.status).toBe('expired');
  });

  it('listRequests pendingOnly filters settled/expired', () => {
    const { db, teamId } = setup();
    const a = createRequest(db, teamId, { kind: 'claim', from_session: 's1', target: 'Ada' });
    createRequest(db, teamId, { kind: 'claim', from_session: 's2', target: 'Lin' });
    decideRequest(db, teamId, a.id, 'denied', 'nick');
    expect(listRequests(db, teamId)).toHaveLength(2);
    expect(listRequests(db, teamId, { pendingOnly: true })).toHaveLength(1);
  });
});
