#!/usr/bin/env node
/**
 * The target-size falsifier — run the sweep against fixtures whose verdict is known in advance,
 * and assert it reaches each one.
 *
 * Usage:
 *   node scripts/a11y/target-size-falsifier.mjs
 *
 * ── Why a gate needs this and not just a green CI run ───────────────────────────────────────────
 *
 * `docs/a11y/contrast.md` set the precedent and the wiki's rule 3 states it: a check that passes
 * either way is a ritual. The target-size gate is green on today's `main` — that is either because
 * the site conforms or because the gate cannot see. Only a control that FAILS tells the two apart.
 *
 * The three failing arms are not three flavours of "too small". Each is a distinct way the gate can
 * be blind, and each has already happened to someone:
 *
 *   undersized-crowded   — 20px links packed tight, outside the chrome. The plain size clause.
 *   house-floor-nav      — a 22px nav that CONFORMS to 2.5.8 on spacing. It must fail the house
 *                          floor and must NOT be reported as a WCAG failure: blurring those two
 *                          makes a false accessibility claim in our own CI.
 *   overlapping-pair     — two 44x44 buttons on top of each other. A SIZE-ONLY gate passes this,
 *                          and the 01M32GF49Z fix produced exactly it by growing padding.
 *   inline-block-cta     — an undersized CTA in a section full of prose. The FIRST cut of this
 *                          gate's inline exception exempted it. This arm is aimed at the gate.
 *
 * And one passing arm, which is the one that keeps the gate installed:
 *
 *   conforming           — size, spacing and inline conformance in one page. A gate that reds
 *                          conforming markup gets switched off, so "it fails the bad ones" is only
 *                          half the claim being made here.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const SWEEP = join(HERE, 'target-size-sweep.mjs');

const serve = () => {
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
};

const sweep = (url) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [SWEEP, url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('close', (code) => resolve({ out, code }));
  });

/**
 * Each arm asserts the EXIT CODE and the REASON, never just the code.
 *
 * An arm that only checks "exit 1" passes when the gate fails the fixture for the wrong reason —
 * and "fails for the wrong reason" is how the overlap arm would quietly become a second size arm
 * the day someone shrinks those buttons.
 */
const ARMS = [
  {
    file: 'target-undersized-crowded.html',
    want: 1,
    expect: /under 24×24, and (its 24px circle reaches|another undersized)/,
    /* Not in a <nav>, so the house floor cannot decide it — see the fixture's own comment. */
    forbid: /HOUSE FLOOR/,
    why: 'a crowded 20px link must fail the SPEC clause, not the house floor',
  },
  {
    file: 'target-overlapping-pair.html',
    want: 1,
    expect: /OVERLAP/,
    why: 'two 44×44 buttons on top of each other must fail for OVERLAP, not for size',
  },
  {
    file: 'target-inline-block-cta.html',
    want: 1,
    /* The tell is the CLAUSE, not the exit code. A regressed exception would list these under
       "EXEMPT — inline in a sentence" and never look at their boxes, so this arm asserts both that
       a .cta was judged on its geometry and that NOTHING here claimed the sentence exemption. */
    expect: /a\.cta .* is under 24×24/,
    forbid: /EXEMPT — inline/,
    why: 'an inline-block CTA among prose must NOT claim the sentence exemption',
  },
  {
    file: 'target-house-floor-nav.html',
    want: 1,
    expect: /HOUSE FLOOR .* under the house 24px floor/,
    /* The whole point of this arm: markup that CONFORMS to 2.5.8 must never be reported as a
       standards violation. A gate that blurs the two is making a false accessibility claim in our
       own CI, about our own site. */
    /* A NON-ZERO count: the summary line always carries "0 below AA 2.5.8", so a bare \d+ here
       would forbid the healthy output and this arm would fail for being right. */
    forbid: /[1-9]\d* below AA 2\.5\.8/,
    why: 'a conforming 22px nav must fail the HOUSE floor and must NOT be called a WCAG failure',
  },
  {
    file: 'target-conforming.html',
    want: 0,
    expect: /inline in a sentence/,
    why: 'size, spacing and inline conformance must all pass, the inline one without a suppression',
  },
];

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`target-size-falsifier — ${ARMS.length} arms against ${base}\n`);

let failed = 0;
for (const arm of ARMS) {
  const { out, code } = await sweep(`${base}/${arm.file}`);
  const ok = code === arm.want && arm.expect.test(out) && !(arm.forbid?.test(out) ?? false);
  if (!ok) failed++;
  console.log(
    `  ${ok ? '✓' : '✗'} ${arm.file.replace(/^target-|\.html$/g, '')} — exit ${code} (want ${arm.want}), ${arm.why}`,
  );
  if (!ok)
    console.log(
      out
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n'),
    );
}

server.close();
console.log(
  failed
    ? `\ntarget-size-falsifier — ${failed} arm(s) did not behave as specified. The GATE is wrong, not the fixtures.`
    : '\ntarget-size-falsifier — all arms behaved as specified: the gate fails what it must and passes what it must.',
);
process.exit(failed ? 1 : 0);
