import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollMs, shouldReload, stampReload, startBuildSync } from './buildSync';

/** The stale-page convergence rule: a page running build A while the daemon serves build B reloads
 * itself once onto B. Everything here is the safety envelope around that one reload — no loops, no
 * reload without evidence, no work while unseen. */
describe('shouldReload', () => {
  it('reloads when the served build differs from the running one', () => {
    expect(shouldReload('aaa', 'bbb', null)).toBe(true);
  });

  it('holds when the builds match', () => {
    expect(shouldReload('aaa', 'aaa', null)).toBe(false);
  });

  it('holds when either side is unknown (dev page, or no build.json on the host)', () => {
    expect(shouldReload(null, 'bbb', null)).toBe(false);
    expect(shouldReload('aaa', null, null)).toBe(false);
  });

  it('never reloads twice for the same served build — one attempt per build, loop-proof', () => {
    expect(shouldReload('aaa', 'bbb', 'bbb')).toBe(false);
    expect(shouldReload('aaa', 'ccc', 'bbb')).toBe(true); // a NEWER build gets its own attempt
  });
});

describe('pollMs', () => {
  it('defaults to five minutes', () => {
    expect(pollMs('')).toBe(5 * 60_000);
    expect(pollMs('?foo=1')).toBe(5 * 60_000);
  });

  it('honors the ?build-sync=<ms> dev override, floored at 1s', () => {
    expect(pollMs('?build-sync=2000')).toBe(2000);
    expect(pollMs('?build-sync=1')).toBe(1000); // a sub-second poll is never a sane ask
    expect(pollMs('?build-sync=abc')).toBe(5 * 60_000);
  });
});

describe('startBuildSync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function deps(overrides: Partial<Parameters<typeof startBuildSync>[0]> = {}) {
    let reloadedFor: string | null = null;
    const d = {
      pageBuild: 'aaa' as string | null,
      fetchServed: vi.fn(() => Promise.resolve<string | null>('aaa')),
      getReloadedFor: () => reloadedFor,
      setReloadedFor: (id: string) => {
        reloadedFor = id;
      },
      reload: vi.fn(),
      isVisible: () => true,
      intervalMs: 1000,
      ...overrides,
    };
    return d;
  }

  it('reloads once when a poll sees a newer served build, and records the attempt', async () => {
    const d = deps({ fetchServed: vi.fn(() => Promise.resolve('bbb')) });
    const stop = startBuildSync(d);
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.reload).toHaveBeenCalledTimes(1);
    // The same served build never triggers again (the reload evidently didn't take — do not loop).
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does nothing while the builds agree', async () => {
    const d = deps();
    const stop = startBuildSync(d);
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.reload).not.toHaveBeenCalled();
    stop();
  });

  it('does not even poll without a page build (dev) — the loop never starts', async () => {
    const d = deps({ pageBuild: null });
    const stop = startBuildSync(d);
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.fetchServed).not.toHaveBeenCalled();
    stop();
  });

  it('skips polls while the page is hidden (idle cost is paid by every viewer)', async () => {
    let visible = false;
    const d = deps({ isVisible: () => visible, fetchServed: vi.fn(() => Promise.resolve('bbb')) });
    const stop = startBuildSync(d);
    await vi.advanceTimersByTimeAsync(3000);
    expect(d.fetchServed).not.toHaveBeenCalled();
    visible = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a fetch failure is a no-op, not an error', async () => {
    const d = deps({ fetchServed: vi.fn(() => Promise.reject(new Error('offline'))) });
    const stop = startBuildSync(d);
    await vi.advanceTimersByTimeAsync(2000);
    expect(d.reload).not.toHaveBeenCalled();
    stop();
  });

  it('stop() ends the polling', async () => {
    const d = deps({ fetchServed: vi.fn(() => Promise.resolve('aaa')) });
    const stop = startBuildSync(d);
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.fetchServed).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.fetchServed).toHaveBeenCalledTimes(1);
  });
});

/**
 * The reload path writes TWO markers, and the beat only exists because they are written together.
 * If a future edit drops one, the corner goes silent on a real deploy (missing beat marker) or the
 * page loops (missing guard) — neither shows up in `shouldReload`, so it is pinned here.
 */
describe('stampReload', () => {
  it('writes the durable loop guard and the single-use ship marker in one act', () => {
    const written: Record<string, string> = {};
    stampReload({ setItem: (k, v) => (written[k] = v) }, 'bbb');
    expect(written).toEqual({
      'musterd-build-sync-reloaded-for': 'bbb',
      'musterd-build-sync-shipped': 'bbb',
    });
  });
});

/**
 * The whole path over a real (fake-backed) sessionStorage, module evaluation included — the pure
 * pieces above cannot see the one decision that makes the beat navigation-scoped rather than
 * call-scoped, because that decision happens as the module loads. Each `resetModules` + import here
 * IS a page load, so this reads as the sequence a viewer produces: build-sync reload, then ⌘R.
 */
describe('justShipped over the module lifecycle', () => {
  const BUILD = 'build-2';

  function fakeSession() {
    const slots = new Map<string, string>();
    return {
      getItem: (k: string) => slots.get(k) ?? null,
      setItem: (k: string, v: string) => void slots.set(k, v),
      removeItem: (k: string) => void slots.delete(k),
      size: () => slots.size,
    };
  }

  const session = fakeSession();

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('__WEB_BUILD__', BUILD);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** One page load: evaluate the module fresh and ask it. The reset is what makes each call a
   * separate load — within one load the answer is memoised, which is the point. */
  const load = async () => {
    vi.resetModules();
    return (await import('./buildSync')).justShipped();
  };

  it('claims the beat on the load a build-sync reload produced, and never after', async () => {
    stampReload(session, BUILD); // what the loop writes immediately before reloading
    expect(await load()).toBe(true); // the reload lands: a build DID just ship
    expect(await load()).toBe(false); // an ordinary ⌘R in the same tab: no blink to name
    expect(await load()).toBe(false);
  });

  it('leaves the loop guard alone — spending the beat must not re-arm the reload', async () => {
    stampReload(session, BUILD);
    await load();
    expect(session.getItem('musterd-build-sync-reloaded-for')).toBe(BUILD);
    expect(session.getItem('musterd-build-sync-shipped')).toBe(null);
  });

  it('is silent on a pageview no build landed into', async () => {
    expect(await load()).toBe(false);
  });
});
