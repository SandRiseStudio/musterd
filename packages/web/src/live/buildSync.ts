/**
 * Stale-page convergence: a long-lived page reloads itself once onto the build the daemon serves.
 *
 * The /live publisher swaps the web-root atomically under a RUNNING daemon (no restart, no WS drop),
 * so an open page — the broadcast machine's Chrome above all — has no signal that its bundle is old.
 * `officeRoom` keeps /live and /broadcast agreeing *within* one build; nothing kept an open page on
 * the *current* build, and the Twitch stream faithfully broadcast a days-old office (2026-08-19).
 *
 * Mechanism (the classic version.json pattern, chosen over pushing a build id down the WS: the WS is
 * the team-data channel and never drops on an asset swap, while HTTP already serves the answer): the
 * build bakes one id into the bundle (`__WEB_BUILD__`) and writes the same id to `build.json` beside
 * `index.html`. Visible pages poll it slowly; a mismatch reloads once. After the reload the two ids
 * are equal by construction (one build produced both), and the `reloadedFor` memory makes even a
 * misbehaving host (a cache serving the old bundle against a new build.json) a no-op, never a loop.
 * Dev pages and hosts without a build.json have no id on one side or the other and stay inert.
 */

/** How often a visible page asks what build is being served. The publisher polls main every 60s, so
 * five minutes bounds convergence at ~6 minutes end-to-end while costing a ~50-byte fetch. */
const POLL_MS = 5 * 60_000;

/** The poll cadence, honoring the `?build-sync=<ms>` dev override (floored at 1s — the same
 * explicitly-present-only contract as `?light=HH`; harmless in prod). */
export function pollMs(search: string): number {
  const raw = new URLSearchParams(search).get('build-sync');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(1000, n) : POLL_MS;
}

const RELOADED_KEY = 'musterd-build-sync-reloaded-for';

/** The one rule: reload iff both ids are known, they differ, and this served build was never tried. */
export function shouldReload(
  page: string | null,
  served: string | null,
  reloadedFor: string | null,
): boolean {
  return page !== null && served !== null && served !== page && reloadedFor !== served;
}

export interface BuildSyncDeps {
  /** The build id baked into THIS bundle, or null when there isn't one (dev, tests). */
  pageBuild: string | null;
  /** Ask the origin which build it currently serves; null for "no answer" (404, bad JSON). */
  fetchServed: () => Promise<string | null>;
  getReloadedFor: () => string | null;
  setReloadedFor: (id: string) => void;
  reload: () => void;
  /** Hidden pages skip polls entirely — idle cost is paid by every viewer, forever. */
  isVisible: () => boolean;
  intervalMs?: number;
}

/** Start the convergence loop; returns a stop function. Inert (no timer at all) without a page build. */
export function startBuildSync(deps: BuildSyncDeps): () => void {
  const { pageBuild } = deps;
  if (pageBuild === null) return () => {};
  let inFlight = false;
  const tick = () => {
    if (!deps.isVisible() || inFlight) return;
    inFlight = true;
    deps
      .fetchServed()
      .then((served) => {
        if (shouldReload(pageBuild, served, deps.getReloadedFor())) {
          deps.setReloadedFor(served as string);
          deps.reload();
        }
      })
      .catch(() => {}) // an unreachable origin is the WS layer's story, not this one's
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, deps.intervalMs ?? POLL_MS);
  return () => clearInterval(timer);
}

/**
 * Did THIS page load happen because a build landed? — the honest signal behind the "just shipped"
 * beat in the broadcast corner.
 *
 * `setReloadedFor` stamps the served id immediately before the reload, and after that reload the
 * page's own baked id IS that served id (one build produced both — the invariant `shouldReload`
 * already rests on). So the two being equal means exactly one thing: the bundle running right now
 * arrived by build-sync, moments ago. Any other pageview has either no stamp at all or a stamp from
 * an older served id, and reads false.
 *
 * Pure, and takes both halves, so the corner's test can state the four cases without a DOM.
 */
export function reloadedForBuild(pageBuild: string | null, reloadedFor: string | null): boolean {
  return pageBuild !== null && reloadedFor !== null && reloadedFor === pageBuild;
}

/** `reloadedForBuild` against the real page. False everywhere there is no baked build id (dev,
 * tests), which is also where there is no publisher to have shipped anything. */
export function justShipped(): boolean {
  try {
    return reloadedForBuild(bundleBuild(), sessionStorage.getItem(RELOADED_KEY));
  } catch {
    return false; // private mode: no memory, so no claim
  }
}

/** The id Vite baked into this bundle at build time; absent in dev and under tests. */
function bundleBuild(): string | null {
  return typeof __WEB_BUILD__ === 'string' ? __WEB_BUILD__ : null;
}

let domStarted = false;

/** Wire the loop to the real page. Idempotent — the first live surface to mount wins, and a page
 * without a baked build id (dev) never starts anything. */
export function ensureBuildSync(): void {
  if (domStarted) return;
  domStarted = true;
  startBuildSync({
    pageBuild: bundleBuild(),
    fetchServed: () =>
      fetch('/build.json', { cache: 'no-store', signal: AbortSignal.timeout(2500) })
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { build?: string } | null) => (typeof b?.build === 'string' ? b.build : null)),
    getReloadedFor: () => {
      try {
        return sessionStorage.getItem(RELOADED_KEY);
      } catch {
        return null;
      }
    },
    setReloadedFor: (id) => {
      try {
        sessionStorage.setItem(RELOADED_KEY, id);
      } catch {
        /* a page that can't remember still only reloads once per served id per pageview */
      }
    },
    reload: () => window.location.reload(),
    isVisible: () => document.visibilityState === 'visible',
    intervalMs: pollMs(window.location.search),
  });
}
