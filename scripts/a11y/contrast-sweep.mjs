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
 * STOPS at a gradient rather than guessing.
 *
 *   3. And stopping was still not enough. `effBg()` was honest about gradients but silent about
 *      OPACITY: a row faded to 0.55 has its ink read at full strength, so `.lc-seat--offline`
 *      reported 14.34 where the eye gets 3.55. Refusing to answer where you cannot see is only half
 *      the discipline; the other half is noticing where you can see but are looking at the wrong
 *      thing (2026-08-13).
 *
 * ── So: sample the pixel that was actually painted ──────────────────────────────────────────────
 *
 * After the walk, every glyph on the page is made transparent, the page is screenshotted through
 * CDP, the PNG is decoded here (pure zlib, no deps) and each text node's own line box is sampled.
 * Whatever is under that pixel — gradient stop, photograph, live canvas, three translucent layers —
 * is what the reader gets. The element's settled opacity is folded into the INK as well, because a
 * fade dims the words and the paper together.
 *
 * Three rules keep that from becoming a new confident wrong answer:
 *   • It must AGREE with the walk wherever the walk was valid. Both run every time and every
 *     disagreement past rounding is printed. The first run disagreed on three elements and the walk
 *     was right about all three — they were mid-animation, which is now excluded explicitly.
 *   • A fade that is still MOVING is refused, not measured; a fade that has SETTLED is measured with
 *     the fade included. Two opacity readings 300ms apart tell them apart.
 *   • Validated end to end against the canonical greys every time it changes: #767676 on white is
 *     4.54, #777777 is 4.48, 30% black over white is 2.11, and #949494 over a gradient-painted black
 *     is 6.92 — the last of which the walk could not measure at all.
 *
 * ── The reporting rules, which are the point ────────────────────────────────────────────────────
 *
 * An accessibility tool that under-reports is worse than none, because "0 failures" gets believed.
 * So:
 *   • Text the pixel pass cannot reach either — no line box, off the captured page — is still
 *     reported as SKIPPED with a count and selectors, never dropped silently.
 *   • Exemptions are printed in their own section on every run, each with the reason it is allowed.
 *     The only one is WCAG 1.4.3's logotype carve-out.
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
import { inflateSync } from 'node:zlib';

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
/* 30s, not 10. On a cold CI runner the first Chrome of a session takes appreciably longer to open
   its debugging port than the third does — the 2026-08-13 gate run failed the first three routes
   and then sailed through the remaining nine on the same machine. A timeout tuned on a warm laptop
   is how a suite acquires a "flaky" reputation it does not deserve. */
