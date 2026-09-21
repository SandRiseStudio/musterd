#!/usr/bin/env node
/**
 * WCAG 2.2 AA 2.5.8 (Target Size, Minimum) sweep for a rendered page, at a viewport you choose.
 *
 * Usage:
 *   node scripts/a11y/target-size-sweep.mjs [url] [--viewport 390x844] [--json out.json] [--quiet]
 *
 * Exit 1 when a target fails, exit 2 when the sweep could not measure at all (see `chrome.mjs`:
 * a harness failure is never dressed as a verdict about the page).
 *
 * ── Why the contrast gate could not already see this ────────────────────────────────────────────
 *
 * `contrast-gate.mjs` drives 23 sweeps across 14 routes and measures COLOUR. Target size is a
 * computed-LAYOUT property at a specific viewport, so that gate is structurally blind to it — which
 * is how the shared nav and footer shipped 21–22px-tall targets on every route while it stayed
 * green (measured 2026-09-21, lane 01M32GF49Z).
 *
 * The fix's own tests cannot replace this either. `site.test.ts` pins the min-heights by reading
 * CSS SOURCE: it stops someone deleting a declaration, and it cannot see what a browser lays out —
 * a new link added without the rule, a media query that overrides the min-height at some width, a
 * flex context that shrinks a target, two targets that overlap. Every one of those is a real 2.5.8
 * failure and none is visible in source text.
 *
 * ── The rule this implements, stated exactly, because a gate that overreaches gets switched off ──
 *
 * 2.5.8 is NOT "every target is 24×24". It is: the target is at least 24×24 CSS px, OR one of four
 * exceptions applies. This sweep implements the success criterion, not a 24px ruler, and each
 * verdict says WHICH clause decided it:
 *
 *   SIZE      — the bounding box is ≥24×24. Passes outright.
 *   SPACING   — undersized, but a 24px-diameter circle centred on it reaches no other target's box
 *               and no other undersized target's circle. This is the spec's own get-out and it is
 *               the reason the gate is not simply a size check. Implemented as: centre-to-box
 *               distance ≥12px against every other target, and centre-to-centre ≥24px against every
 *               other undersized one.
 *   INLINE    — the target is in a sentence: its parent is a text-flow element that holds real text
 *               OUTSIDE the anchor. /watch's closing repo URL is the worked example, it is 17px at
 *               desktop, and it is correctly exempt. THIS EXCEPTION IS THE HARD PART OF THE WHOLE
 *               GATE. Too permissive and the gate is decorative; too strict and it is noise that
 *               someone deletes. The rule and its worked examples live in docs/a11y/target-size.md.
 *   ESSENTIAL — nothing is exempted here automatically. A target whose size is genuinely required
 *               (a map pin at a coordinate) needs `data-a11y-target-essential` with a reason, and
 *               the reason is printed on every run so an exemption cannot go quiet.
 *
 * OVERLAP is a failure in its own right and not a spacing nicety. An obscured target fails 2.5.8
 * as surely as a small one, and during the 01M32GF49Z fix a first cut traded a small-target
 * violation for an overlap one — only measuring caught it. Overlap is checked for EVERY pair,
 * including two targets that are each comfortably 24×24.
 *
 * ── What a green run does not mean ──────────────────────────────────────────────────────────────
 *
 * One viewport, one render, one state. Hover menus, open dropdowns, focus-visible affordances and
 * anything behind an interaction are not measured, and a target a route does not render is a target
 * nobody swept. The output says so every run.
 */
import { writeFileSync } from 'node:fs';
import { openChromePage } from './chrome.mjs';
import { HOUSE_FLOOR_SCOPE, MIN, judge, overlappingPairs } from './target-size-rules.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:4849/';
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const QUIET = args.includes('--quiet');
const JSON_OUT = flag('json');

/* 390×844 is the iPhone 12/13/14 logical viewport and the width the 2026-09-21 audit read the site
   at. It is a DELIBERATE default rather than a desktop one: target size is the criterion that only
   bites at phone width, so a sweep that defaults to 1440 would be green by construction. */
