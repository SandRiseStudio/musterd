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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const PROFILE_PREFIX = 'contrast-sweep-';
/** Old enough that no live run's profile can match. A sweep takes ~10s; an hour is 300x that. */
const PROFILE_TTL_MS = 60 * 60 * 1000;

/**
 * Delete profile directories left behind by earlier runs.
 *
 * Recovering ground already lost needs its own pass: a fix that only stops NEW leaks leaves the pile
 * standing. Measured on this laptop 2026-08-13, two days after the sweep became a gate: 400
 * directories, 240 MB — Chrome's component cache and Safe Browsing store, re-downloaded every run
 * because every run starts from a virgin profile. Age-gated so it can never touch the profile of a
 * sweep running concurrently (the gate runs twelve of them back to back).
 *
 * Same shape and same reason as `sweepStaleProfiles` in `packages/cli/src/commands/broadcast.ts`,
 * which fixed this class for `musterd broadcast` after an incident left 23 profiles and 837 MB.
 */
const sweepStaleProfiles = (dir = tmpdir(), ttlMs = PROFILE_TTL_MS, now = Date.now()) => {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(PROFILE_PREFIX)) continue;
      const full = join(dir, name);
      try {
        if (now - statSync(full).mtimeMs < ttlMs) continue;
        rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {
        /* raced with another sweep, or not ours to delete — skip it */
      }
    }
  } catch {
    /* no temp dir to read — nothing to sweep */
  }
  return removed;
};
sweepStaleProfiles();

/**
 * Chrome, its profile, and the evidence it leaves if it fails to start.
 *
 * `let`, not `const`, because a launch is RETRYABLE (see `bringUpChrome`) and a retry gets a fresh
 * profile — reusing the directory of a Chrome that just died is how a bad first start poisons the
 * second one. `shutdown`/`cleanup` below always act on whichever attempt is current.
 */
let profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
let chrome;
let chromeGone;
/** Chrome's own stderr, capped. The ONLY artifact that says why a start failed — see `launch`. */
let chromeErr = '';

const CHROME_ARGS = [
  '--headless=new',
  /* Port 0 = "pick a free one and tell me". NOT a tidiness change: this used to be a hardcoded
   * 9334, and a hardcoded port is shared state between every sweep on the machine. The second
   * sweep's Chrome cannot bind it, so the second sweep's `/json/list` answers from the FIRST
   * sweep's browser and both runs then drive one page. Reproduced by dolly (lane 01KZZ7BQE3):
   * a sweep pointed at alpha.html filed a GREEN report whose url read beta.html — a pass for a
   * page nobody looked at, which is the one direction this file's header forbids failing in.
   * Nineteen worktrees share this laptop, so concurrent sweeps are normal, not exotic.
   *
   * The port now comes out of OUR OWN profile directory (`DevToolsActivePort`, written by Chrome
   * on startup), so it is structurally impossible to reach a browser we did not start. That is
   * why this fixes the class rather than narrowing the window: there is no shared name left to
   * collide on. */
  '--remote-debugging-port=0',
  '--no-first-run',
  '--disable-extensions',
  '--window-size=1440,900',
  'about:blank',
];

/**
 * Start one Chrome against the current `profile`, and KEEP ITS STDERR.
 *
 * It used to be spawned with `stdio: 'ignore'`, which threw away the only artifact that could
 * explain a failed start. Every occurrence of "never opened a debugging port" was therefore
 * re-run rather than diagnosed — including CI run 32295496057 (2026-08-19), where the operator got
 * a timeout message and nothing to act on. Capped at 4 KB because a Chrome that is merely CHATTY
 * must not turn a harness failure into an unreadable one.
 */
