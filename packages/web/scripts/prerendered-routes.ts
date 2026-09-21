/**
 * Which static routes a build MUST emit, and which ones it actually did.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 *
 * A prerender error does not fail the build. Measured 2026-09-21 on `16b7d63d`: `pnpm -r build`
 * exited **0** with five routes absent from `dist/client` — `/approvals`, `/audit`, `/board`,
 * `/roadmap`, `/character-sheet` — and a clean serial build exited 0 with `/roadmap` absent. The
 * count tracks machine load; the swallowing is deterministic. `vite.config.ts` carried the opposite
 * claim in a comment ("a page that fails four times is a real bug and still fails the build") and
 * that claim was simply false.
 *
 * What makes it worth a checker rather than a config flag: **every gate downstream reads
 * `dist/client`**, and a missing route there is served as a 404 by the gates' own static servers.
 * A 404 page has text on it, so `contrast-gate.mjs` measures it and reports a tick — demonstrated
 * on the same day, `--routes /roadmap` printing `✓ /roadmap — 1 measured` for a route that had not
 * existed since 2026-07-28. `deploy:site` publishes whatever is in that directory. So a dropped
 * route is not merely missing: it is missing while everything that could have noticed says fine.
 *
 * ── Why it checks the ROUTE TREE rather than the prerender plugin's page list ────────────────────
 *
 * Only four paths are declared in `vite.config.ts`'s `pages`; the rest are found by `crawlLinks`,
 * and four of the five routes that went missing were crawl-discovered. Asking the plugin what it
 * meant to emit would therefore have missed most of them — and would tie the check to the plugin's
 * internals. The route files are the honest source: a `.tsx` in `src/routes` with no `$param` in
 * its name IS a static page of this site, and if the build did not emit it, the build is wrong.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * TanStack's flat-route filename → URL path.
 *
 * `index.tsx` → `/`, `docs.index.tsx` → `/docs`, `office-preview.tsx` → `/office-preview`. Dots are
 * path separators. Returns null for anything that is not a static page: the root layout, a
 * `$param` route (its concrete pages are crawl-discovered and named by data, not by file), and the
 * `.test.ts` files that live alongside routes and are not routes.
 */
export function routePathFor(file: string): string | null {
  if (!file.endsWith('.tsx')) return null;
  const stem = file.slice(0, -4);
  if (stem === '__root') return null;
  if (stem.includes('$')) return null;
  const segments = stem.split('.').filter((s) => s !== 'index');
  return `/${segments.join('/')}`;
}

/** Every static route this app declares, as URL paths, sorted. */
export function declaredRoutes(dir = join(pkgRoot, 'src/routes')): string[] {
  return readdirSync(dir)
    .map(routePathFor)
    .filter((p): p is string => p !== null)
    .sort();
}

/** Where a prerendered route lands in the client dist. `/` is `index.html`; the rest nest. */
export function outputFor(route: string): string {
  return route === '/' ? 'index.html' : `${route.replace(/^\//, '')}/index.html`;
}

/**
 * Does the blog have a post?
 *
 * Mirrors `blogEntries()` in `site-files.ts` — a `.md` in `content/blog`, and a MISSING directory
 * counts as empty, because git does not track an empty one so a fresh clone has no `content/blog`
 * at all. Re-stated here rather than imported: `site-files.ts` reaches into the docs manifest and
 * the brand module, which resolve under Vite and not under a bare `node` run, and this checker has
 * to run as the last line of the build script. The shared fact is one line and it is pinned by a
 * test on both sides rather than by an import.
 */
export function hasBlogPosts(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.md'));
}

/**
 * The routes a build was supposed to emit and did not.
 *
 * `optional` exists for one real case and is deliberately narrow: `/blog` is prerendered only while
 * a post exists (`vite.config.ts`), so with an empty `content/blog` the section legitimately 404s
 * rather than serving an empty index the nav and sitemap have already stopped pointing at. Passing
 * a route here means "absent is allowed" — never "absent is unnoticed", since the caller reports
 * what it skipped.
 */
export function missingRoutes(
  distDir: string,
  routes = declaredRoutes(),
  optional: readonly string[] = [],
): string[] {
  return routes.filter((r) => !optional.includes(r) && !existsSync(join(distDir, outputFor(r))));
}
