/**
 * Which of the routes a gate is about to sweep are actually IN the built client.
 *
 * ── Why a gate needs this ───────────────────────────────────────────────────────────────────────
 *
 * Both a11y gates serve `packages/web/dist/client` themselves and point a browser at each route.
 * A route the build did not emit is served as a 404 by that server — and a 404 page has text on it
 * and a link on it, so the sweeps measure it and report a tick.
 *
 * Demonstrated 2026-09-21 (lane 01M32QTVN): `contrast-gate.mjs --static-only --routes /roadmap`
 * printed `✓ /roadmap — 1 measured` for a route that had not existed since 2026-07-28. It had been
 * in the gate's ROUTES list for months, quietly measuring a 404 and passing. The same run found
 * five routes missing from a `pnpm -r build` that exited 0, so this is not only about stale list
 * entries: any build that drops a page turns every route it dropped into a silent ✓.
 *
 * The build now refuses to drop a route (`packages/web/scripts/check-prerendered-routes.ts`). This
 * is the second line, on the gates' own side: they run against whatever dist they are handed —
 * including a stale one on a laptop, which is how this was found in the first place — so "the
 * build would have caught it" is not a guarantee available here.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Where a prerendered route lands under the client dist. `/` is `index.html`; the rest nest. */
export const distFileFor = (route) => {
  const path = route.replace(/^\//, '');
  return path === '' ? 'index.html' : `${path}/index.html`;
};

/** The subset of `routes` with no HTML in `dir`. Empty means every route is really there. */
export const missingFromDist = (dir, routes) =>
  routes.filter((r) => {
    const f = join(dir, distFileFor(r));
    return !(existsSync(f) && statSync(f).isFile());
  });

/**
 * The refusal text, or '' when nothing is missing — so a caller can print it unconditionally.
 *
 * Deliberately says the gate took NO verdict. An instrument that dresses its own blind spot as a
 * result about the subject is the failure mode both these gates are organised against.
 */
export const missingRoutesNotice = (dir, routes, gate) => {
  const missing = missingFromDist(dir, routes);
  if (!missing.length) return '';
  return (
    `${gate} — ${missing.length} route(s) are NOT in the build and were not swept: ` +
    `${missing.join(', ')}.\n` +
    '  Nothing was measured on them, and no verdict was taken. This refusal exists because the\n' +
    '  alternative is worse than useless: the gate serves this dist itself, so a missing route is\n' +
    '  a 404 page — which has text and a link on it, gets measured, and reports a ✓.\n' +
    `  Either the build dropped them (run \`pnpm --filter @musterd/web build\` and read its\n` +
    '  prerender lines), or this gate is still listing a route that no longer exists.'
  );
};