for (let i = 0; i < 150; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}
const page = targets?.find((t) => t.type === 'page');
if (!page) {
  console.error(
    `contrast-sweep — Chrome (${CHROME}) never opened its debugging port on :${port} within 30s.` +
      ' Nothing was measured. This is a harness failure, not a contrast result.',
  );
  process.exit(2);
}

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
/* Measure the reduced-motion rendering, and set it BEFORE navigating so the stylesheets see it on
   first paint. Two reasons, and neither is about tidiness: it is a real user state this project
   already writes CSS for (every keyframe in GoalGrid.css and Live.css is disabled under it), and a
   page mid-animation has no single background to measure — the pixel pass below would sample a
   frame nobody stays on. Emulation is best-effort: an older Chrome that rejects it still gets the
   animation-settling pass underneath. */
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
}).catch(() => {});
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
  const measure = (el, sample, key) => {
    const cs = getComputedStyle(el);
    const e = effBg(el);
    const id = (el.className.toString() || el.tagName).trim().slice(0, 48);
    const need = threshold(cs);
    /* WCAG 1.4.3 exempts INACTIVE components, and this is read off the element rather than off a
       name list: a disabled control is disabled whatever it is called, and a list of class names
       would quietly keep exempting one after it was re-enabled. */
    const inactive = el.closest('[disabled],[aria-disabled="true"],:disabled') !== null;
    let fg = resolve(cs.color);
    if (!fg) return null;
    /* A gradient defeats the ancestor walk, but the pixel pass can still rescue this element — so
       carry everything it needs (the resolved ink, the size threshold, the join key) rather than
       reporting a bare name. An unrescued row still prints as SKIPPED, exactly as before.
       An alpha ink cannot be flattened without a background, so it stays unresolved here and the
       pixel pass composites it over what it actually samples. */
    if (e.gradient) {
      return { skipped: true, key, el: id, sample, need, over: e.gradient, inactive,
               ink: fg.a >= 1 ? hex(fg) : null };
    }
    if (fg.a < 1) fg = over(fg, e.bg);
    return {
      key, el: id, sample, need,
      ink: hex(fg), on: hex(e.bg),
      ratio: Math.round(ratio(fg, e.bg) * 100) / 100,
      inactive,
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
    const m = measure(el, text.slice(0, 28), key);
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

/* ── the painted pixel ──────────────────────────────────────────────────────────────────────────
 *
 * Everything above composites background COLOURS up the ancestor chain, which is exact right up
 * until something paints a gradient, an image or a canvas — and then it is not merely inexact, it
 * is unknowable, so it stops and says SKIPPED. That bucket was never small (13–21 elements a route)
 * and #786 proved it was not shrinking: seeding the office made the asks rail's tier chips VISIBLE
 * and still unmeasurable, because they sit on a gradient.
 *
 * So stop reasoning about what the background should be and read what it IS. Make every glyph on
 * the page transparent, screenshot, and sample each text node's own line box. Whatever is under
 * that pixel — gradient stop, photo, live canvas, three translucent layers — is what the eye gets.
 *
 * Two things keep this honest rather than merely clever:
 *
 *   1. It must AGREE with the old method wherever the old method was valid. Both run, every run,
 *      and any element where they disagree by more than a rounding wobble is reported. A new
 *      measurement that quietly disagrees with a validated one is how this file's header describes
 *      its two previous wrong answers.
 *   2. Where a pixel cannot be had — a zero-area rect, a node outside the captured page — it stays
 *      SKIPPED. Fewer skips is the point; zero skips by pretending is not.
 */

/** Minimal PNG reader: 8-bit RGB/RGBA, non-interlaced — what CDP's screenshots are. No deps. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0,
    height = 0,
    colorType = -1,
    bitDepth = 0,
    interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  // Refuse rather than guess: a misread pixel is a confident wrong contrast number.
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `unsupported PNG (bitDepth ${bitDepth}, colorType ${colorType}, interlace ${interlace})`,
    );
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prior ? prior[i] : 0;
      const c = prior && i >= channels ? prior[i - channels] : 0;
      const x = line[i];
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`unknown PNG filter ${filter}`);
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * Collect one line box per measured text node, keyed exactly as the live sweep keys its rows.
 *
 * Also reports each node's EFFECTIVE opacity — the product of its ancestors'. An element that is
 * half faded in has no settled background, and a pixel sampled there is a frame nobody stays on.
 * The composited estimate is used for those instead, because it reads the CSS the animation is
 * heading TOWARD rather than the frame it is passing through. This is not hypothetical: the first
 * run of the pixel pass disagreed with the old method on three elements, and all three turned out
 * to be `.lc-asks--loud` and `.lc__canvas` sitting at opacity 0 behind an entrance keyframe that
 * had not settled. Sampled numbers were LOWER — this guard is what stops that becoming a bogus
 * failure in CI.
 */
const RECTS_IN_PAGE = /* js */ `(() => {
  /* Jump every finite animation to its end state first. Infinite ones (the clock sheen, the runway
     shimmer) throw on finish() and are left alone — they are decorative loops with no end state,
     and reduced-motion emulation has already disabled the ones this project controls. */
  for (const a of document.getAnimations()) { try { a.finish(); } catch {} }
  const effOpacity = (el) => {
    let o = 1, n = el;
    while (n && n.nodeType === 1) { o *= parseFloat(getComputedStyle(n).opacity); n = n.parentElement; }
    return o;
  };
  const rects = [], seen = new Set();
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
    /* The TEXT's own box, not the element's: an element's bounding rect can include padding that
       sits on different paint than the glyphs do. */
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = [...range.getClientRects()].find((x) => x.width > 0 && x.height > 0);
    range.detach?.();
    if (!r) continue;
    rects.push({
      key,
      x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height,
      opacity: effOpacity(el),
    });
  }
  return {
    rects,
    dpr: window.devicePixelRatio || 1,
    docW: Math.ceil(document.documentElement.scrollWidth),
    docH: Math.ceil(document.documentElement.scrollHeight),
  };
})()`;

const evalIn = async (expression) => {
  const { result: r } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.subtype === 'error') throw new Error(r.description);
  return r.value;
};

/** Re-read effective opacity per key, to tell a transient fade from a permanent one. */
const OPACITY_IN_PAGE = /* js */ `(() => {
  const eff = (el) => { let o = 1, n = el; while (n && n.nodeType === 1) { o *= parseFloat(getComputedStyle(n).opacity); n = n.parentElement; } return o; };
  const outv = {}, seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim()) continue;
    const el = node.parentElement; if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const key = (el.className.toString() || el.tagName).slice(0, 48) + '|' + cs.color;
    if (seen.has(key)) continue;
    seen.add(key);
    outv[key] = eff(el);
  }
  return outv;
})()`;

let pixel = null;
let pixelNote = null;
try {
  const geom = await evalIn(RECTS_IN_PAGE);
  /* Two readings, a beat apart. A fade that is still MOVING has no settled appearance and must not
     be measured. A fade that is STILL is a design decision — the office watermark sits at 0.45 on
     purpose, dimmed roster rows likewise — and there the translucency is exactly what the reader
     gets, so it belongs IN the number rather than excused from it. Telling the two apart is the
     difference between refusing to measure and quietly measuring the wrong thing. */
  await new Promise((r) => setTimeout(r, 300));
  const opacity2 = await evalIn(OPACITY_IN_PAGE);
  // Chrome refuses absurd capture areas, and a runaway page should not take the sweep down with it.
  const tall = geom.docH > 20000;
  await evalIn(`(() => {
    const s = document.createElement('style');
    s.id = '__a11y_glyphs_off';
    /* Every glyph, including generated content. \`-webkit-text-fill-color\` is the one that actually
       wins when a surface paints text with a clipped background (the brand wordmark does). */
    s.textContent = '*,*::before,*::after{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important;caret-color:transparent !important;}';
    document.head.appendChild(s);
    return true;
  })()`);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: !tall,
    ...(tall ? {} : { clip: { x: 0, y: 0, width: geom.docW, height: geom.docH, scale: 1 } }),
  });
  await evalIn(`document.getElementById('__a11y_glyphs_off')?.remove()`);

  /* A THIRD reading, after the shutter. The first two bracket a 300ms window BEFORE the screenshot,
     which catches a fade that is already moving — but not one that starts afterwards. The office
     preview runs a timed choreography that pulls speech bubbles back out of the room, and on CI a
     bubble sat at opacity 1 for both readings and was then halfway gone by the time the pixel was
     taken. It reported 3.16 for text that is nowhere near that bad, which is a false FAILURE — the
     one kind of wrong answer that costs a person a day chasing a colour that was never wrong.
     Requiring stability across the whole window, shutter included, is what actually closes it. */
  const opacity3 = await evalIn(OPACITY_IN_PAGE);
  const img = decodePng(Buffer.from(shot.data, 'base64'));
  // With a clip at scale 1 the image is CSS pixels; without one it is device pixels.
  const scale = tall ? geom.dpr : img.width / geom.docW;
  const at = (px, py) => {
    const ix = Math.round(px * scale),
      iy = Math.round(py * scale);
    if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) return null;
    const o = iy * img.width * img.channels + ix * img.channels;
    return { r: img.data[o], g: img.data[o + 1], b: img.data[o + 2], a: 1 };
  };
  pixel = new Map();
  const unsettled = [];
  const faded = [];
  for (const rc of geom.rects) {
    const now = opacity2[rc.key];
    const after = opacity3[rc.key];
    const moving =
      now === undefined ||
      after === undefined ||
      Math.abs(now - rc.opacity) > 0.01 ||
      Math.abs(after - rc.opacity) > 0.01;
    if (rc.opacity < 0.99 && moving) {
      unsettled.push(rc.key.split('|')[0] || '?');
      continue;
    }
    if (rc.opacity < 0.99) faded.push(rc.key.split('|')[0] || '?');
    // Centre of the line box. With glyphs transparent the whole box is background, so the centre is
    // as good as any point and is the least likely to catch a border or a rounded corner.
    const p = at(rc.x + rc.w / 2, rc.y + rc.h / 2);
    // Carry the settled opacity: the glyphs are faded by it too, so the INK has to be composited at
    // that alpha over what was sampled. Fading text is one of the commonest ways contrast dies, and
    // reading the ink at full strength is precisely how a tool misses it.
    if (p) pixel.set(rc.key, { ...p, textAlpha: rc.opacity });
  }
  const notes = [];
  if (tall)
    notes.push(
      `page is ${geom.docH}px tall — sampled the viewport only, below-fold text kept its composited estimate`,
    );
  if (faded.length)
    notes.push(
      `${faded.length} element(s) are permanently translucent — their ink is composited at that` +
        ` alpha rather than read at full strength: ${[...new Set(faded)].join(', ')}`,
    );
  if (unsettled.length)
    notes.push(
      `${unsettled.length} element(s) were mid-animation or faded (effective opacity < 1) and kept` +
        ` their composited estimate rather than a frame nobody stays on: ${[...new Set(unsettled)].join(', ')}`,
    );
  pixelNote = notes.length ? notes.join('; ') : null;
} catch (e) {
  pixelNote = `pixel sampling unavailable (${e.message}) — falling back to composited backgrounds`;
}

