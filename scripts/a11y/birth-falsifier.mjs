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
 * ── What this does NOT yet cover, and it matters ────────────────────────────────────────────────
 *
 * On 2026-08-14 wanderer measured a REAL failure on /office-preview at light=12 —
 * `lc-speech__text` at 1.8 (need 4.5), ink #2b1f13 on paper #3a4d4d, reported below AA rather than
 * excluded, with two immediate retries green. Neither fixture here reproduces that: across repeated
 * runs both arms stay safe. So a third path into the stranded state exists and is not yet
 * characterised, and this falsifier passing does NOT mean the birth hole is closed. It means the two
 * arms it does model have not regressed.
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

server.close();

if (failed) {
  console.log(`\nbirth-falsifier FAILED — ${failed} run(s) mismeasured a stranded row.`);
  process.exit(1);
}
console.log(
  '\nbirth-falsifier — both modelled arms safe.' +
    '\nNOTE: this does NOT prove the birth hole closed. wanderer measured a real stranded failure on' +
    '\n/office-preview (lc-speech__text 1.8 on #3a4d4d, light=12) that neither fixture reproduces —' +
    '\na third path into the stranded state is still uncharacterised.',
);
