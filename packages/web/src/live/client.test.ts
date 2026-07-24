import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditFetchError, LiveFetchError, acquireObserver, isStaleCredential } from './client';

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

/**
 * `acquireObserver` is the ONLY way the broadcast route (ADR 157) resolves a credential — it has no
 * advanced-seat branch at all. That matters beyond tidiness: connecting as a real seat would attach a
 * *human* presence row and put a phantom person on the roster for as long as the stream runs (ADR 155).
 * So: it reads the observer key and nothing else, whatever else the browser has stored.
 */
describe('acquireObserver (the observer-only path broadcast mode relies on)', () => {
  const store = (entries: Record<string, string>) => {
    const map = new Map(Object.entries(entries));
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    });
    return map;
  };

  afterEach(() => vi.unstubAllGlobals());

  it('returns the cached observer seat without provisioning anything', async () => {
    store({
      'musterd.live.observer.v2.revive': JSON.stringify({ name: 'web-a1b2c3', token: 'mscr_obs' }),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(acquireObserver('revive')).resolves.toEqual({
      team: 'revive',
      as: 'web-a1b2c3',
      token: 'mscr_obs',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores every other stored credential — a seat key or a watch-link seat is never picked up', async () => {
    store({
      'musterd.live.observer.v2.revive': JSON.stringify({ name: 'web-a1b2c3', token: 'mscr_obs' }),
      // a real agent key + a shared watch-link seat, both sitting in the same localStorage
      'musterd.agent.key': 'mskey_seat_credential',
      'musterd.live.watchlink.v1.revive': JSON.stringify({ name: 'watch-zz', token: 'mscr_pub' }),
    });
    const cfg = await acquireObserver('revive');
    expect(cfg.as).toBe('web-a1b2c3');
    expect(cfg.token).toBe('mscr_obs');
  });

  it('is scoped per team — another team’s cached observer is not reused', async () => {
    store({
      'musterd.live.observer.v2.other': JSON.stringify({ name: 'web-other', token: 'mscr_other' }),
    });
    // no cached observer for `revive` → it must provision one rather than borrow the other team's
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ human_credential: 'mscr_fresh' }),
      })),
    );
    const cfg = await acquireObserver('revive');
    expect(cfg.team).toBe('revive');
    expect(cfg.token).toBe('mscr_fresh');
    expect(cfg.as).not.toBe('web-other');
  });
});
