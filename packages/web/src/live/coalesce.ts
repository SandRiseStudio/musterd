/**
 * Collapse a burst of triggers into at most one run in flight plus one trailing run.
 *
 * `/live` refetched the whole roster on EVERY presence frame. Each viewer receives every frame, so
 * the cost was viewers × events: at 50 phones watching 50 seats join, 4166 roster fetches in two
 * minutes, and the roster route's p95 went to 7.9 s (docs/perf/daemon-load-baseline.md,
 * 2026-09-25). The first trigger still runs at once — a single join shows up as fast as before —
 * and everything arriving while it runs, or within `gapMs` of its start, folds into one run after.
 * A failed run is the caller's to report (it catches its own errors); here it only ends the run.
 */
export function coalesce(
  run: () => Promise<unknown>,
  gapMs: number,
): { trigger: () => void; cancel: () => void } {
  let inFlight = false;
  let pending = false;
  let cancelled = false;
  let lastStart = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const start = () => {
    timer = undefined;
    if (cancelled) return;
    pending = false;
    inFlight = true;
    lastStart = Date.now();
    run()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (pending) schedule();
      });
  };

  const schedule = () => {
    if (cancelled || timer !== undefined) return;
    timer = setTimeout(start, Math.max(0, lastStart + gapMs - Date.now()));
  };

  return {
    trigger: () => {
      if (cancelled) return;
      if (inFlight || timer !== undefined || Date.now() - lastStart < gapMs) {
        pending = true;
        if (!inFlight) schedule();
        return;
      }
      start();
    },
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