const [VW, VH] = (flag('viewport') ?? '390x844').split('x').map(Number);
if (!Number.isInteger(VW) || !Number.isInteger(VH) || VW < 200 || VH < 200) {
  console.error(`target-size-sweep — --viewport wants WxH in CSS px, got "${flag('viewport')}".`);
  process.exit(2);
}

const { send, exit } = await openChromePage({
  tool: 'target-size-sweep',
  verdictNoun: 'target size',
  windowSize: `${VW},${VH}`,
});

/* The window size above sizes the OS window; this sizes the viewport the page lays out against,
   and `mobile: true` is what makes the meta viewport apply. Without the override a headless window
   of 390 still lays out at its own default width and every measurement is of a page no phone
   renders. Set before navigating so the first paint is already at this width. */
await send('Emulation.setDeviceMetricsOverride', {
  width: VW,
  height: VH,
  deviceScaleFactor: 1,
  mobile: true,
});
/* Same reason as the contrast sweep: this is a real user state the project writes CSS for, and a
   page mid-animation has no settled geometry to measure. */
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
}).catch(() => {});
await send('Page.navigate', { url });

/**
 * Wait until the geometry of every target has stopped changing.
 *
 * Layout settles later than `load` — fonts swap and reflow line boxes, lazy routes mount, a flex
 * container reshuffles. Measuring before then reports a frame, and a verdict that depends on which
 * frame the sampler caught is the latent flake the contrast sweep spent three incidents removing.
 * So: poll the geometry signature until two consecutive reads agree, then measure.
 */
const SETTLE_STEP = Number(process.env.A11Y_SETTLE_STEP ?? 300);
const SETTLE_CAP = Number(process.env.A11Y_SETTLE_CAP ?? 20000);

const evalIn = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    console.error(
      `target-size-sweep — the page threw while being measured: ${
        exceptionDetails.exception?.description ?? exceptionDetails.text
      }\n  Nothing was measured. This is a harness failure, not a target-size result.`,
    );
    await exit(2);
  }
  return result.value;
};

/**
 * The selector set: what counts as a "target".
 *
 * 2.5.8 is about POINTER targets, so this is the set a finger can land on and act with. `<label>`
 * is in because clicking one activates its control. `[tabindex]` alone is NOT — keyboard
 * reachability is not a pointer target, and including it drags every focus-trap sentinel and
 * scroll container into the report as noise.
 */
const TARGET_SELECTOR =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, label, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"]';

const GEOM_SIG = /* js */ `(() => {
  const els = document.querySelectorAll(${JSON.stringify(TARGET_SELECTOR)});
  const parts = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    parts.push(Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + ',' + Math.round(r.height));
  }
  return document.readyState + '|' + parts.length + '|' + parts.join(';');
})()`;

const settled = await (async () => {
  const deadline = Date.now() + SETTLE_CAP;
  let last = null;
  while (Date.now() < deadline) {
    const sig = await evalIn(GEOM_SIG);
    if (last !== null && sig === last && sig.startsWith('complete')) return true;
    last = sig;
    await new Promise((r) => setTimeout(r, SETTLE_STEP));
  }
  return false;
})();

/**
 * The measurement, in the page.
 *
 * Returns one row per VISIBLE target with its box, its accessible-ish name, a selector a human can
 * find it by, and the two facts only the DOM can answer: whether it is inline in a sentence, and
 * whether it was marked essential. All the geometry judging happens back in Node, where it can be
 * unit-tested without a browser.
 */
