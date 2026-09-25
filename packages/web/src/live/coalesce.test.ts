import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coalesce } from './coalesce';

/** The roster refetch rule: a presence frame refreshes the roster promptly, but a burst of them —
 * a room joining at once — costs one or two fetches, not one per frame per viewer. */
describe('coalesce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const deferred = () => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => (resolve = r));
    return { p, resolve };
  };

  it('runs the first trigger at once', () => {
    const run = vi.fn(() => Promise.resolve());
    coalesce(run, 1000).trigger();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('folds a burst during a run into ONE trailing run, after the gap', async () => {
    const d = deferred();
    const run = vi.fn(() => d.p);
    const c = coalesce(run, 1000);
    for (let i = 0; i < 50; i++) c.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    d.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not run a trailing fetch when nothing arrived after the first', async () => {
    const run = vi.fn(() => Promise.resolve());
    coalesce(run, 1000).trigger();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs at once again once the gap has passed quietly', async () => {
    const run = vi.fn(() => Promise.resolve());
    const c = coalesce(run, 1000);
    c.trigger();
    await vi.advanceTimersByTimeAsync(1500);
    c.trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a failed run', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('bounce')).mockResolvedValue(undefined);
    const c = coalesce(run, 1000);
    c.trigger();
    c.trigger();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stops scheduling after cancel', async () => {
    const d = deferred();
    const run = vi.fn(() => d.p);
    const c = coalesce(run, 1000);
    c.trigger();
    c.trigger();
    c.cancel();
    d.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
