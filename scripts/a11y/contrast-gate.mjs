#!/usr/bin/env node
/**
 * The contrast GATE — `contrast-sweep.mjs` run over the built client, on every route that renders
 * something, as a CI check rather than a habit.
 *
 * Usage:
 *   node scripts/a11y/contrast-gate.mjs [--dir <built client>] [--port <n>] [--routes a,b,c]
 *
 * Exit code is 1 if any route reports a live failure. It serves `packages/web/dist/client` itself
 * (static, no deps, no daemon), so it needs `pnpm build` first and nothing else.
 *
 * ── Why a separate runner ───────────────────────────────────────────────────────────────────────
 *
 * `pnpm lint` already gates the STRUCTURAL half of web a11y — jsx-a11y as errors, since #493. That
 * block's own comment names what it cannot see, and puts colour contrast first. `a11y:contrast`
 * has existed to answer that since #723, but only when someone remembered to run it, against a URL
 * they picked by hand. On 2026-08-12 the cost of "remembered" showed up: `.gg-shelf__label` had
 * been shipping at 4.05 on the shelf paper, and was caught only because a seat measured while
 * building something else nearby. Eight more failures were sitting on the approval card at the same
 * moment, all of them the same mistake — a FILL token used as text, the exact swap
 * `packages/web/AGENTS.md` warns about, with the `-ink` variant already defined one line away.
 *
 * Nine failures is not a lapse in care; it is what an unautomated check measures over time.
 *
 * ── What this can and cannot see, stated so a green run is not over-read ────────────────────────
 *
 * Each route is swept as it PRERENDERS. That is total coverage for the preview routes, which mount
 * real components against synthetic fixtures on purpose. It is thin for `/board` and `/live`: those
 * need a daemon, so a static server gets their pre-connect state and one measurable element. The
 * grid, the shelf, the cards and the office chrome are invisible here — the very surfaces the 4.05
 * was on. Closing THAT is a fixture route, and it is the next increment, not this one.
 *
 * The sweep's own limits still apply and still print every run: gradient-backed text is reported
 * SKIPPED rather than passed, and hover/error/empty states are not rendered at all.
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
const PORT = Number(arg('port', '4331'));

/**
 * Every route the client prerenders. The preview routes carry the weight — they mount real
 * components against fixtures, so their sweep is representative. The rest are listed anyway: a
 * pre-connect state is still a state a stranger sees, and `/` is the marketing page nobody
 * re-measures.
 */
const ROUTES = arg('routes', '')
  ? arg('routes', '').split(',')
  : [
      '/',
      '/asks-preview',
      '/approval-preview',
      '/office-preview',
      '/character-sheet',
      '/board',
      '/live',
      '/approvals',
      '/audit',
      '/broadcast',
    ];

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
  console.error(`contrast-gate — ${DIR} does not exist. Run \`pnpm build\` first.`);
  process.exit(1);
}

/* Preflight the browser by name. Without this a missing Chrome surfaces ten seconds later as
   "DevTools endpoint never came up", which reads like a flake and sends the next person debugging
   the sweep rather than installing a browser. CI sets CHROME_BIN; locally the mac path is the
   default, and the Linux names are here so a contributor on Linux gets a pass, not a puzzle. */
const CHROME =
  process.env['CHROME_BIN'] ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((p) => existsSync(p));
if (!CHROME || !existsSync(CHROME)) {
  console.error(
    'contrast-gate — no Chrome found. Contrast must be MEASURED in a real engine (the whole point:' +
      ' alpha tints and color-mix() cannot be computed from the hex), so there is no headless-free' +
      ' fallback here. Set CHROME_BIN to a Chrome/Chromium binary.',
  );
  process.exit(1);
}

/** Static server over the built client. `/route` resolves to the prerendered `/route/index.html`. */
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

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const sweep = (url) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'contrast-sweep.mjs'), url], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, CHROME_BIN: CHROME },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

console.log(`contrast-gate — ${ROUTES.length} routes over ${DIR}\n`);
const failed = [];
for (const route of ROUTES) {
  const { code, out } = await sweep(`http://127.0.0.1:${PORT}${route}`);
  const live = /live: (\d+) measured, (\d+) below AA/.exec(out);
  const skipped = /SKIPPED (\d+) —/.exec(out);
  const tail = skipped ? `, ${skipped[1]} unmeasurable` : '';
  if (code === 0) {
    console.log(`  ✓ ${route} — ${live?.[1] ?? '?'} measured${tail}`);
    continue;
  }
  failed.push(route);
  console.log(`  ✗ ${route} — ${live?.[2] ?? '?'} below AA${tail}`);
  // The failing rows themselves, indented under their route — the ink/paper pair IS the fix.
  for (const line of out.split('\n')) {
    if (/^\s+\d+(\.\d+)? \(need /.test(line)) console.log(`   ${line.trim()}`);
  }
}

server.close();

if (failed.length) {
  console.log(
    `\ncontrast-gate FAILED on ${failed.length} route(s): ${failed.join(', ')}` +
      '\nEach row is `ratio (need N) ink on paper`. Almost always the fix is the -ink variant of the' +
      ' token already in use (--lc-success → --lc-success-ink); packages/web/AGENTS.md has the split.' +
      '\nRe-measure one page with: pnpm a11y:contrast <url>',
  );
  process.exit(1);
}
console.log(`\ncontrast-gate — ${ROUTES.length} routes, 0 below AA`);
