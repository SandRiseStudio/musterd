import { describe, expect, it } from 'vitest';
import { SESSION_DIGEST_LEN, sessionDigest } from './digest.js';

describe('sessionDigest (ADR 131 Consequences, follow-up note 2026-08-05 — correlation without disclosure)', () => {
  const key = 'agent-key-abc';

  it('is stable for one session id, so a captured/ended pair can be joined', () => {
    expect(sessionDigest(key, 'sid-1')).toBe(sessionDigest(key, 'sid-1'));
  });

  it('separates two sessions of the same seat — the distinction the lane could not make', () => {
    expect(sessionDigest(key, 'sid-1')).not.toBe(sessionDigest(key, 'sid-2'));
  });

  it('never contains the session id, and is short enough to read in a ledger', () => {
    const d = sessionDigest(key, 'sid-1');
    expect(d).toHaveLength(SESSION_DIGEST_LEN);
    expect(d).toMatch(/^[0-9a-f]+$/);
    expect(d).not.toContain('sid-1');
  });

  it('is KEYED, not a bare hash: the daemon cannot confirm a guessed id without the local key', () => {
    // The one property a plain sha256 would not have. Session ids are high-entropy today, but the
    // contract must not depend on that staying true for every future harness.
    expect(sessionDigest('key-a', 'sid-1')).not.toBe(sessionDigest('key-b', 'sid-1'));
  });
});