const launch = () => {
  chromeErr = '';
  chrome = spawn(CHROME, [...CHROME_ARGS, `--user-data-dir=${profile}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  chrome.stderr?.on('data', (d) => {
    if (chromeErr.length < 4096) chromeErr += String(d);
  });
  /* A spawn that never starts emits 'error', and an unhandled 'error' on a ChildProcess THROWS.
     Without this, pointing CHROME_BIN at a missing binary killed the sweep with a raw Node stack
     instead of the refusal directly below — the same harness failure, reported in the one form that
     tells the reader nothing about which gate refused or why. */
  chrome.on('error', (e) => {
    chromeErr += `${e.message}\n`;
    chrome.exited = true;
    chrome.exitInfo = e.code ? `spawn ${e.code}` : 'spawn failed';
  });
  /* `exited` is a FLAG as well as a promise: the wait loop below needs to ask "is it already gone?"
     synchronously on every tick, which a promise alone cannot answer. */
  chrome.exited = false;
  chromeGone = new Promise((res) => {
    chrome.once('exit', (code, signal) => {
      chrome.exited = true;
      chrome.exitInfo = signal ? `signal ${signal}` : `code ${code}`;
      res();
    });
    /* 'error' as well as 'exit', or `shutdown()` awaits a process that was never born: a spawn
       failure (ENOENT, EACCES) emits 'error' and may emit no 'exit' at all, and the refusal path
       below awaits this promise before exiting. It hung there instead of refusing. */
    chrome.once('error', res);
  });
};
launch();

/**
 * Shut Chrome down and take its profile with it.
 *
 * The order is the whole fix. This used to be `kill()` then `rmSync()` in one synchronous breath,
 * which reads correctly and leaks on EVERY run: `kill` only queues a signal, so the delete lands
 * while Chrome is still up, and Chrome then re-creates its profile on the way out. Not a
 * crash-only path — a clean `exit 0` sweep of one static route left a directory behind, and the
 * gate's twelve sweeps left twelve.
 *
 * So: signal, WAIT for the process to actually be gone, then delete. SIGKILL after a grace period,
 * because a Chrome wedged mid-screenshot must not hold the gate open. `process.on('exit')` keeps a
 * synchronous best-effort copy for the paths that never get to await anything.
 */
const shutdown = async (proc = chrome, dir = profile, gone = chromeGone) => {
  /* The process/profile are captured as ARGUMENTS, not read from the module bindings inside the
     timer. Those bindings are reassigned by a launch retry (`bringUpChrome`), and the 3s SIGKILL
     below outlives the call that armed it — so reading `chrome` at fire time killed the retry's
     healthy browser 3.0s after it had come up, with `DevTools listening on ...` already in its
     stderr. Caught 2026-08-19 by the retry's own test; a fixed-delay killer that names a mutable is
     a bug waiting for a second caller. */
  proc.kill();
  await Promise.race([
    gone,
    new Promise((res) => setTimeout(res, 3000)).then(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      return gone;
    }),
  ]);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort: a profile on a busy volume can outlive one attempt */
  }
};

const cleanup = () => {
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // best-effort: Chrome may still be flushing its profile as we exit
  }
};
process.on('exit', cleanup);

/** Every deliberate exit goes through here, so the profile is gone before the process is. */
const exit = async (code) => {
  await shutdown();
  process.exit(code);
};

/**
 * The port Chrome actually chose, read from our own profile.
 *
 * `DevToolsActivePort` is written into the user-data-dir once the port is listening; line 1 is the
 * port. Because the file we read is inside the directory we created with `mkdtemp`, the port we
 * connect to cannot belong to anyone else's browser.
 */
let port;
const readActivePort = () => {
  try {
    const first = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    const n = Number(first);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null; /* not written yet */
  }
};

/* 30s, not 10. On a cold CI runner the first Chrome of a session takes appreciably longer to open
   its debugging port than the third does — the 2026-08-13 gate run failed the first three routes
   and then sailed through the remaining nine on the same machine. A timeout tuned on a warm laptop
   is how a suite acquires a "flaky" reputation it does not deserve. */
const START_TIMEOUT_MS = Number(process.env.A11Y_CHROME_TIMEOUT ?? 30000);
/** Launch attempts before the sweep refuses. Two, not more — see `bringUpChrome`. */
const START_ATTEMPTS = Number(process.env.A11Y_CHROME_ATTEMPTS ?? 2);

/**
 * Get a Chrome with a live debugging port, or refuse — RETRYING a failed start.
 *
 * The refusal at the bottom is correct and stays: a sweep that could not drive a browser has
 * measured nothing, and reporting a contrast verdict it never took is the one direction this file's
 * header forbids failing in. What was wrong is that a TRANSIENT start failure became a hard job
 * failure. Observed 2026-08-19 on CI run 32295496057 and again on izzo's #888, both on the FIRST
 * route of the run (`/`), with the remaining eight routes — connected /live included — measuring
 * fine on the same runner seconds later. Both were re-run by hand.
 *
 * TWO attempts, not five. The failure this fixes is a cold first start; a second attempt either
 * works or is telling you something real. A long retry ladder would convert a genuinely broken
 * Chrome — no binary, a missing shared library, a sandbox the runner forbids — from a 30-second red
 * into a multi-minute one, which is a worse gate rather than a safer one.
 *
 * Waiting is bounded by the process being ALIVE as well as by the clock. `chromeGone` already
 * existed here and was never consulted, so a Chrome that died in its first 200ms still burned the
 * full 30s before anyone was told. An exited process will not write `DevToolsActivePort` however
 * long it is given.
 */
const bringUpChrome = async () => {
  const failures = [];
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    const deadline = startedAt + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      port ??= readActivePort();
      if (port) {
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          const found = targets?.find((t) => t.type === 'page');
          if (found) return found;
        } catch {
          /* port file written, socket not accepting connections yet */
        }
      }
      if (chrome.exited) break; // dead: stop waiting for a file it can no longer write
      await new Promise((r) => setTimeout(r, 200));
    }

    const waited = ((Date.now() - startedAt) / 1000).toFixed(1);
    failures.push(
      `attempt ${attempt}: ${
        chrome.exited
          ? `Chrome exited (${chrome.exitInfo}) after ${waited}s`
          : port
            ? `port :${port} was written but never accepted a connection (${waited}s)`
            : `no DevToolsActivePort was written (${waited}s)`
      }`,
    );

    if (attempt < START_ATTEMPTS) {
      /* A FRESH profile for the retry. Reusing the directory of a Chrome that just failed is how one
         bad start poisons the next: a half-written profile is exactly the state Chrome recovers from
         by showing first-run UI or by declining to open the port at all. */
      await shutdown(chrome, profile, chromeGone); // this attempt's process, explicitly
      profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
      port = undefined;
      console.error(
        `contrast-sweep — Chrome did not come up (${failures[failures.length - 1]});` +
          ' retrying once with a fresh profile.',
      );
      launch();
    }
  }

  /* Chrome's own words, last. Without this the operator gets a timeout and nothing to act on, which
     is why every previous occurrence was re-run rather than diagnosed. */
  const stderrTail = chromeErr.trim().split('\n').slice(-6).join('\n    ');
  console.error(
    `contrast-sweep — Chrome (${CHROME}) never opened a debugging port in ${START_ATTEMPTS} attempt(s).` +
      ' Nothing was measured. This is a harness failure, not a contrast result.\n  ' +
      failures.join('\n  ') +
      (stderrTail ? `\n  Chrome said:\n    ${stderrTail}` : '\n  Chrome wrote nothing to stderr.'),
  );
  await exit(2);
};

const page = await bringUpChrome();

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

/**
 * The dedupe key, shared verbatim by all three in-page walkers so their rows join.
 *
 * It used to be `class|ink`, and that was a hole with a cost. Four components render
 * `.lc-card__avatar` with white text on discs painted by DIFFERENT functions — the identity ink
 * (`memberAvatar`, luminance 0.165) and the office fill (`memberColor`, 0.257). Same class, same
 * ink, different PAPER: they collapsed into one row, only the first-encountered one was measured,
 * and its 3.42 was read as the verdict for all four. Three avatars lost their initials in #781/#789
 * on a number that was never about them.
 *
 * So the key carries the background too. `paperSig` walks the same ancestor chain `effBg` composites
 * and records what it finds, stopping at the first opaque layer or gradient — no colour maths, just
 * a signature, because keying only needs elements that paint differently to LOOK different. Any
 * shared utility class in the codebase was one background change away from the same trap.
 */
const PAPER_SIG = /* js */ `
  const paperSig = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        parts.push('img:' + cs.backgroundImage.slice(0, 64));
        break;
      }
      const bc = cs.backgroundColor;
      if (bc && bc !== 'transparent' && !/,\\s*0\\s*\\)$/.test(bc)) {
        parts.push(bc);
        if (!/rgba/.test(bc)) break;
      }
      n = n.parentElement;
    }
    return parts.join('>') || 'root';
  };
  const rowKey = (el, cs) =>
    (el.className.toString() || el.tagName).slice(0, 48) + '|' + cs.color + '|' + paperSig(el);

  /*
   * MEASURE EVERY ROW; collapse only in the REPORT.
   *
   * rowKey decides which rows are "the same situation", and every version of it has been wrong in
   * the same direction. It was class|ink, and four .lc-card__avatar rows on discs painted by
   * different functions collapsed to one — three avatars lost their initials in #781/#789 on a 3.42
   * that was never about them. paperSig closed that by carrying the CSS background.
   *
   * It cannot close the OVERLAP case, and no ancestor-walking signature can: paperSig reads the
   * ancestor chain, so paint a row merely SITS ON TOP OF — a sibling underneath — is invisible to
   * it. Two rows with identical class, ink and ancestors, one on white and one over a dark panel,
   * produce the same key. The walkers kept the first and skipped the rest, so DOCUMENT ORDER decided
   * which one was measured, and a genuinely below-AA row was reported as a clean page whenever a
   * healthy sibling happened to come first (fixtures/dedupe-hides-a-failure.html: same file, same
   * CSS, swap two elements, and the verdict flips between 0 and 1 below AA).
   *
   * The dedupe was there so N identical rows are not measured N times. But the measuring pass is
   * exactly where collapsing is unsafe — it is the pass whose answer can be WRONG rather than merely
   * repetitive. So each row now gets its own key (…#0, …#1) and every one is measured; identical
   * results are folded together when they are printed, which is where repetition was ever the
   * problem. Occurrence order is stable across the three walkers because all three walk the same
   * tree with the same filter, which is what lets their rows still join.
   *
   * Settle detection (KEYS_IN_PAGE) deliberately keeps the plain rowKey: it asks whether the
   * page has stopped changing, not whether every row was covered.
   */
  const occKeyer = () => {
    const seenCount = new Map();
    return (el, cs) => {
      const k = rowKey(el, cs);
      const i = seenCount.get(k) ?? 0;
      seenCount.set(k, i + 1);
      return k + '#' + i;
    };
  };
