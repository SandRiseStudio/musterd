import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollMs, shouldReload, startBuildSync } from './buildSync';

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
