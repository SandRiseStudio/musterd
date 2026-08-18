#!/usr/bin/env node
/**
 * The contrast GATE — `contrast-sweep.mjs` run over the built client, on every route that renders
 * something, as a CI check rather than a habit.
 *
 * Usage:
 *   node scripts/a11y/contrast-gate.mjs [--dir <built client>] [--port <n>] [--routes a,b,c]
 *
 * Exit code is 1 if any route reports a live failure. Two phases, both self-contained — it needs
 * `pnpm build` first and nothing else:
 *
 *   1. every prerendered route, off a static server it runs itself;
 *   2. `/board` and `/live` CONNECTED, against a throwaway daemon over a synthetic team
 *      (`fixture-team.sh`). `--static-only` skips this phase and says so.
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
 * Phase 1 sweeps each route as it PRERENDERS — total coverage for the preview routes, which mount
 * real components against synthetic fixtures on purpose, and thin for `/board` and `/live`, which
 * need a daemon and so render only their sign-in screen there. That gap was not academic: the grid,
 * the shelf, the cards and the office chrome all live past it, and the 4.05 was on one of them.
 * Phase 2 exists because of it, and the first time it ran it found eleven more.
 *
 * What is still invisible, and worth saying so a green run is not over-read:
 *   • gradient-backed text, which this method cannot measure — reported SKIPPED every run, never
 *     silently passed, and counted per route in this runner's summary line;
 *   • hover, error and empty states, which are not rendered at all;
 *   • anything the fixture team does not produce. It seeds goals and lanes in every state the board
 *     can paint, but a surface nobody seeds is a surface nobody measures.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_BLOCKER_GATES, sharedBlockerNotice } from '../lib/shared-blocker-notice.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const DIR = arg('dir', join(HERE, '../../packages/web/dist/client'));
// Port 0 = "any free port", assigned by the OS at listen time. The gate serves a throwaway static
// snapshot to a headless browser on loopback; nothing outside this process ever needs to predict
// the number, so there is no reason to fight over a fixed one. An EXPLICIT --port keeps
// first-come-first-served semantics: the caller asked for that port specifically, and silently
// substituting another would make "--port 4331" mean "4331, probably".
const EXPLICIT_PORT = arg('port', '');
const PORT = EXPLICIT_PORT ? Number(EXPLICIT_PORT) : 0;

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

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
}).catch((e) => {
  // A raw EADDRINUSE stack reads like a broken gate. With port 0 it cannot happen; it is reachable
  // only when the caller pinned a port, so the message can say so plainly. The refusal used to be
  // the DEFAULT path — every concurrent or Ctrl-C-orphaned run exited 1 in the same shape as a real
  // contrast red, and seats debugged phantom failures. Measured 2026-08-17, twice in one session.
  console.error(
    e.code === 'EADDRINUSE'
      ? `contrast-gate — port ${PORT} is busy (a previous run?). Drop --port to auto-pick a free one.`
      : `contrast-gate — could not serve ${DIR}: ${e.message}`,
  );
  process.exit(1);
});
// The port actually bound — with `--port` it is that port, otherwise whatever the OS assigned.
const BOUND = server.address().port;

/**
 * A currently-free port, for the one consumer that cannot take "port 0" itself: the fixture daemon
 * is spawned by a shell script that passes an explicit `--port` through. Bind-then-release has a
 * TOCTOU window, but the loser of that race fails loudly at daemon start — the exact failure this
 * change demotes from "every concurrent run" to "a genuine collision".
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
/**
 * @param floor minimum text nodes this route must have measured for the pass to mean anything.
 *   A connected route that measures ZERO is not clean, it is a page that never finished connecting
 *   — and it passes, silently, exactly like a page with nothing wrong. Seen once during
 *   development, which is once more than a gate premised on "under-reporting is worse than none"
 *   can afford. Prerendered routes legitimately measure zero (a page can be all gradient), so the
 *   floor is opt-in per route rather than global.
 */