`;

/* ── wait for the page to STOP CHANGING, rather than for a number of seconds ─────────────────────
 *
 * This was `setTimeout(4000)`, and a fixed wait measures whichever state the machine happened to be
 * showing when it fired. On a prerendered route that is two different pages — the server's HTML,
 * then whatever the app renders once it hydrates and finds no team — and the gate quietly measured
 * either one. On one unchanged build, 2026-08-13: `/board` reported 7 text nodes on an idle laptop
 * and 1 inside a full ten-route run, with `/character-sheet` and `/broadcast` flipping 0 ↔ 1 in the
 * same pair of runs. Nothing was wrong with the page. The sweep was racing it, and a sweep that
 * measures a different page under load still prints "0 below AA" — a green result for a page nobody
 * looked at, which is the one direction this tool must never fail in.
 *
 * The obvious repair — wait for the DOM to go quiet — does not work here, and it is worth saying why
 * rather than leaving it to be rediscovered: **this product's pages never go quiet.** `/live` writes
 * `.lc-ask__clock` and `.lc-clock__time` about four times a second, forever, by design. A mutation
 * watcher on it waits out the whole cap on every run.
 *
 * So settle on the thing actually being measured: the sweep's own KEY SET. Sample the keys, wait,
 * sample again, and call it settled when two consecutive samples match. A ticking clock keeps its
 * class, its ink and its paper, so it does not move the key set; hydration swapping the page,
 * a route transition, a fade still in progress and the firehose's first frame all do. It is the
 * direct statement of the precondition — "the page I am about to measure has stopped changing" —
 * rather than a proxy for it.
 *
 * Stability alone is not sufficient, though, and the first cut of this lost coverage proving it:
 * `/live` held a steady key set at 1.3s and measured 57 rows where the flat 4s wait measured 66,
 * because the work stack arrives on a later frame and a page can be briefly still without being
 * DONE. So the old wait survives as a FLOOR: never measure earlier than 4s.
 *
 * And two matching samples 400ms apart is not enough on top of it, which the same page showed the
 * same afternoon: against a cold daemon `/live` sat at 13 rows for over a second before the room
 * arrived, and a pair of samples inside that plateau reads as settled. The key set must therefore
 * hold STILL FOR A WINDOW (2.5s), not merely twice. A connected `/live` profiled every 500ms goes
 * 0 → 14 → 46 rows within 2.6s and then does not move for the next 36 seconds, so the window costs
 * a couple of seconds and buys the difference between "stopped" and "paused".
 */
const SETTLE_MIN = Number(process.env.A11Y_SETTLE_MIN ?? 4000);
const SETTLE_STEP = Number(process.env.A11Y_SETTLE_STEP ?? 400);
const SETTLE_WINDOW = Number(process.env.A11Y_SETTLE_WINDOW ?? 2500);
/**
 * How long to wait for the page to stop changing before measuring it anyway and saying so.
 *
 * 30s, not 20s (2026-08-19, ADR 285). The cap has to exceed the longest CHOREOGRAPHY on any route
 * being measured, or the sweep gives up on a page that was about to settle and reports MEASURED
 * MID-FLIGHT about a room that does in fact stop. /office-preview under `?still` reaches quiescence
 * at ~22s — measured with an identity-keeping motion probe, and unchanged whether the script is
 * emitted as one burst at mount or staggered over its own 6.7s timeline, so it is the choreography's
 * length and not the emit shape. At 20s the gate missed it by under two seconds and lit the marker
 * on every single run.
 *
 * Raising it is close to free, which is the part worth knowing: a page that settles returns the
 * instant it settles, so this number is only ever PAID by a page that never settles at all. The cost
 * is 10 extra seconds on a route that was going to be reported mid-flight anyway.
 */
const SETTLE_CAP = Number(process.env.A11Y_SETTLE_CAP ?? 30000);
/** The beat between the two stillness snapshots — long enough for a walk step to show, short enough
    to be worth paying twice per run. */
const GEOM_STEP = Number(process.env.A11Y_GEOM_STEP ?? 250);
/**
 * WHERE every row is — the stillness check the key set above cannot make.
 *
 * `KEYS_IN_PAGE` is class|ink|paper and nothing else, so it cannot see MOTION at all: a character
 * walking across the office carries its label and its bubble with it while every key stays
 * identical, and the sweep concludes the page has settled and shoots mid-walk. That blind spot sits
 * underneath most of this gate's flakes — the freeze, the pixel pass and the `moved` guard are all
 * downstream of a precondition that was never actually checked.
 *
 * This is deliberately NOT folded into the polled key set. Measured 2026-08-17: sampling geometry
 * every SETTLE_STEP forced a layout on each poll and starved the office scene's rAF loop badly
 * enough that its canvas never finished painting inside the 20s cap — the sweep then refused the
 * whole route, turning a stillness check into a harness failure. Raising the cap to 60s let it
 * through, which is the proof it was starvation rather than breakage.
 *
 * So geometry is the VERIFICATION, not the signal: the cheap key set settles first, and only then
 * are two snapshots compared. Element boxes rather than text Ranges, for the same cost reason —
 * motion does not need the glyphs' own box, and an element that moved moved.
 */
const GEOM_IN_PAGE = /* js */ `(() => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect();
    out.push(Math.round(r.x) + ',' + Math.round(r.y));
  }
  return out.sort().join('|');
})()`;

const KEYS_IN_PAGE = /* js */ `(() => {
  ${PAPER_SIG}
  const keys = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    keys.push(rowKey(el, cs));
  }
  return document.readyState + '\\n' + keys.sort().join('\\n');
})()`;
/**
 * The key set above has a hole, and it is the hole that let a real failure ship green for a day.
 *
 * `paperSig` walks CSS backgrounds. Text floating over the office WebGL scene has none — `.lc-office`
 * is transparent — so for those rows the key is the same string whether the canvas has painted or
 * not. The settle detector was therefore blind to the one surface it most needed to wait for, and
 * the failure mode is a false PASS: when the floor has not painted by shutter time, the caption is
 * measured against its CSS token and sails through. Measured 2026-08-13/14 at 272d4ad3:
 * `/office-preview` reads 2.83 (#5a4e3f on #a49786) when the floor is there and GREEN when it is
 * not, on identical bytes — main's own push run went success at 01:19 and failure on re-run at
 * 04:13, same run id, same commit.
 *
 * "Wait for the canvas to go quiet" is the wrong repair — the office choreography animates forever,
 * so a pixel-stability key just waits out the cap and then measures mid-flight (tried 2026-08-14;
 * it also let the caption drop out of the key set entirely while the scene evolved). What the
 * measurement actually requires is not a QUIET canvas but a PAINTED one: paint-vs-not is binary,
 * converges within seconds, and is exactly the difference between the red runs and the vacuous
 * green ones.
 *
 * So, after the ordinary settle: any canvas that overlaps text must be non-blank — some pixel
 * variation inside its box, glyphs hidden so ticking text cannot fake it. A canvas still blank past
 * the cap is a HARNESS failure (exit 2, "nothing was measured"), never a page result. A page with
 * no canvas under its text skips all of this.
 */
const CANVAS_UNDER_TEXT = /* js */ `(() => {
  const boxes = [...document.querySelectorAll('canvas')]
    .map((c) => c.getBoundingClientRect())
    .filter((r) => r.width > 1 && r.height > 1);
  if (!boxes.length) return null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const hit = boxes.find(
      (c) => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top,
    );
    if (hit)
      return {
        x: Math.max(0, Math.floor(hit.left)),
        y: Math.max(0, Math.floor(hit.top)),
        width: Math.max(1, Math.ceil(hit.width)),
        height: Math.max(1, Math.ceil(hit.height)),
      };
  }
  return null;
})()`;

/** True once the canvas region shows any pixel variation; null when no canvas sits under text. */
const canvasPainted = async () => {
  const { result } = await send('Runtime.evaluate', {
    expression: CANVAS_UNDER_TEXT,
    returnByValue: true,
  });
  const clip = result.value;
  if (!clip) return null;
  const GLYPHS_OFF = '__a11y_paint_glyphs_off';
  await send('Runtime.evaluate', {
    expression: `(() => {
      if (document.getElementById('${GLYPHS_OFF}')) return;
      const s = document.createElement('style');
      s.id = '${GLYPHS_OFF}';
      s.textContent = '*,*::before,*::after{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important;}';
      document.head.appendChild(s);
    })()`,
  });
  try {
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: 1 },
    });
    const img = decodePng(Buffer.from(shot.data, 'base64'));
    const first = [img.data[0], img.data[1], img.data[2]];
    const stride = img.channels;
    for (let o = stride; o < img.data.length; o += stride) {
      if (
        Math.abs(img.data[o] - first[0]) > 2 ||
        Math.abs(img.data[o + 1] - first[1]) > 2 ||
        Math.abs(img.data[o + 2] - first[2]) > 2
      )
        return true;
    }
    return false;
  } catch {
    return false; /* unreadable is not painted — keep waiting */
  } finally {
    await send('Runtime.evaluate', {
      expression: `document.getElementById('${GLYPHS_OFF}')?.remove()`,
    }).catch(() => {});
  }
};

const settle = await (async () => {
  const t0 = Date.now();
  let prev = null;
  let since = Date.now();
  let painted = null;
  while (Date.now() - t0 < SETTLE_CAP) {
    const { result } = await send('Runtime.evaluate', {
      expression: KEYS_IN_PAGE,
      returnByValue: true,
    });
    const now = typeof result.value === 'string' ? result.value : null;
    if (now === null || now !== prev) since = Date.now();
    if (
      Date.now() - t0 >= SETTLE_MIN &&
      Date.now() - since >= SETTLE_WINDOW &&
      now !== null &&
      now.startsWith('complete')
    ) {
      painted = await canvasPainted();
      if (painted !== false) {
        /* Keys are stable and the canvas has painted — now check the thing the keys cannot see.
           Two geometry snapshots a beat apart: if any row moved, the page was mid-animation with a
           steady key set, so keep waiting rather than shoot. This costs two layouts per run, not one
           per poll, which is what makes it affordable (see GEOM_IN_PAGE). */
        const geom = async () =>
          (await send('Runtime.evaluate', { expression: GEOM_IN_PAGE, returnByValue: true })).result
            .value;
        const g1 = await geom();
        await new Promise((r) => setTimeout(r, GEOM_STEP));
        const g2 = await geom();
        if (g1 === g2) return { how: 'settled', ms: Date.now() - t0, painted };
        since = Date.now(); // something moved — the page is not still, whatever the key set says
      }
      /* Keys are stable but the canvas under the text is still blank — the exact state that
         produced the vacuous greens. Keep waiting; the cap decides how this ends. */
    }
    prev = now;
    await new Promise((r) => setTimeout(r, SETTLE_STEP));
  }
  return { how: 'cap', ms: Date.now() - t0, painted: painted === true };
})();

if (settle.painted === false) {
  console.error(
    `contrast-sweep — a canvas under measurable text never painted within ${SETTLE_CAP}ms.` +
      ' Any ratio taken now would be against a background the reader never sees, so nothing was' +
      ' measured. This is a harness failure, not a contrast result. (This exact state is how' +
      ' /office-preview shipped green while failing AA — see lane 01KZZ7RYW6K9.)',
  );
  await exit(2);
}

/**
 * The whole measurement, run inside the page. Kept as one self-contained function so it can also be
 * pasted straight into a browser console when someone is poking at a surface by hand.
 */
const IN_PAGE = /* js */ `(({ probe, probeHost }) => {
  ${PAPER_SIG}
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
    /* Ink alpha ≈ 0 is invisible text, not low-contrast text. A colour-transition reveal parked at
       rgba(...,0) — the asks strip's "see all" between reel cycles — passes every opacity guard
       (element opacity is 1) and then composites to its own paper: ratio 1.0, filed 2026-08-14 as a
       cream-on-cream token bug that did not exist (lane 01M00M6BYF). Text nobody can perceive has
       no contrast to measure; exclude it and report it, like SKIPPED. */
    if (fg.a < 0.05) return { invisible: true, key, el: id, sample };
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

  /* ── live sweep: every rendered text node, deduped by (class, ink, paper) ── */
  const live = [], skipped = [], invisible = [], rowNodes = [];
  const occKey = occKeyer();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const key = occKey(el, cs);
    /* ONE IDENTITY SOURCE FOR EVERY PASS. This walk runs BEFORE the freeze; the rect, opacity and
       shutter passes run after, and the page keeps mutating in between — /live's asks strip
       re-renders on a 1s setInterval, which no rAF freeze can stop because it is not on rAF.
       Re-walking the tree in each pass and pairing rows by key assumes the Nth row of a key is still
       the same row; with per-occurrence keys that breaks the moment a row is added, removed or
       replaced, and ink from one row joins the pixel under another. That is how avatar rows carrying
       their own disc colour came out white-on-cream at 1.15.
       So the NODES are the identity. Later passes iterate this list instead of re-walking. */
    rowNodes.push({ node, el, key });
    const m = measure(el, text.slice(0, 28), key);
    if (!m) continue;
    if (m.invisible) invisible.push(m); else if (m.skipped) skipped.push(m); else live.push(m);
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

  window.__a11y_rows = rowNodes;
  return {
    url: location.href,
    live: live.sort((a, b) => a.ratio - b.ratio),
    skipped,
    invisible,
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
  ${PAPER_SIG}
  const effOpacity = (el) => {
    let o = 1, n = el;
    while (n && n.nodeType === 1) { o *= parseFloat(getComputedStyle(n).opacity); n = n.parentElement; }
    return o;
  };
  const rects = [], clipped = [], covered = [], gone = [];
  /* The rows the live walk measured, in its order, as the very same nodes — see __a11y_rows there.
     Re-walking here would re-derive identity from tree position, which is exactly what a page that
     re-renders between passes invalidates. */
  for (const { node, el, key } of window.__a11y_rows ?? []) {
    /* Replaced or removed since the live walk: React swapped the node out, so whatever is at its
       old coordinate now belongs to something else. No ink of ours is there to measure. */
    if (!node.isConnected) { gone.push(key); continue; }
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    /* The TEXT's own box, not the element's: an element's bounding rect can include padding that
       sits on different paint than the glyphs do. */
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = [...range.getClientRects()].find((x) => x.width > 0 && x.height > 0);
    range.detach?.();
    if (!r) continue;
    /* OUTSIDE THE CAPTURED PAGE — no pixel exists for this row, so refuse it rather than sample a
       coordinate it never occupied.

       window.scrollX/Y turns a viewport rect into a PAGE rect, and that conversion only holds for
       rows the WINDOW scrolls. /live's stream is a scrolling container inside a fixed-height app:
       its off-screen rows sit at viewport y of -5600 and below while window.scrollY is 0, so the
       page coordinate lands somewhere the element never was and the pixel pass reads whatever paints
       there. Measured on the connected /live fixture: avatar rows carrying their proper disc colour
       inline, reported as white-on-cream at 1.15.

       The bound is the CAPTURED PAGE, not the viewport. The shutter clips to the whole document, so
       below-the-fold rows are captured and must still be measured — testing against the viewport
       cost 11 legitimate rows on / in the first version of this check.

       Today the dedupe usually hides this: only the FIRST row of each key is measured and it tends
       to be the one in view. That makes this cheap now and load-bearing the moment coverage widens.
       Counted and named, never silently dropped. */
    const px = r.x + window.scrollX;
    const py = r.y + window.scrollY;
    const pageW = document.documentElement.scrollWidth;
    const pageH = document.documentElement.scrollHeight;
    if (px + r.width <= 0 || py + r.height <= 0 || px >= pageW || py >= pageH) {
      clipped.push(key);
      continue;
    }
    /* NO PAINT OF ITS OWN AT ITS CENTRE — clipped by a container edge or behind a panel. The row is
       inside the captured page (the bound above) and still has no pixel that belongs to it: the one
       there belongs to whatever covers it, and reading that as this row's paper invents a failure
       for text the reader cannot see either.

       Measured on connected /live: lc-chip__avatar reported 1.15 white-on-cream while the composited
       estimate said 4.9 on its own inline disc — a 3.75 disagreement, the largest on the page. The
       disc is real; its paint does not reach that point.

       The test is the TOPMOST element rather than mere presence in the hit stack: a row under a
       translucent wash is still read through it and its pixel legitimately includes the wash, but a
       row whose own element is not what paints at its centre has nothing of its own to measure.
       Invisible while the dedupe kept one row per key — that row was the one in the clear. */
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      covered.push(key);
      continue;
    }
    rects.push({
      key,
      x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height,
      opacity: effOpacity(el),
      /* Born into the frozen room: connected after the freeze marked the living page's elements, so
         the rAF positioning hand never reached it. See the freeze comment — measured, this strands
         bubbles at (0,0) over the room papers. Absent mark set (pre-freeze callers) = not born. */
      born: !!window.__a11y_atFreeze && !window.__a11y_atFreeze.has(el),
    });
  }
  return {
    rects,
    clipped,
    covered,
    gone,
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
  ${PAPER_SIG}
  const eff =(el) => { let o = 1, n = el; while (n && n.nodeType === 1) { o *= parseFloat(getComputedStyle(n).opacity); n = n.parentElement; } return o; };
  const outv = {};
  /* Same identity source as the rect pass — see __a11y_rows in the live walk. */
  for (const { node, el, key } of window.__a11y_rows ?? []) {
    if (!node.isConnected) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    outv[key] = eff(el);
  }
  return outv;
})()`;

let pixel = null;
let pixelNote = null;
/* The key set either side of the shutter — see the transient exclusion after the pixel pass. */
let keysBeforeShutter = null;
let keysAfterShutter = null;
/** Rows whose line box slid between the rect pass and the shutter — reported, never measured. */
const moved = [];
/** Rows born after the freeze — stranded at (0,0), their geometry is the freeze's artifact. */
const born = [];
try {
  /* Hold the scene still for the length of the capture. Everything that moves on these surfaces
     moves on a rAF loop — the office characters walk, and the speech bubbles are absolutely
     positioned DOM pinned to them — so a no-op `requestAnimationFrame` freezes the room without
     touching a single frame of what is already painted. The canvas keeps its last drawn content,
     which is precisely the thing being sampled. Without this the bubbles slide a few pixels between
     the rect pass and the shutter and the sample lands on a character's body; with it they are
     measurable at all, which is worth more than a frozen millisecond costs. The `moved` guard below
     stays as the check on this working: if anything still slides, it is excluded rather than
     mis-sampled.

     The freeze has a birth hole, and it needs its own guard. Speech bubbles are BORN on timers
     (`showSpeech` is deliberately not on the rAF loop, so the office can speak while it rests), but
     they are POSITIONED by the rAF tick — so a bubble born after the no-op lands is real DOM whose
     placing hand never arrives, and it strands at (0,0). Stationary and at settled opacity 1, it
     walks through the `moved` and fade guards and its text is sampled over whatever paints in the
     page's top-left corner: 6 of 6 verified strandings measured the room papers, not the bubble.
     Key-set differencing cannot see this — rowKey is class|ink|paper, and a stranded bubble collides
     with any healthy sibling born a beat earlier — so the mark has to be per ELEMENT: everything
     connected now, while the room is still the living page's arrangement, goes in a WeakSet, and the
     rect pass reports anything outside it as `born`. Born rows are excluded and counted, exactly
     like `moved`: their geometry was never a property of the page. (Residual: an element born within
     the final frame BEFORE the freeze is marked yet may also have missed its first positioning tick.
     That window is one frame wide; the mark and the override land in the same evaluation to keep it
     that narrow.) */

  /* ── FREEZE TIME, NOT THE SCHEDULER ───────────────────────────────────────────────────────────
   *
   * The old freeze was `requestAnimationFrame = () => 0`, and it dropped every request that arrived
   * after this line ran. Nothing schedules such an element, so it is never placed — and being never
   * placed it never moves, so `moved` is blind; being present at the mark walk, `born` is blind too.
   * That is wanderer's /office-preview failure (`lc-speech__text` 1.8 on #3a4d4d at light=12, two
   * immediate retries green), modelled by `fixtures/request-after-freeze.html` and reproduced live
   * on this build before this change.
   *
   * Draining pending frames BEFORE freezing was built first and removed: it services work already in
   * flight, and a request that has not been made yet is not in flight. It changed no arm of the
   * falsifier and no count on the live route, so it was mechanism without evidence.
   *
   * The freeze wants motion to stop. It does not want LAYOUT WORK to stop, and killing the scheduler
   * conflated the two. So callbacks are still serviced — the element gets placed — but they are
   * serviced with a PINNED timestamp, so anything computing position from the clock sees no time
   * pass and holds still. That is the actual intent, stated directly.
   *
   * Two bounds, because servicing is not free:
   *
   *   - A BUDGET. Loops that reschedule unconditionally (`office-scene/index.ts:926`) would otherwise
   *     run forever. After the budget the override goes silent — the old behaviour, reached as a
   *     backstop rather than as the default.
   *   - A pinned `t0`. An animation that advances by ELAPSED time cannot move. One that advances by
   *     frame COUNT still can, which is what the budget and the surviving `moved` guard are for.
   *
   * Callbacks run on a macrotask, not synchronously: a synchronous call would re-enter the page's
   * own loop inside the assignment expression, and the rect pass that follows must see the result of
   * placement rather than the middle of it. */
  await evalIn(`(() => {
    window.__a11y_atFreeze = new WeakSet();
    for (const el of document.querySelectorAll('*')) window.__a11y_atFreeze.add(el);
    const t0 = performance.now();
    let budget = 240;
    window.__a11y_serviced = 0;
    window.requestAnimationFrame = (cb) => {
      if (budget-- <= 0) return 0;
      setTimeout(() => {
        window.__a11y_serviced++;
        try { cb(t0); } catch { /* a page callback that throws is the page's problem, not the sweep's */ }
      }, 0);
      return 0;
    };
    return true;
  })()`);
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
  keysBeforeShutter = await evalIn(KEYS_IN_PAGE);
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
  keysAfterShutter = await evalIn(KEYS_IN_PAGE);

  /* A THIRD reading, after the shutter. The first two bracket a 300ms window BEFORE the screenshot,
     which catches a fade that is already moving — but not one that starts afterwards. The office
     preview runs a timed choreography that pulls speech bubbles back out of the room, and on CI a
     bubble sat at opacity 1 for both readings and was then halfway gone by the time the pixel was
     taken. It reported 3.16 for text that is nowhere near that bad, which is a false FAILURE — the
     one kind of wrong answer that costs a person a day chasing a colour that was never wrong.
     Requiring stability across the whole window, shutter included, is what actually closes it. */
  const opacity3 = await evalIn(OPACITY_IN_PAGE);

  /* And a second GEOMETRY reading, for the same reason one step further out. The opacity guard
     catches text that faded under the shutter; nothing caught text that MOVED under it. The office
     runs its speech bubbles as absolutely-positioned DOM pinned to characters who walk, so between
     the rect pass and the capture a bubble slides several pixels — and the pixel sampled at the
     recorded rect is then the character's body, not the bubble's paper. That is not a subtle error:
     over four runs of `/office-preview` the same `.lc-speech__text` reported 2.07, 2.29, 3.48 and
     4.28 against papers of #3b5854, #7e4e21, #966e20 and #748b5d — four character colours, none of
     them the paper the words are actually printed on, at a settled opacity of 1 every time.

     A row whose line box moved is therefore excluded and counted, exactly like a row caught
     mid-fade. Its ratio was never a property of the page. */
  const geom2 = await evalIn(RECTS_IN_PAGE);
  const movedKeys = new Set();
  {
    const then = new Map(geom.rects.map((r) => [r.key, r]));
    for (const r of geom2.rects) {
      const was = then.get(r.key);
      if (was && (Math.abs(was.x - r.x) > 1 || Math.abs(was.y - r.y) > 1)) movedKeys.add(r.key);
    }
  }

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
  const invisible = [];
  for (const rc of geom.rects) {
    /* Checked before `moved`: a born row is typically STATIONARY (stranded where it appeared), so
       the movement guard is exactly the one it walks through. */
    if (rc.born) {
      born.push(rc.key.split('|')[0] || '?');
      continue;
    }
    if (movedKeys.has(rc.key)) {
      moved.push(rc.key.split('|')[0] || '?');
      continue;
    }
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
    /* PARKED AT ~ZERO is a third state, and both guards above miss it. A carousel row between
       fade-out and fade-in sits at opacity ≈0.005 — not moving (the readings agree), not exactly 0
       (the walk's `+cs.opacity === 0` check keeps it), so it fell through to measurement with its
       ink composited at α≈0.005 onto its own paper: ratio 1.0, "ink identical to paper". That is
       invisible text reported as a CONTRAST failure — three /live asks-strip rows filed as
       cream-on-cream token bugs on 2026-08-14 until stanley demonstrated the live page renders
       them at ~13:1 (lane 01M00M6BYF; the 1.01/#faf2e5 run was the compositing signature). Text
       nobody can see has no contrast to measure: exclude it and SAY so, exactly like `moved` and
       `unsettled`. Which verdict a cycling row gets — measured legible, or excluded here — depends
       on where the shutter lands in its cycle; both are honest, and neither is a failure. */
    if (rc.opacity < 0.05) {
      invisible.push(rc.key.split('|')[0] || '?');
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
  if (geom.covered?.length)
    notes.push(
      `${geom.covered.length} row(s) have no paint of their own at their centre — clipped by a` +
        ` container edge or behind a panel, so the pixel there belongs to whatever covers them.` +
        ` Excluded, not measured` +
        ` (${[...new Set(geom.covered.map((k) => k.split('|')[0] || '?'))].slice(0, 6).join(', ')})`,
    );
  if (geom.clipped?.length)
    notes.push(
      `${geom.clipped.length} row(s) sit OUTSIDE THE CAPTURED PAGE — a scroll container holds them` +
        ` where no pixel exists, so sampling one would read whatever paints at a coordinate they` +
        ` never occupied. Excluded, not measured` +
        ` (${[...new Set(geom.clipped.map((k) => k.split('|')[0] || '?'))].slice(0, 6).join(', ')})`,
    );
  {
    const names = [...invisible, ...(out.invisible ?? []).map((r) => r.el)];
    if (names.length)
      notes.push(
        `${names.length} element(s) were INVISIBLE for the whole window (effective opacity or ink` +
          ` alpha < 0.05) — invisible text has no contrast to measure; excluded, not passed:` +
          ` ${[...new Set(names)].join(', ')}`,
      );
  }
  if (faded.length)
    notes.push(
      `${faded.length} element(s) are permanently translucent — their ink is composited at that` +
        ` alpha rather than read at full strength: ${[...new Set(faded)].join(', ')}`,
    );
  if (moved.length)
    notes.push(
      `${moved.length} element(s) MOVED between the rect pass and the shutter, so the pixel under` +
        ` their recorded line box is no longer what is behind them — excluded, not measured:` +
        ` ${[...new Set(moved)].join(', ')}`,
    );
  if (born.length)
    notes.push(
      `${born.length} element(s) were BORN after the scene froze — the rAF positioning hand never` +
        ` reached them, so their line box is the freeze's artifact, not the page's — excluded, not` +
        ` measured: ${[...new Set(born)].join(', ')}`,
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

/* ── drop rows the page grew or discarded while we were measuring ────────────────────────────────
 *
 * The settle above guarantees the page had stopped changing when the walk started. It cannot
 * guarantee the page stays that way: `/office-preview` speaks a new line every few seconds, and a
 * speech bubble that appears between the walk and the shutter is measured MID-CROSS-FADE, ink and
 * paper both part-composited over the room. That produced a `.lc-speech__text` row of 4.49 against a
 * 4.5 threshold — a failing gate on a bubble that reads 6-plus once it lands, and only in runs where
 * the timing lined up. The three opacity readings do not catch it, because a 160ms reduced-motion
 * fade can begin and end inside the gaps between them.
 *
 * So the key set is read on both sides of the shutter, and a row whose key appears on exactly ONE
 * side is dropped with a count. It is the same discipline as the mid-animation exclusion, applied to
 * arrival and departure rather than to movement: an element that existed for part of a measurement
 * was never a state of this page, and a number taken from it is a frame.
 *
 * Both readings are taken around the SHUTTER rather than compared against the walk. The walk runs
 * before the rect pass finishes every animation, so a row's key legitimately changes across that
 * boundary; a row missing from both sides is simply a pre-settle row carrying the composited
 * estimate, and dropping those would delete most of the page (measured: 45 rows → 0).
 *
 * And the comparison drops the paper, coming down to class + ink, because PRESENCE is what is being
 * tested. An infinite CSS animation cannot be finished and cannot be waited out — the asks rail's
 * loud tier breathes forever — so its background differs between any two readings, and keying
 * presence on the full row key threw out six perfectly measurable `.lc-ask__btn` rows a run.
 */
/** class|ink — the element's identity, without the paper that a live background keeps repainting. */
const idOf = (k) => k.split('|').slice(0, 2).join('|');
const asSet = (s) => (typeof s === 'string' ? new Set(s.split('\n').slice(1).map(idOf)) : null);
const before = asSet(keysBeforeShutter);
const after = asSet(keysAfterShutter);
let transient = [];
if (before?.size && after?.size) {
  // A row without a key (rescued from SKIPPED) cannot be presence-checked; it stays.
  const churned = (r) => r.key != null && before.has(idOf(r.key)) !== after.has(idOf(r.key));
  transient = out.live.filter(churned);
  if (transient.length) out.live = out.live.filter((r) => !churned(r));
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

  /* A page that never stopped changing was measured mid-flight, and every number below is a frame
     rather than a state. Louder than a footnote for that reason. */
  if (settle.how !== 'settled') {
    console.log(
      `\n! the measurable text never stopped changing within ${SETTLE_CAP}ms — this page was` +
        ' measured mid-flight, so treat every row as a frame rather than a state.',
    );
  }

  /* Excluded, never silent — the same rule the EXEMPT section runs under. If this grows, the page is
     churning enough that a single sweep of it is not measuring much. */
  if (transient.length) {
    console.log(
      `\n! ${transient.length} element(s) came or went DURING the measurement and were excluded —` +
        ` they were part-composited, not settled: ${[...new Set(transient.map((r) => r.el))].join(', ')}`,
    );
  }

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
  writeFileSync(
    JSON_OUT,
    JSON.stringify({ ...out, settle, transient, liveFails, probeFails }, null, 2),
  );
  if (!QUIET) console.log(`\nwrote ${JSON_OUT}`);
}

// Only the live sweep gates. The probe pass is advisory by construction.
await exit(liveFails.length ? 1 : 0);