const MEASURE = /* js */ `(() => {
  const SEL = ${JSON.stringify(TARGET_SELECTOR)};
  const CHROME_SCOPE = ${JSON.stringify(HOUSE_FLOOR_SCOPE)};

  /** A path a person can paste into the console. Same shape the contrast sweep prints. */
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      const cls = (n.className && typeof n.className === 'string' ? n.className : '')
        .trim().split(/\\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('');
      parts.unshift(n.tagName.toLowerCase() + cls);
    }
    return parts.join('>') || 'root';
  };

  /**
   * THE INLINE EXCEPTION — 2.5.8's "in a sentence" clause, and the one judgement in this file.
   *
   * The rule, in two conditions that must BOTH hold:
   *
   *   1. the target's own computed display is exactly 'inline'. Not 'inline-block', not
   *      'inline-flex'. A word in a sentence is laid out as a word; a button is laid out as a box
   *      that happens to sit on a line, and authors reach for 'inline-block' precisely to make one.
   *   2. its parent (climbing through purely-inline wrappers like <em> or <span>) holds a DIRECT
   *      non-whitespace text node outside the target. That is what "in a sentence" means: there is
   *      prose either side of it in the same line of text.
   *
   * CONDITION 1 IS NOT DECORATION — it was added after this sweep's first run against the real
   * site, which exempted /watch's "Zero to a working team in one command" CTA. That is an
   * 'inline-block' anchor whose nearest BLOCK ancestor is a <section> containing an <h2> and a
   * paragraph; the first cut of this rule looked for text anywhere in that block ancestor, found
   * the paragraph, and called a standalone button a sentence. A CTA is the single most important
   * target on the page, and the gate was exempting it. Measured 2026-09-21, lane 01M32HG5GJ.
   *
   * The permissive direction is the dangerous one. Getting this too strict makes noise someone
   * deletes; getting it too loose makes a gate that reports green about the buttons that matter.
   * Worked examples, both directions, in docs/a11y/target-size.md.
   */
  const isInlineInText = (el) => {
    if (getComputedStyle(el).display !== 'inline') return false;
    // Climb out of inline wrappers (<em><a>…</a></em>) to the element that owns the line's text.
    let host = el.parentElement;
    let inner = el;
    while (host && getComputedStyle(host).display === 'inline') {
      inner = host;
      host = host.parentElement;
    }
    if (!host) return false;
    for (const node of host.childNodes) {
      if (node === inner) continue;
      if (node.nodeType === 3 && node.textContent.replace(/[\\s\\u00a0]+/g, '').length > 0)
        return true;
    }
    return false;
  };

  const rows = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // Not rendered at all: zero box, display:none's zero box, visibility:hidden, fully transparent.
    // These are not targets a finger can reach, and reporting them is the noise that gets a gate
    // muted. They are COUNTED so the summary can say how many were skipped and why.
    if (r.width === 0 || r.height === 0) { rows.push({ skipped: 'zero-box', sel: pathOf(el) }); continue; }
    if (cs.visibility === 'hidden' || cs.opacity === '0') { rows.push({ skipped: 'invisible', sel: pathOf(el) }); continue; }
    if (el.closest('[inert]') || el.hasAttribute('disabled')) { rows.push({ skipped: 'inert', sel: pathOf(el) }); continue; }
    rows.push({
      sel: pathOf(el),
      name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '')
        .trim().replace(/\\s+/g, ' ').slice(0, 40),
      x: r.x, y: r.y, w: r.width, h: r.height,
      inline: isInlineInText(el),
      chrome: !!el.closest(CHROME_SCOPE),
      essential: el.getAttribute('data-a11y-target-essential'),
    });
  }
  return { rows, viewport: { w: innerWidth, h: innerHeight } };
})()`;

const { rows, viewport } = await evalIn(MEASURE);
const targets = rows.filter((r) => !r.skipped);
const skipped = rows.filter((r) => r.skipped);

const judged = targets.map((t) => ({ ...t, ...judge(t, targets) }));
const failures = judged.filter((j) => j.verdict === 'fail');
const houseFailures = judged.filter((j) => j.verdict === 'house');

const overlapping = overlappingPairs(targets);

