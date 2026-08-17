#!/usr/bin/env node
/**
 * The birth-hole falsifier — run the contrast sweep against fixtures that force the freeze's two
 * known race arms, and assert the sweep excludes rather than mismeasures them.
 *
 * Usage:
 *   node scripts/a11y/birth-falsifier.mjs [--runs N]
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 *
 * The #832 fix shipped with a claim ("6 of 6 green") and no committed instrument, so the seat asked
 * to exercise it had no way to run the test that would have decided it, and correctly declined to
 * chase the instrument instead. That is the failure this file closes: a claim about a race needs a
 * runnable falsifier, not a run count.
 *
 * ── The two arms, and what each proves ──────────────────────────────────────────────────────────
 *
 * The sweep freezes the scene by replacing `requestAnimationFrame` with a no-op, in one synchronous
 * evaluation shaped like:
 *
 *     window.__a11y_atFreeze = new WeakSet();                        // (1)
 *     for (const el of document.querySelectorAll('*')) …add(el);     // (2) the mark walk
 *     window.requestAnimationFrame = () => 0;                        // (3) the freeze
 *
 * A bubble whose position comes from an rAF tick that never runs is stranded at (0,0), on top of
 * whatever dark paint sits in the corner — and measured there, at a ratio that belongs to the
 * freeze rather than to the page.
 *
 * `birth-after-freeze.html` is born after (3): UNMARKED, so the sweep reports it `born` and excludes
 * it. This is the arm the #832 fix closes, and it is DETERMINISTIC — it must be excluded every run.
 *
 * `birth-before-freeze.html` is born between (1) and (2): MARKED like any pre-existing node, so the
 * `born` predicate cannot see it. Its outcome is legitimately non-deterministic — the frame queued
 * before the freeze may or may not be serviced in time — so it lands in one of two SAFE states:
 * placed correctly (indistinguishable from a healthy row), or caught by the `moved` guard. What it
 * must never do is get measured while stranded. That is the assertion.
 *
 * ── The third arm: characterised 2026-08-17, and it FAILS ON PURPOSE ────────────────────────────
 *
 * `request-after-freeze.html` is wanderer's path, and it reproduces 3 runs of 3 with the same
 * signature they reported: `1.8 (need 4.5)  #2b1f13 on #3a4d4d`, plus the composited-vs-sampled
 * DISAGREEMENT line that is the tell of a row measured somewhere its own CSS says it is not.
 *
 * BIRTH TIME WAS THE WRONG PREDICATE. Both arms above turn on when the element was created; this one
 * is created at parse time — marked beyond any doubt — and still strands. What decides strandedness
 * is whether the placement REQUEST preceded the freeze:
 *
 *   - present at the mark walk  → `born` is false, so that guard cannot see it;
 *   - its `requestAnimationFrame` call lands AFTER the no-op → nothing is ever queued, so unlike the
 *     before-freeze arm there is no already-queued callback to save it;
 *   - never placed, therefore never moves → the rect pass and the shutter agree, so `moved` is false
 *     as well.
 *
 * Marked, stationary, and measured at (0,0) over whatever dark paint is in the corner. Both guards
 * are blind to it by construction, which is why no amount of re-running the other two arms was ever
 * going to find it.
 *
 * Why the real scene does it intermittently: any scene that creates an element and places it on a
 * LATER turn — after a font load, a measurement, a microtask, an observer — has a window between
 * creation and request. The freeze is one synchronous evaluation dropped in at an arbitrary moment.
 * Inside that window the request never happens; outside it everything is placed or safely queued.
 *
 * CLOSED 2026-08-17, and this arm now decides the exit code like the other two. The sweep no longer
 * kills the scheduler: it services rAF callbacks with a PINNED timestamp, so the placement still
 * happens and the clock still does not advance. The freeze always wanted motion to stop rather than
 * layout work to stop; the no-op conflated the two, and this arm is what that conflation cost.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const SWEEP = join(HERE, 'contrast-sweep.mjs');

const argv = process.argv.slice(2);
const runs = Number(argv[argv.indexOf('--runs') + 1]) || 3;

function serve() {
  const server = createServer((req, res) => {
    const name = (req.url ?? '/').split('?')[0].replace(/^\//, '');
    const file = join(FIXTURES, name);
    if (!file.startsWith(FIXTURES) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html' : 'text/plain' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function sweep(url) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SWEEP, url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('close', (code) => resolve({ out, code }));
  });
}

/** `live: N measured, M below AA` — M is the only number that can be a false failure. */
function belowAA(out) {
  const m = /live: \d+ measured, (\d+) below AA/.exec(out);
  return m ? Number(m[1]) : null;
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
let failed = 0;

console.log(`birth-falsifier — ${runs} run(s) per arm against ${base}\n`);

for (let i = 1; i <= runs; i++) {
  const { out } = await sweep(`${base}/birth-after-freeze.html`);
  const fails = belowAA(out);
  const excluded = /BORN after the scene froze/.test(out);
  // Deterministic arm: the post-freeze birth is unmarked every time, so it must be excluded every
  // time. A run that neither excludes it nor fails is the fix silently not firing.
  const ok = fails === 0 && excluded;
  if (!ok) failed++;
  console.log(
    `  ${ok ? '✓' : '✗'} after-freeze  run ${i}: ${fails} below AA, ${excluded ? 'excluded as born' : 'NOT excluded'}`,
  );
}

for (let i = 1; i <= runs; i++) {
  const { out } = await sweep(`${base}/birth-before-freeze.html`);
  const fails = belowAA(out);
  const moved = /MOVED between the rect pass/.test(out);
  // Non-deterministic arm, two safe landings: placed in time (no exclusion needed) or caught by the
  // `moved` guard. Only a measured failure is a regression — never assert WHICH safe state it took,
  // or this becomes a flaky gate that cries wolf on a healthy sweep.
  const ok = fails === 0;
  if (!ok) failed++;
  console.log(
    `  ${ok ? '✓' : '✗'} before-freeze run ${i}: ${fails} below AA${moved ? ', excluded as moved' : ', placed in time'}`,
  );
}

/* The third arm — wanderer's path, and the one both guards were blind to. Deterministic in BOTH
   directions: it failed 3 of 3 against the no-op freeze and passes against the serviced one, so a
   regression here is a real regression and not weather. */
for (let i = 1; i <= runs; i++) {
  const { out } = await sweep(`${base}/request-after-freeze.html`);
  const fails = belowAA(out);
  const ok = fails === 0;
  if (!ok) failed++;
  console.log(
    `  ${ok ? '✓' : '✗'} request-after-freeze run ${i}: ${fails} below AA` +
      `${ok ? ' — placed by the serviced callback' : ' — MARKED, never placed, never moved: the hole is back'}`,
  );
}

server.close();

if (failed) {
  console.log(`\nbirth-falsifier FAILED — ${failed} run(s) mismeasured a stranded row.`);
  process.exit(1);
}
console.log(
  '\nbirth-falsifier — all three arms safe.' +
    '\nThe third arm was the open hole until 2026-08-17: a row present at the mark walk whose' +
    '\nplacement is REQUESTED after the freeze is invisible to both guards — `born` keys on birth' +
    '\ntime, `moved` needs motion, and that row has neither. The freeze now services callbacks with a' +
    '\npinned timestamp instead of dropping them, so the placement happens and the clock does not.' +
    '\nWhat is still NOT modelled here: an rAF loop that advances by frame COUNT rather than by' +
    '\nelapsed time can still move under a pinned clock. The budget bounds it and `moved` catches it.',
);
