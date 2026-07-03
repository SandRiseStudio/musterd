import { describe, expect, it } from 'vitest';
import { AuditFetchError, LiveFetchError, isStaleCredential } from './client';

describe('isStaleCredential', () => {
  it('is true for a 401 LiveFetchError (the stale/invalid observer credential the daemon 401s)', () => {
    expect(isStaleCredential(new LiveFetchError('invalid human credential', 'unauthorized', 401))).toBe(
      true,
    );
  });

  it('is true for a 401 AuditFetchError (it IS a LiveFetchError subclass)', () => {
    expect(isStaleCredential(new AuditFetchError('no token', 'unauthorized', 401))).toBe(true);
  });

  it('is false for a 403 (forbidden — a real authz failure, not a stale credential to re-provision)', () => {
    expect(isStaleCredential(new LiveFetchError('forbidden', 'forbidden', 403))).toBe(false);
  });

  it('is false for a 500 or a plain Error (never auto-reprovision on a non-credential failure)', () => {
    expect(isStaleCredential(new LiveFetchError('boom', 'internal', 500))).toBe(false);
    expect(isStaleCredential(new Error('network down'))).toBe(false);
    expect(isStaleCredential('nope')).toBe(false);
    expect(isStaleCredential(null)).toBe(false);
  });
});
