import { type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';

/**
 * Watch each roster root's `.musterd/` tree and fire a debounced reconcile on any change (ADR 058 /
 * projection-reconcile.md). We never interpret individual events — *any* event triggers a full
 * reconcile, because declarative reconcile is self-healing against `fs.watch`'s well-known
 * cross-platform unreliability (missed/duplicated events). Modeled on `presence/reaper.ts`: returns a
 * `stop` fn and `unref`s its timer so it never holds the process open.
 */
export function startRosterWatcher(
  roots: string[],
  debounceMs: number,
  onChange: () => void,
): () => void {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        onChange();
      } catch (e) {
        log.warn({ msg: 'roster_watch_reconcile_failed', err: (e as Error).message });
      }
    }, debounceMs);
    timer.unref?.();
  };

  for (const root of roots) {
    try {
      // `recursive` is supported on macOS + Windows; on platforms without it, watch still fires for
      // direct children of `.musterd/` (team.toml), and SIGHUP/`musterd reload` is the fallback.
      const w = watch(join(root, '.musterd'), { recursive: true }, () => trigger());
      w.on('error', (e) => log.warn({ msg: 'roster_watch_error', root, err: e.message }));
      watchers.push(w);
    } catch (e) {
      log.warn({ msg: 'roster_watch_unavailable', root, err: (e as Error).message });
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
