#!/usr/bin/env node
/**
 * WCAG contrast sweep for a rendered page (no deps — native fetch + WebSocket + headless Chrome).
 *
 * Measures every text node against the background that is ACTUALLY PAINTED behind it, and reports
 * anything under the WCAG 2.1 AA threshold for its size:
 *   4.5:1  body text
 *   3.0:1  large text (>=24px, or >=18.66px at weight >=700)
 *
 * Usage:
 *   node scripts/a11y/contrast-sweep.mjs [url] [--probe cls,cls,…] [--json out.json] [--quiet]
 *
 * Exit code is 1 when the LIVE sweep finds a failure, so this can become a gate. The --probe pass
 * never affects the exit code; see "Probing" below for why.
 *
 * ── Why this exists, and why the obvious implementation is worse than useless ────────────────────
 *
 * Contrast computed from the hex in the CSS is not contrast. Alpha tints, `color-mix()`, nested
 * translucent layers and gradients all change what lands on screen. So it has to be measured in the
 * page — and the two natural ways to do that are both quietly wrong:
 *
 *   1. PARSING `getComputedStyle`. It can hand back `color(srgb 0.91 0.84 0.69)`, whose components
 *      are 0-1 FLOATS. A `/[\d.]+/g` parser reads those as 0-255 and every element with a
 *      `color()`-form background measures as near-BLACK. The failure is silent and the numbers look
 *      plausible: it reported a real 1.48:1 badge as 1.2:1 (lane 01KZAA9Q6T), which is the right
 *      conclusion carried by a wrong measurement — the worst kind, because nothing looks broken.
 *
 *   2. WALKING ANCESTORS for a background colour. The moment an ancestor paints a gradient, the walk
 *      sails past it and finds whatever opaque thing is further up — on /live that is the letterbox
 *      black behind the office canvas, so anything over .lc-office reports a nonsense ratio.
 *
 * The primitive below avoids both. `resolve()` paints a colour to a 1x1 canvas over white AND over
 * black and solves for colour + alpha from the two composites. That is exact for any colour space,
 * any syntax and any alpha, and it does not care what form getComputedStyle chose. And `effBg()`
 * STOPS at a gradient and says so, rather than guessing.
 *
 * ── The reporting rules, which are the point ────────────────────────────────────────────────────
 *
 * An accessibility tool that under-reports is worse than none, because "0 failures" gets believed.
 * So:
 *   • Gradient-backed text is reported as SKIPPED, with a count and selectors. It is never dropped
 *     silently — a clean run with 17 unmeasurable elements is itself a finding, and the fix is to
 *     read that surface's own paper token rather than to pretend the sweep covered it.
 *   • A DOM sweep only sees what is RENDERED. Hover, error, empty and card/tier states are invisible
 *     to it, and that gap is stated in the output every run.
 *
 * ── Probing ─────────────────────────────────────────────────────────────────────────────────────
 *
 * `--probe` injects one <span> per class into a known-paper container and measures those, which is
 * how the unrendered states get covered (41 badge/stat/cap/chip/tier variants in one pass, for
 * #723). Its results print in a SEPARATE section and never set the exit code, because a class
 * injected into a container it never really lives in can report a background it never really has.
 * Treat probe output as "worth looking at", and the live sweep as authoritative.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:4849/live';
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PROBE = flag('probe');
const JSON_OUT = flag('json');
const QUIET = args.includes('--quiet');
/** Container the probe pass injects into. Must be an opaque, representative surface. */
const PROBE_HOST = flag('probe-host') ?? '.lc-stream';

const port = 9334;
const profile = mkdtempSync(join(tmpdir(), 'contrast-sweep-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => {
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // best-effort: Chrome may still be flushing its profile as we exit
  }
};
process.on('exit', cleanup);

