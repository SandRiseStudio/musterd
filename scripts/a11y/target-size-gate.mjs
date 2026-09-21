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
import { missingRoutesNotice } from './dist-routes.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const DIR = arg('dir', join(HERE, '../../packages/web/dist/client'));
const VIEWPORT = arg('viewport', '390x844');
/* Same two flags, same meaning, as contrast-gate: each is a NARROWING of one run's coverage and
   says so rather than passing quietly. `--static-only` is also "no CLI build". */
const STATIC_ONLY = process.argv.includes('--static-only');
const CONNECTED_ONLY = process.argv.includes('--connected-only');
if (STATIC_ONLY && CONNECTED_ONLY) {
  console.error('target-size-gate — --static-only and --connected-only together measure nothing.');
  process.exit(1);
}

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

/* Before a browser is started: a route that is not in this dist would be swept as a 404. This gate
   would refuse it anyway (a 404 renders one link, not zero, so it can slip past the zero-target
   check) — but it would refuse it as "DID NOT MEASURE" without saying the route is simply absent,
   which is the difference between a puzzle and a fix. See dist-routes.mjs. */
const absent = missingRoutesNotice(DIR, CONNECTED_ONLY ? [] : ROUTES, 'target-size-gate');
if (absent) {
  console.error(absent);
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

/**
 * A currently-free port, for the one consumer that cannot take "port 0" itself: the fixture daemon
 * is spawned by a shell script that passes an explicit `--port` through. Bind-then-release has a
 * TOCTOU window, but the loser of that race fails loudly at daemon start — the exact failure this
 * demotes from "every concurrent run" to "a genuine collision".
 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const sweep = (url) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'target-size-sweep.mjs'), url], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

console.log(
  CONNECTED_ONLY
    ? `target-size-gate — connected phase only, at ${VIEWPORT}\n`
    : `target-size-gate — ${ROUTES.length} routes at ${VIEWPORT} over ${DIR}\n`,
);

const failed = [];
const unmeasured = [];

/**
 * Report one sweep.
 *
 * @param floor the minimum number of targets this surface must have measured for its pass to mean
 *   anything. A CONNECTED page that measures a handful never finished connecting — and its
 *   sign-in screen renders 3 targets, which is not zero, so the sweep's own zero-target refusal
 *   cannot see it. It would pass, silently, exactly like a page with nothing wrong. Prerendered
 *   routes legitimately measure few, so the floor is opt-in per route rather than global — the
 *   same shape, and the same reason, as contrast-gate's text-node floor.
 */
let measured = 0;
const report = ({ code, out }, label, floor = 0) => {
  measured += 1;
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
    failed.push(label);
    unmeasured.push(label);
    console.log(`  ! ${label} — DID NOT MEASURE (harness failure, not a target-size result).`);
    return;
  }
  if (code === 0 && floor > 0 && Number(line?.[1] ?? 0) < floor) {
    failed.push(label);
    console.log(
      `  ✗ ${label} — only ${line?.[1] ?? 0} targets measured, expected ≥${floor}.` +
        ' The page almost certainly never connected; a clean sweep of a sign-in screen is not a pass.',
    );
    return;
  }
  if (code === 0) {
    console.log(`  ✓ ${label} — ${line?.[1] ?? '?'} targets${tail}`);
    return;
  }
  failed.push(label);
  console.log(
    `  ✗ ${label} — ${line?.[2] ?? '?'} below AA 2.5.8, ${line?.[3] ?? '?'} below the house floor, ` +
      `${line?.[4] ?? '?'} overlapping pair(s)${tail}`,
  );
  for (const l of out.split('\n')) if (/^\s+✗ /.test(l)) console.log(`   ${l.trim()}`);
};

for (const route of CONNECTED_ONLY ? [] : ROUTES) {
  report(await sweep(`http://127.0.0.1:${BOUND}${route}`), route);
}

server.close();
if (CONNECTED_ONLY) {
  console.log('  ! --connected-only: the prerendered routes went unmeasured in this run');
}

