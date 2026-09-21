#!/usr/bin/env node
/**
 * Fail the build when it dropped a route.
 *
 * Runs as the last step of `pnpm --filter @musterd/web build`, because the thing it guards against
 * is a build that EXITS 0 while `dist/client` is missing pages. The reasoning, the measurement and
 * why the route tree is the right source live in `prerendered-routes.ts`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredRoutes, hasBlogPosts, missingRoutes, outputFor } from './prerendered-routes.ts';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(pkgRoot, 'dist/client');

if (!existsSync(dist)) {
  console.error(`check-prerendered-routes — ${dist} does not exist. Did \`vite build\` run?`);
  process.exit(1);
}

/* /blog is a prerender root only while a post exists (vite.config.ts): with none, the section may
   legitimately 404 rather than serving an empty index the nav and sitemap have already stopped
   pointing at. `hasBlogPosts` applies the same rule `blogEntries()` does — the directory may be
   absent entirely, since git does not track an empty one. */
const optional = hasBlogPosts(join(pkgRoot, 'content', 'blog')) ? [] : ['/blog'];

const routes = declaredRoutes();
const missing = missingRoutes(dist, routes, optional);

if (missing.length) {
  console.error(
    `check-prerendered-routes — the build exited 0 having NOT emitted ${missing.length} of ` +
      `${routes.length} route(s):\n` +
      missing.map((r) => `  ✗ ${r} → dist/client/${outputFor(r)}`).join('\n') +
      '\n\nThis is the defect that makes it worth failing here rather than downstream. The' +
      ' prerender step reports `Encountered error, retrying: <route>`, retries three times, and' +
      ' then DROPS the page without failing the build — measured 2026-09-21, five routes at once' +
      ' on a loaded machine. Every gate reads dist/client, and a missing route is served as a 404' +
      ' by their own static servers; a 404 has text on it, so the contrast gate measures it and' +
      ' reports a tick. `deploy:site` would publish the hole, green all the way.' +
      '\n\nScroll up to the [prerender] lines for the routes that errored. A page that fails four' +
      ' times is a real bug: fix the route, or — if it is genuinely not a page any more — delete' +
      ' its route file rather than leaving the build to drop it quietly.',
  );
  process.exit(1);
}

/* Say which of the two things happened, rather than assuming. An optional route can be emitted
   anyway — /blog is, via crawlLinks from the nav — and printing "absent" over a route that is
   present is the kind of small lie that makes a reader distrust the whole line. */
const skipped = optional.filter((r) => !existsSync(join(dist, outputFor(r))));
console.log(
  `✓ prerendered routes — all ${routes.length - skipped.length} static route(s) emitted` +
    (skipped.length ? `; ${skipped.join(', ')} absent and allowed (no posts)` : ''),
);