let targets;
for (let i = 0; i < 50; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}
const page = targets?.find((t) => t.type === 'page');
if (!page) throw new Error('Chrome DevTools endpoint never came up');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message));
    else res(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
// Let the app mount and settle; live surfaces stream in after first paint.
await new Promise((r) => setTimeout(r, 4000));

/**
 * The whole measurement, run inside the page. Kept as one self-contained function so it can also be
 * pasted straight into a browser console when someone is poking at a surface by hand.
 */
const IN_PAGE = /* js */ `(({ probe, probeHost }) => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  /* Ground truth. Paint over white and over black; the difference gives alpha, and un-premultiplying
     the black composite gives the colour. Works for every colour space and syntax. */
  const resolve = (c) => {
    const px = (back) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = back; ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = c;    ctx.fillRect(0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data;
    };
    const w = px('#fff'), b = px('#000');
    const a = 1 - (w[0] - b[0]) / 255;
    if (a <= 0.0001) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: b[0] / a, g: b[1] / a, b: b[2] / a, a };
  };
  const over = (f, bg) => ({
    r: f.r * f.a + bg.r * (1 - f.a),
    g: f.g * f.a + bg.g * (1 - f.a),
    b: f.b * f.a + bg.b * (1 - f.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const hex = (c) => '#' + [c.r, c.g, c.b]
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

  /* Composite the ancestor stack. Stops and REPORTS at a gradient rather than walking past it. */
  const effBg = (el) => {
    const stack = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        return { gradient: (n.className.toString() || n.tagName).trim().slice(0, 48) };
      }
      const b = resolve(cs.backgroundColor);
      if (b && b.a > 0) { stack.push(b); if (b.a >= 0.999) break; }
      n = n.parentElement;
    }
    let acc = stack.length ? stack[stack.length - 1] : { r: 255, g: 255, b: 255, a: 1 };
    if (acc.a < 1) acc = over(acc, { r: 255, g: 255, b: 255, a: 1 });
    for (let i = stack.length - 2; i >= 0; i--) acc = over(stack[i], acc);
    return { bg: acc };
  };

  const threshold = (cs) => {
    const fs = parseFloat(cs.fontSize), fw = parseInt(cs.fontWeight) || 400;
    return (fs >= 24 || (fs >= 18.66 && fw >= 700)) ? 3.0 : 4.5;
  };
  const measure = (el, sample) => {
    const cs = getComputedStyle(el);
    const e = effBg(el);
    const id = (el.className.toString() || el.tagName).trim().slice(0, 48);
    if (e.gradient) return { skipped: true, el: id, over: e.gradient };
    let fg = resolve(cs.color);
    if (!fg) return null;
    if (fg.a < 1) fg = over(fg, e.bg);
    const need = threshold(cs);
    return {
      el: id, sample, need,
      ink: hex(fg), on: hex(e.bg),
      ratio: Math.round(ratio(fg, e.bg) * 100) / 100,
    };
  };

  /* ── live sweep: every rendered text node, deduped by (class, colour) ── */
  const live = [], skipped = [], seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const key = (el.className.toString() || el.tagName).slice(0, 48) + '|' + cs.color;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = measure(el, text.slice(0, 28));
    if (!m) continue;
    if (m.skipped) skipped.push(m); else live.push(m);
  }

  /* ── probe pass: classes that never render in this state ── */
  const probed = [];
  let probeNote = null;
  if (probe && probe.length) {
    const host = document.querySelector(probeHost);
    if (!host) {
      probeNote = 'probe host ' + probeHost + ' not found — probe pass skipped';
    } else {
      const box = document.createElement('div');
      for (const cls of probe) {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = 'Sample';
        box.appendChild(s);
        box.appendChild(document.createElement('br'));
      }
      host.appendChild(box);
      for (const s of box.querySelectorAll('span')) {
        const m = measure(s, 'Sample');
        if (m) probed.push(m);
      }
      box.remove();
    }
  }

  return {
    url: location.href,
    live: live.sort((a, b) => a.ratio - b.ratio),
    skipped,
    probed: probed.sort((a, b) => a.ratio - b.ratio),
    probeHost, probeNote,
  };
})`;

const probeList = PROBE
  ? PROBE.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
const { result } = await send('Runtime.evaluate', {
  expression: `${IN_PAGE}(${JSON.stringify({ probe: probeList, probeHost: PROBE_HOST })})`,
  returnByValue: true,
  awaitPromise: true,
});
if (result.subtype === 'error') throw new Error(result.description);
const out = result.value;

const liveFails = out.live.filter((r) => r.ratio < r.need);
const probeFails = out.probed.filter((r) => r.ratio < r.need);
const row = (r) =>
  `  ${String(r.ratio).padStart(6)} (need ${r.need})  ${r.ink} on ${r.on}  ${r.el}  "${r.sample}"`;

if (!QUIET) {
  console.log(`\ncontrast-sweep — ${out.url}\n`);
  console.log(`live: ${out.live.length} measured, ${liveFails.length} below AA`);
  for (const r of liveFails) console.log(row(r));

  // Never let a clean run hide what it could not see.
  if (out.skipped.length) {
    console.log(
      `\nSKIPPED ${out.skipped.length} — text over a gradient, which cannot be measured this way.`,
    );
    console.log('  Read that surface’s own paper token instead; do not read this as passing.');
    const by = {};
    for (const s of out.skipped) (by[s.over] ??= []).push(s.el);
    for (const [over, els] of Object.entries(by)) {
      console.log(`  over .${over}: ${[...new Set(els)].join(', ')}`);
    }
  }

  if (probeList.length) {
    console.log(
      `\nprobed on ${out.probeHost}: ${out.probed.length} measured, ${probeFails.length} below AA` +
        ' — advisory, not authoritative (a class measured outside its real container can report a' +
        ' background it never has)',
    );
    for (const r of probeFails) console.log(row(r));
    if (out.probeNote) console.log(`  ${out.probeNote}`);
  }

  console.log(
    '\nNOTE: a DOM sweep only sees what is RENDERED — hover, error, empty and card states are not' +
      ' covered unless you pass --probe.',
  );
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ ...out, liveFails, probeFails }, null, 2));
  if (!QUIET) console.log(`\nwrote ${JSON_OUT}`);
}

// Only the live sweep gates. The probe pass is advisory by construction.
process.exit(liveFails.length ? 1 : 0);