/* Fold the sampled background in, and make the two methods argue in public. */
const disagreements = [];
if (pixel) {
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratioOf = (a, b) => {
    const l1 = lum(a),
      l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const hex = (c) =>
    '#' +
    [c.r, c.g, c.b]
      .map((v) =>
        Math.round(Math.max(0, Math.min(255, v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  const parseHex = (h) => ({
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
    a: 1,
  });
  /** Ink as it actually lands: at the element's settled opacity, over the pixel behind it. */
  const inkOn = (inkHex, bg) => {
    const f = parseHex(inkHex);
    const a = bg.textAlpha ?? 1;
    if (a >= 1) return f;
    return {
      r: f.r * a + bg.r * (1 - a),
      g: f.g * a + bg.g * (1 - a),
      b: f.b * a + bg.b * (1 - a),
      a: 1,
    };
  };

  const rescue = [];
  for (const row of out.live) {
    const bg = pixel.get(row.key);
    if (!bg) continue;
    const was = row.ratio;
    row.on = hex(bg);
    row.ratio = Math.round(ratioOf(inkOn(row.ink, bg), bg) * 100) / 100;
    row.method = 'pixel';
    if ((bg.textAlpha ?? 1) < 1) row.faded = Math.round(bg.textAlpha * 100) / 100;
    // Same page, same element, two independent methods. A real gap means one of them is lying.
    if (Math.abs(was - row.ratio) > 0.15) {
      disagreements.push({ el: row.el, composited: was, sampled: row.ratio, on: row.on });
    }
  }
  // The whole point: elements the old method refused now have a number.
  for (const s of out.skipped.slice()) {
    const bg = pixel.get(s.key);
    if (!bg || !s.ink) continue;
    const row = {
      el: s.el,
      sample: s.sample,
      need: s.need,
      ink: s.ink,
      on: hex(bg),
      ratio: Math.round(ratioOf(inkOn(s.ink, bg), bg) * 100) / 100,
      method: 'pixel',
      wasSkipped: s.over,
      inactive: s.inactive,
      ...((bg.textAlpha ?? 1) < 1 ? { faded: Math.round(bg.textAlpha * 100) / 100 } : {}),
    };
    out.live.push(row);
    rescue.push(row);
  }
  out.skipped = out.skipped.filter((s) => !pixel.has(s.key));
  out.live.sort((a, b) => a.ratio - b.ratio);
  out.rescued = rescue.length;
  out.disagreements = disagreements;
}

/**
 * The only sanctioned exemptions, each with its reason, all of them printed on EVERY run.
 *
 * WCAG 2.1 SC 1.4.3 carves out logotypes in as many words: "Text that is part of a logo or brand
 * name has no contrast requirement." That is the entire licence this list operates under — it is not
 * a place to park an inconvenient failure. Two properties keep it that way: an entry needs a reason
 * string, and exempted rows are REPORTED in their own section rather than filtered into silence, so
 * a reader always sees what was excused and can disagree. Anything that is merely hard to fix goes
 * in the failure list where it belongs.
 */
const EXEMPT = [
  {
    match: 'lc-office__mark-lockup',
    why: 'WCAG 1.4.3 logotype carve-out — the musterd wordmark watermarked into the room. Its 0.45 opacity is a deliberate, tuned value (nick, 2026-07-28: "34% nearly vanished into the midday floor gradient"), and it names the product rather than conveying information.',
  },
];
const INACTIVE_WHY =
  'WCAG 1.4.3 inactive-component carve-out — a disabled control. Its ratio is the disabled styling,' +
  ' not the colour a reader ever has to act on; the enabled state is measured like anything else.';
const exemptOf = (r) =>
  r.inactive ? { why: INACTIVE_WHY } : EXEMPT.find((e) => r.el.includes(e.match));

const exempted = out.live.filter((r) => r.ratio < r.need && exemptOf(r));
const liveFails = out.live.filter((r) => r.ratio < r.need && !exemptOf(r));
const probeFails = out.probed.filter((r) => r.ratio < r.need);
const row = (r) =>
  `  ${String(r.ratio).padStart(6)} (need ${r.need})  ${r.ink} on ${r.on}  ${r.el}  "${r.sample}"`;

if (!QUIET) {
  console.log(`\ncontrast-sweep — ${out.url}\n`);
  console.log(
    `live: ${out.live.length} measured, ${liveFails.length} below AA` +
      (out.rescued ? ` (${out.rescued} of them only reachable by sampling the painted pixel)` : ''),
  );
  for (const r of liveFails) console.log(row(r));

  if (pixelNote) console.log(`\n! ${pixelNote}`);

  /* Excused, never hidden. If this section ever grows past the WCAG carve-out it is licensed by,
     that is the finding. */
  if (exempted.length) {
    console.log(`\nEXEMPT ${exempted.length} — below AA, and allowed to be:`);
    for (const r of exempted) {
      console.log(`${row(r)}\n    ${exemptOf(r).why}`);
    }
  }

  /* The cross-check, printed loudly. Both methods ran on every element the old one could handle, so
     a disagreement is not a curiosity — it means one of the two numbers on this page is wrong, and
     the next person needs to know that before trusting either. */
  if (out.disagreements?.length) {
    console.log(
      `\nDISAGREEMENT ${out.disagreements.length} — the composited estimate and the sampled pixel` +
        ' differ by more than rounding. The sampled value is used; verify before trusting it.',
    );
    for (const d of out.disagreements) {
      console.log(`  ${d.el}: composited ${d.composited} vs sampled ${d.sampled} on ${d.on}`);
    }
  }

  // Never let a clean run hide what it could not see.
  if (out.skipped.length) {
    console.log(
      `\nSKIPPED ${out.skipped.length} — neither method could reach these: the walk stopped at a` +
        ' gradient AND the pixel pass found no line box to sample (or the text sits off the' +
        ' captured page). Do not read this as passing.',
    );
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