/**
 * A CLEAN SWEEP OF NOTHING IS NOT A PASS.
 *
 * Zero targets on a page that should have a nav means the page never rendered — a 404 from a
 * mis-typed route, a stale `dist/`, a client that never mounted. Reported as a green run it is
 * indistinguishable from a page with nothing wrong, which is the one direction an a11y tool must
 * never fail in. Hit immediately: the first gate run pointed at a `/roadmap` that was missing from
 * a stale dist and got "0 measured, 0 below AA" and exit 0 (2026-09-21, lane 01M32HG5GJ).
 *
 * Exit 2, not 1: nothing was MEASURED, so no verdict about target size was taken. Same contract as
 * `contrast-sweep.mjs`. `--allow-empty` is for a page that genuinely has no interactive element.
 */
if (targets.length === 0 && !args.includes('--allow-empty')) {
  console.error(
    `target-size-sweep — ${url} rendered no interactive target at all` +
      `${skipped.length ? ` (${skipped.length} were skipped as zero-box/invisible/inert)` : ''}.` +
      ' That is almost certainly a page that never rendered, not a page with nothing to measure.' +
      ' Nothing was measured; no target-size verdict was taken. Pass --allow-empty if the route' +
      ' really has no links or buttons.',
  );
  await exit(2);
}

const log = QUIET ? () => {} : (...a) => console.log(...a);
const counts = judged.reduce((m, j) => ({ ...m, [j.verdict]: (m[j.verdict] ?? 0) + 1 }), {});
log(`target-size-sweep — ${url} at ${viewport.w}×${viewport.h}`);
log(
  `targets: ${targets.length} measured, ${failures.length} below AA 2.5.8, ` +
    `${houseFailures.length} below the house floor, ${overlapping.length} overlapping pair(s)` +
    (settled ? '' : ', MEASURED MID-FLIGHT (geometry never settled)'),
);
for (const f of failures) log(`  ✗ ${f.sel} "${f.name}" — ${f.why}`);
for (const f of houseFailures) log(`  ✗ HOUSE FLOOR ${f.sel} "${f.name}" — ${f.why}`);
for (const [a, b] of overlapping)
  log(
    `  ✗ OVERLAP ${a.sel} "${a.name}" and ${b.sel} "${b.name}" — ` +
      'both are reachable only by luck at this viewport',
  );

/* Exceptions, printed on every run with their reason. An exemption that stops being visible stops
   being reviewed — the contrast sweep's rule, and the reason this one has no silent allowlist. */
const inlineRows = judged.filter((j) => j.verdict === 'inline');
const essentialRows = judged.filter((j) => j.verdict === 'essential');
const spacingRows = judged.filter((j) => j.verdict === 'spacing');
if (inlineRows.length)
  log(
    `\nEXEMPT — inline in a sentence (${inlineRows.length}): ` +
      inlineRows.map((r) => `${r.sel} "${r.name}"`).join(', '),
  );
if (essentialRows.length)
  log(
    `\nEXEMPT — declared essential (${essentialRows.length}): ` +
      essentialRows.map((r) => `${r.sel} — ${r.why}`).join(', '),
  );
if (spacingRows.length)
  log(
    `\nPASSED ON SPACING — under ${MIN}px but uncrowded (${spacingRows.length}): ` +
      spacingRows.map((r) => `${r.sel} "${r.name}" ${r.why}`).join(', '),
  );
if (skipped.length) {
  const by = skipped.reduce((m, s) => ({ ...m, [s.skipped]: (m[s.skipped] ?? 0) + 1 }), {});
  log(
    `\nNOT MEASURED — ${Object.entries(by)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}.`,
  );
}
log(
  '\nThis is ONE viewport, ONE render, ONE state: hover menus, open dropdowns and anything behind' +
    ' an interaction are not measured here.',
);
log(
  `clauses: ${
    Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ') || 'none'
  }`,
);

if (JSON_OUT)
  writeFileSync(JSON_OUT, JSON.stringify({ url, viewport, judged, overlapping }, null, 2));

await exit(failures.length || houseFailures.length || overlapping.length ? 1 : 0);
