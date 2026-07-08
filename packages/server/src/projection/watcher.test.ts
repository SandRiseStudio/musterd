import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRosterWatcher } from './watcher.js';

/**
 * The watcher is `fs.watch` + a debounced trigger. `fs.watch` is intentionally best-effort across
 * platforms, so the assertions wait on the debounced `onChange` firing (with a real-timer wait
 * bounded by the debounce), rather than on any single filesystem event.
 */
describe('startRosterWatcher', () => {
  let dir: string;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-watch-'));
    mkdirSync(join(dir, '.musterd', 'seats'), { recursive: true });
    writeFileSync(join(dir, '.musterd', 'team.toml'), 'slug = "alpha"\n');
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires a debounced onChange when the roster tree changes', async () => {
    let changes = 0;
    stop = startRosterWatcher([dir], 20, () => {
      changes += 1;
    });

    // `fs.watch` is best-effort and can drop events under load, so keep touching the tree until the
    // debounced reconcile is observed (the assertion is that a change *does* fire, not how many).
    let n = 0;
    await vi.waitFor(
      () => {
        writeFileSync(join(dir, '.musterd', 'team.toml'), `slug = "alpha"\n# ${n++}\n`);
        expect(changes).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 60 },
    );
    expect(changes).toBeGreaterThan(0);
  });

  it('swallows an onChange that throws (a failed reconcile never crashes the watcher)', async () => {
    let calls = 0;
    stop = startRosterWatcher([dir], 20, () => {
      calls += 1;
      throw new Error('reconcile boom');
    });

    let n = 0;
    await vi.waitFor(
      () => {
        writeFileSync(join(dir, '.musterd', 'team.toml'), `slug = "beta"\n# ${n++}\n`);
        expect(calls).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 60 },
    );
    // No throw escaped — reaching here without an unhandled rejection is the assertion.
    expect(calls).toBeGreaterThan(0);
  });

  it('tolerates an unwatchable root without throwing', () => {
    const missing = join(dir, 'does-not-exist');
    expect(() => {
      stop = startRosterWatcher([missing], 20, () => {});
    }).not.toThrow();
  });

  it('stop() closes the watchers and cancels a pending debounce', async () => {
    let changes = 0;
    const s = startRosterWatcher([dir], 50, () => {
      changes += 1;
    });
    writeFileSync(join(dir, '.musterd', 'seats', 'x.toml'), 'kind = "agent"\n');
    s(); // stop before the debounce elapses
    await new Promise((r) => setTimeout(r, 120));
    expect(changes).toBe(0);
  });
});
