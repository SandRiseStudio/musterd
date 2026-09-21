#!/usr/bin/env node
/**
 * The target-size GATE — `target-size-sweep.mjs` run at PHONE WIDTH over every prerendered route,
 * as a CI check rather than a habit.
 *
 * Usage:
 *   node scripts/a11y/target-size-gate.mjs [--dir <built client>] [--routes a,b,c] [--viewport 390x844]
 *
 * Exit 1 if any route reports a 2.5.8 failure or an overlapping pair. Needs `pnpm build` first and
 * nothing else — it serves the built client itself.
 *
 * ── Why this is a second gate and not a flag on the first ───────────────────────────────────────
 *
 * `contrast-gate.mjs` measures colour, at whatever width the browser happens to open. Target size
 * is a computed-LAYOUT property that only bites at phone width, so folding it in would mean running
 * every contrast sweep twice at two viewports to answer a question that needs one of them. The two
 * gates share the browser plumbing (`chrome.mjs`) and nothing else, which is the right amount.
 *
 * What made this necessary: the shared nav and footer shipped 21–22px-tall targets on EVERY route
 * while a 23-sweep a11y gate stayed green (2026-09-21, lane 01M32GF49Z). Nothing in the suite
 * measured layout at any viewport, so the failure was not missed — it was invisible.
 *
 * ── THE CONNECTED ROUTES ARE NOT MEASURED HERE, and that is a real gap ──────────────────────────
 *
 * `/board` and `/live` reach only their sign-in screen off a static server, exactly as they do in
 * the contrast gate's phase 1 — and the contrast gate grew a whole fixture-daemon phase because
 * that gap was where eleven failures were hiding. The same is almost certainly true of target size:
 * the goal grid, the asks sheet and the nameplates are where the small controls live.
 *
 * It is stated rather than quietly skipped, and the summary says so on every run. Wiring phase 2 is
 * its own increment: it needs the fixture team, and a gate that half-exists is better named than
 * half-claimed.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const DIR = arg('dir', join(HERE, '../../packages/web/dist/client'));
const VIEWPORT = arg('viewport', '390x844');

/**
 * The routes, and why this list is not the contrast gate's.
 *
 * Target size is a property of the CHROME plus whatever the page itself renders, and the chrome is
 * shared — so a handful of representative routes covers the nav and footer, and each extra route
 * earns its place by rendering a control the others do not. `/docs` carries the prose list links,
 * `/watch` carries the button row and the inline repo URL that is the exemption's worked example,
 * `/blog` carries the post index. The connect screens are listed because a sign-in button is a
 * target a stranger meets before anything else.
 */
const ROUTES = arg('routes', '')
  ? arg('routes', '').split(',')
  : ['/', '/watch', '/docs', '/docs/getting-started', '/blog', '/board', '/live'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

if (!existsSync(DIR)) {
  console.error(`target-size-gate — ${DIR} does not exist. Run \`pnpm build\` first.`);
  process.exit(1);
}

/** Static server over the built client. Port 0 — see `chrome.mjs` on why fixed ports collide. */
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  const candidates = [join(DIR, path), join(DIR, path, 'index.html'), join(DIR, `${path}.html`)];
  const file = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (!file) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BOUND = server.address().port;

const sweep = (url) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'target-size-sweep.mjs'), url], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

console.log(`target-size-gate — ${ROUTES.length} routes at ${VIEWPORT} over ${DIR}\n`);

const failed = [];
const unmeasured = [];
for (const route of ROUTES) {
  const { code, out } = await sweep(`http://127.0.0.1:${BOUND}${route}`);
  const line =
    /targets: (\d+) measured, (\d+) below AA 2\.5\.8, (\d+) below the house floor, (\d+) overlapping/.exec(
      out,
    );
  const exempt = /EXEMPT — inline in a sentence \((\d+)\)/.exec(out);
  const spacing = /PASSED ON SPACING — under \d+px but uncrowded \((\d+)\)/.exec(out);
  const tail =
    (exempt ? `, ${exempt[1]} inline-exempt` : '') + (spacing ? `, ${spacing[1]} on spacing` : '');
  /* Exit 2 is the harness saying it measured NOTHING — a 404, a stale dist, a page that never
     rendered. It still fails the run, and it says which kind of wrong it is, because an instrument
     that dresses its own failure as a verdict about the subject sends a careful reader to debug a
     defect on a route nobody looked at. Same contract, and same hard-won reason, as contrast-gate. */
  if (code === 2) {
    failed.push(route);
    unmeasured.push(route);
    console.log(`  ! ${route} — DID NOT MEASURE (harness failure, not a target-size result).`);
    continue;
  }
  if (code === 0) {
    console.log(`  ✓ ${route} — ${line?.[1] ?? '?'} targets${tail}`);
    continue;
  }
  failed.push(route);
  console.log(
    `  ✗ ${route} — ${line?.[2] ?? '?'} below AA 2.5.8, ${line?.[3] ?? '?'} below the house floor, ` +
      `${line?.[4] ?? '?'} overlapping pair(s)${tail}`,
  );
  for (const l of out.split('\n')) if (/^\s+✗ /.test(l)) console.log(`   ${l.trim()}`);
}

server.close();
console.log(
  '\n  ! /board and /live were measured at their SIGN-IN screen only — a connected phase, like the' +
    ' contrast gate has, is not wired yet.',
);

if (failed.length) {
  console.log(
    `\ntarget-size-gate FAILED on ${failed.length} route(s): ${failed.join(', ')}` +
      (unmeasured.length
        ? `\n\n  ${unmeasured.length} of those DID NOT MEASURE — ${unmeasured.join(', ')} — and are` +
          ' marked `!` above. Nothing there was looked at, so there is no target to fix on those' +
          ' routes; fix the harness (or re-run) first.'
        : '') +
      '\n\nWCAG 2.2 AA 2.5.8 wants 24×24 CSS px, OR enough space around an undersized target, OR' +
      ' the target to be inline in a sentence. Each row above says which clause it failed.' +
      '\nA HOUSE FLOOR row is NOT a WCAG failure: it conforms on spacing and is under the 24px the' +
      ' team set for the shared nav and footer (lane 01M32GF49Z). Do not report it outside this' +
      ' repo as an accessibility defect — fix it because a 21px link on a phone is missed twice' +
      ' before it is hit.' +
      '\nAn OVERLAP row is not a spacing nicety: neither target can be hit reliably.' +
      '\nThe rule, its exceptions and the worked examples: docs/a11y/target-size.md' +
      '\nRe-measure one page with: pnpm a11y:targets <url>' +
      '\nCheck the GATE itself rather than the page: node scripts/a11y/target-size-falsifier.mjs',
  );
  process.exit(1);
}
console.log(
  `\ntarget-size-gate — ${ROUTES.length} route(s) at ${VIEWPORT}, 0 below AA 2.5.8 and 0 below the` +
    ' house floor.',
);