const report = ({ code, out }, label, floor = 0) => {
  const live = /live: (\d+) measured, (\d+) below AA/.exec(out);
  const skipped = /SKIPPED (\d+) —/.exec(out);
  const tail = skipped ? `, ${skipped[1]} unmeasurable` : '';
  /* The sweep settles on its own key set before measuring; a route that never settled was measured
     mid-flight, and its count and its verdict are both a frame. Carried up here because the gate's
     one-line-per-route summary is what people actually read. */
  const unsettled = /never stopped changing within/.test(out) ? ', MEASURED MID-FLIGHT' : '';
  if (code === 0 && floor > 0 && Number(live?.[1] ?? 0) < floor) {
    failed.push(label);
    console.log(
      `  ✗ ${label} — only ${live?.[1] ?? 0} text nodes measured, expected ≥${floor}.` +
        ' The page almost certainly never connected; a clean sweep of nothing is not a pass.',
    );
    return;
  }
  if (code === 0) {
    console.log(`  ✓ ${label} — ${live?.[1] ?? '?'} measured${tail}${unsettled}`);
    return;
  }
  failed.push(label);
  console.log(`  ✗ ${label} — ${live?.[2] ?? '?'} below AA${tail}${unsettled}`);
  /* The failing rows themselves, indented under their route — the ink/paper pair IS the fix.
     ONLY the failure block: the sweep prints EXEMPT rows (WCAG 1.4.3 logotype carve-out) in the
     identical `ratio (need N) ink on paper` shape further down, and the old grep-the-whole-output
     hoovered those up too. An exempt row listed under a ✗ route reads as a third failure — it cost
     izzo an hour of chasing `lc-office__mark-lockup` on 2026-08-13, a row that never set the exit
     code. Failure rows start directly under the `live:` line; the block ends at the first line
     that is not a row. */
  const lines = out.split('\n');
  const start = lines.findIndex((l) => /^live: \d+ measured/.test(l));
  for (let i = start + 1; i > 0 && i < lines.length; i++) {
    if (!/^\s+\d+(\.\d+)? \(need /.test(lines[i])) break;
    console.log(`   ${lines[i].trim()}`);
  }
};

/**
 * Routes that mount the office scene get their lighting PINNED, and get measured at two of them.
 *
 * The scene's lighting follows the real PST sun (`pstNowHours` in office-scene/index.ts), so an
 * unpinned sweep's verdict is a function of when it runs: at 272d4ad3 the /office-preview caption
 * measured 5.86:1 in daylight and 2.85:1 under the night veil — same bytes, wall clock the only
 * variable. That is exactly how main went green at 17:33–18:14 PDT and red at 21:12 PDT on the
 * same commit (runs 31759967399 / 31760236892), and why re-running a green run after dusk flipped
 * it. A verdict that changes with the clock cannot gate merges: a fix validated at noon is
 * validated by nothing.
 *
 * `?light=HH` is the scene's own override (a dev aid it already ships). Day and night bracket the
 * lighting range — dawn/dusk sit between them — so a green here means "readable at both ends",
 * reproducible at any hour, on any machine. Full hour sweep measured 2026-08-14: caption 5.86 at
 * 9–18, 5.1 at 6, 2.85 at 20–24. (lane 01KZZ7RYW6K9)
 */
const SCENE_LIGHTS = ['12', '21'];
const sceneRoutes = new Set(['/office-preview']);
/*
 * `&still` pins the CHOREOGRAPHY the way `?light=` pins the clock, and for the same reason one layer
 * up: a verdict that changes with what the room happened to be doing cannot gate merges.
 *
 * Pinning the sun fixed the lighting variable and left the motion one. The scene's script loops
 * every cycle, bubbles are born on timers and walks reposition them, so the sweep — which freezes
 * rAF, shoots one screenshot and pairs each row with the pixel beneath it — was racing the room.
 * Six exclusion guards went into contrast-sweep.mjs one incident at a time (moved, born, unsettled,
 * invisible, clipped, covered) and this route still flipped red about 1 run in 3, always an
 * `lc-speech__text` row over whatever scene paint sat under a bubble at shutter time.
 *
 * `?still` plays the same script ONCE at mount with no loop behind it: the room fills, animates to
 * its end state, and stops. The subject is kept and the motion is removed — deliberately NOT
 * `?quiet`, which skips the choreography and would leave the speech rows unmeasured, and those rows
 * are where the real failures on this route have been found.
 */
const SCENE_STILL = '&still';

for (const route of ROUTES) {
  if (sceneRoutes.has(route)) {
    for (const light of SCENE_LIGHTS) {
      report(
        await sweep(`http://127.0.0.1:${BOUND}${route}?light=${light}${SCENE_STILL}`),
        `${route} (light=${light})`,
      );
    }
  } else {
    report(await sweep(`http://127.0.0.1:${BOUND}${route}`), route);
  }
}

server.close();

/* ── phase 2: the CONNECTED board ──────────────────────────────────────────────────────────────
 *
 * A static server only reaches `/board` and `/live` before they connect — one measurable element
 * each, and none of the text the product is actually made of. So the gate stands up a throwaway
 * daemon over a synthetic team and sweeps the real thing. Worth the ~15s: pointed at a connected
 * board for the first time, this found eleven AA failures the static phase could not see.
 *
 * `--static-only` skips it (no CLI build, or you only want the fast pass). It is a narrowing of
 * coverage, so it says so rather than passing quietly. */
if (!process.argv.includes('--static-only')) {
  // The fixture script is already isolation-capable — A11Y_FIXTURE_{ROOT,PORT,TEAM} exist exactly
  // so two stacks cannot collide — but this gate never used them, so two concurrent runs raced to
  // the same daemon port, DB, and team ("paper" already exists), and the loser exited 1 in the
  // same shape as a contrast red. Same defect as the static phase's fixed port, one layer down.
  // Derive per-run values unless the caller pinned their own; the same env goes to `up` and
  // `down`, so teardown tears down THIS run's stack and nobody else's.
  const fixtureEnv = {
    ...process.env,
    A11Y_FIXTURE_ROOT:
      process.env['A11Y_FIXTURE_ROOT'] ??
      join(process.env['TMPDIR'] ?? '/tmp', `musterd-a11y-${process.pid}`),
    A11Y_FIXTURE_PORT: process.env['A11Y_FIXTURE_PORT'] ?? String(await freePort()),
    A11Y_FIXTURE_TEAM: process.env['A11Y_FIXTURE_TEAM'] ?? `paper-${process.pid}`,
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

  console.log('\n  … standing up a fixture team for the connected board');
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
      '\ncontrast-gate FAILED — the fixture daemon did not come up, so the connected board went' +
        ' unmeasured. That is a gate failure, not a skip: passing here would report coverage the' +
        ' run did not have. Needs `pnpm build` (CLI + web). `--static-only` skips this phase.' +
        // A harness that will not start is the archetypal red no one's diff can touch — the most
        // shared failure this gate has, so it gets the notice too.
        sharedBlockerNotice(SHARED_BLOCKER_GATES.a11yContrast),
    );
    process.exit(1);
  }
  const base = /(http:\/\/127\.0\.0\.1:\d+)\/board/.exec(up.out)?.[1];
  const team = /team=([\w-]+)/.exec(up.out)?.[1] ?? 'paper';
  try {
    // 12 is comfortably under what a connected page renders (25 apiece today) and comfortably
    // over the 1 a sign-in screen renders, so it separates "connected" from "never got there".
    report(await sweep(`${base}/board?team=${team}`), '/board (connected)', 12);
    // Connected /live mounts the office scene, so its lighting is pinned like the preview's —
    // same clock-dependence, same two-ended bracket. See SCENE_LIGHTS above.
    for (const light of SCENE_LIGHTS) {
      report(
        await sweep(`${base}/live?team=${team}&light=${light}`),
        `/live (connected, light=${light})`,
        12,
      );
    }
  } finally {
    await sh(['down']);
  }
} else {
  console.log('\n  ! --static-only: /board and /live went unmeasured past their connect screen');
}

if (failed.length) {
  console.log(
    `\ncontrast-gate FAILED on ${failed.length} route(s): ${failed.join(', ')}` +
      '\nRoutes marked `!` did not measure at all — fix the harness there before reading anything' +
      ' into the rest.' +
      '\nEach row is `ratio (need N) ink on paper`. Almost always the fix is the -ink variant of the' +
      ' token already in use (--lc-success → --lc-success-ink); packages/web/AGENTS.md has the split.' +
      '\nRe-measure one page with: pnpm a11y:contrast <url>' +
      sharedBlockerNotice(SHARED_BLOCKER_GATES.a11yContrast),
  );
  process.exit(1);
}
console.log(`\ncontrast-gate — ${ROUTES.length} routes, 0 below AA`);