/* ── phase 2: the CONNECTED surfaces ───────────────────────────────────────────────────────────
 *
 * A static server reaches /board and /live only before they connect — THREE targets each, two
 * buttons and a link, and none of the controls the product is actually made of. So the gate stands
 * up a throwaway daemon over a synthetic team and measures the real thing.
 *
 * It earned its place on its first run. Measured 2026-09-21 at 390x844 (lane 01M32WGSG6), against
 * surfaces no geometry check had ever touched:
 *   • /live's whole topbar button row at 19x30 — `width: 30px` in the source, shrunk by a flex
 *     parent that ran out of room at phone width. A test reading CSS source sees a correct
 *     declaration; only a browser sees the 19.
 *   • /board's `.lc-insight__more` at 26x16 with another target 0.0px from its centre — undersized
 *     AND crowded, a genuine 2.5.8 failure that neither clause forgave.
 *   • /board's view switcher at 20px tall.
 * All three are fixed in the same change, because a gate cannot land red.
 *
 * `--static-only` skips this phase (no CLI build, or you want the fast pass) and says so rather
 * than passing quietly.
 *
 * WHAT IS STILL NOT MEASURED, stated rather than implied: `?asks-open` and `?plates-open` change
 * nothing at 390px — the sweep returns an identical 7 targets with and without them — so those
 * surfaces do not mount at phone width and are NOT covered here. The contrast gate sweeps them at
 * desktop width, where they do. A phone-width reader of this gate should not believe otherwise.
 */
if (!STATIC_ONLY) {
  /* Per-run fixture env, unless the caller pinned their own. Without this two concurrent runs race
     to the same daemon port, DB and team name, and the loser exits 1 in the same shape as a real
     red — the defect contrast-gate hit and fixed one layer down. The same env goes to `up` and
     `down`, so teardown tears down THIS run's stack and nobody else's. */
  const fixtureEnv = {
    ...process.env,
    A11Y_FIXTURE_ROOT:
      process.env['A11Y_FIXTURE_ROOT'] ??
      join(process.env['TMPDIR'] ?? '/tmp', `musterd-targets-${process.pid}`),
    A11Y_FIXTURE_PORT: process.env['A11Y_FIXTURE_PORT'] ?? String(await freePort()),
    A11Y_FIXTURE_TEAM: process.env['A11Y_FIXTURE_TEAM'] ?? `paper-t${process.pid}`,
  };
  const sh = (args) =>
    new Promise((resolve) => {
      const c = spawn('bash', [join(HERE, 'fixture-team.sh'), ...args], {
        stdio: 'pipe',
        env: fixtureEnv,
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('close', (code) => resolve({ code, out }));
    });

  console.log('\n  … standing up a fixture team for the connected surfaces');
  const up = await sh(['up']);
  if (up.code !== 0) {
    console.log(
      up.out
        .trim()
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
    console.log(
      '\ntarget-size-gate FAILED — the fixture daemon did not come up, so the connected surfaces' +
        ' went unmeasured. That is a gate failure, not a skip: passing here would report coverage' +
        ' the run did not have. Needs `pnpm build` (CLI + web). `--static-only` skips this phase.',
    );
    process.exit(1);
  }
  const base = /(http:\/\/127\.0\.0\.1:\d+)\/board/.exec(up.out)?.[1];
  const team = /team=([\w-]+)/.exec(up.out)?.[1] ?? 'paper';
  try {
    /* Floors, measured rather than guessed (2026-09-21): a connected /board renders 17 targets and
       a connected /live 7, against THREE apiece on their sign-in screens. 10 and 5 sit comfortably
       between, so they separate "connected" from "never got there" without being brittle as the
       fixture's content changes. */
    report(await sweep(`${base}/board?team=${team}`), '/board (connected)', 10);
    /* The scene is PINNED, for the same reason contrast-gate pins it: an unpinned verdict is a
       function of the wall clock and of what the room happened to be doing. Geometry is less
       light-sensitive than colour, but it is not motion-insensitive — a walker mid-stride moves a
       target's box, and a verdict that depends on which frame the sampler caught is a flake
       waiting to cost someone a merge. One light, not the bracket: `?light=` changes paint, not
       layout, so the second value would re-measure identical boxes. */
    report(await sweep(`${base}/live?team=${team}&light=12&still`), '/live (connected)', 5);
  } finally {
    await sh(['down']);
  }
} else {
  console.log('\n  ! --static-only: /board and /live went unmeasured past their sign-in screen');
}

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
/* The count is of SWEEPS taken, not of routes listed — a run narrowed by a flag must not report
   the coverage of a full one. */
console.log(
  `\ntarget-size-gate — ${measured} sweep(s) at ${VIEWPORT}, 0 below AA 2.5.8 and 0 below the` +
    ' house floor' +
    (STATIC_ONLY ? ' (prerendered phase only)' : CONNECTED_ONLY ? ' (connected phase only)' : '') +
    '.',
);
