#!/usr/bin/env node
/**
 * PIXEL GATE for the office scene's sprite cache (spec 2026-09-17).
 *
 * The cache is only allowed to exist if the room it paints is the room that was there before. That
 * claim cannot be made in vitest: the render tests run under `environment: 'node'` against a
 * recording context, so they can prove the cached path emits the same OPS in the same ORDER — which
 * is the right unit-level invariant and caught a real ordering fault — but nothing rasterizes there,
 * so they cannot see a sprite whose box clips a shadow, or whose antialiasing lands on a different
 * sub-pixel grid. Only a real rasterizer can.
 *
 * So: load `/office-preview` in headless Chrome, and for each state in the matrix call
 * `__office.spriteParity()` — which renders the CURRENT scene state twice into two offscreen
 * canvases, once direct and once through a fresh sprite cache, and compares `getImageData` byte for
 * byte. Both renders read the same poses, the same clock and the same lighting synchronously, so
 * the scene's own animation is not a confound: any difference is the cache's doing.
 *
 * Usage:
 *   node scripts/perf/scene-pixel-check.mjs [baseUrl] [--json out.json] [--quiet]
 *
 * Exit 0 = byte-equal across every state. Exit 1 = a difference (the report names the first
 * differing pixel and the delta histogram). Exit 2 = the harness could not measure (no Chrome, no
 * dev server, no scene) — never reported as a pass, because "0 differences" gets believed.
 *
 * WHAT "DIFFERENT" MEANS HERE. The comparison is on PREMULTIPLIED colour plus alpha, not on the raw
 * bytes `getImageData` returns. Those bytes are unpremultiplied, and unpremultiplying is unstable as
 * alpha goes to zero: at alpha 1/255 recovering the colour multiplies one 8-bit step by 255. The
 * first run of this gate reported maxDelta 255 on 161k pixels, with the deltas clustered on 255,
 * 128, 85, 64, 51, 42 — which is 255/n for small n, i.e. that arithmetic and nothing else. Those
 * pixels are invisible twice over. Premultiplied is what a viewer actually gets.
 *
 * Two numbers are then reported, because they mean different things:
 *   • `differing`      — any difference at all, including one step. A sprite composites where the
 *                        direct path does not, so every antialiased edge can land one step out. The
 *                        office floor is drawn plank by plank, so "every edge" is a lot of the room.
 *   • `beyondRounding` — pixels more than one step out: what a second composite cannot explain.
 *
 * The gate FAILS on any difference. Whether a difference that no eye can find is acceptable is a
 * person's call, not this script's, and both numbers plus the delta histogram are printed so that
 * call can be made on evidence rather than on a feeling.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const BASE =
  args.find((a) => !a.startsWith('--')) ?? process.env.SCENE_BASE ?? 'http://127.0.0.1:3000';
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const JSON_OUT = flag('json');
const QUIET = args.includes('--quiet');

/**
 * The state matrix. Each row is a room the cache has to reproduce exactly, and each was chosen
 * because it exercises an input that a sprite KEY has to carry — get the key wrong and two of these
 * share a raster, which is the failure mode a sprite cache dies of and the one that is silent.
 *
 *   light      → the window glass, the sky wash and the beams (the background key), and the lamps
 *   n          → how many desks are occupied, and therefore how many distinct workstation states
 *   idle       → working vs idle screens and docks at the same desks
 *   offline    → owned, bodiless desks: the afterglow alpha that ages, and the amber glint
 *   theme      → the resolved palette (`data-theme` on <html>, read per bake)
 */
const MATRIX = [
  { name: 'day-1', q: 'still&light=12&n=1' },
  { name: 'day-8', q: 'still&light=12&n=8' },
  { name: 'day-24', q: 'still&light=12' },
  { name: 'night-24', q: 'still&light=23' },
  { name: 'night-1', q: 'still&light=23&n=1' },
  { name: 'dusk-8', q: 'still&light=18&n=8' },
  { name: 'all-idle', q: 'still&light=12&idle=all' },
  { name: 'owned-desks', q: 'still&light=12&n=8&offline=Fen,Gus,Ivy' },
  { name: 'light-theme', q: 'still&light=12&n=8', theme: 'light' },
  { name: 'dusk-theme', q: 'still&light=12&n=8', theme: 'dusk' },
];

const PROFILE_PREFIX = 'scene-pixel-check-';
const PROFILE_TTL_MS = 60 * 60 * 1000;
/* Recover ground already lost, age-gated so a concurrent run's profile is never touched — the same
   pile the a11y sweep grew (400 directories, 240 MB) before it swept its own. */
const sweepStaleProfiles = (dir = tmpdir(), ttlMs = PROFILE_TTL_MS, now = Date.now()) => {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(PROFILE_PREFIX)) continue;
      const full = join(dir, name);
      try {
        if (now - statSync(full).mtimeMs < ttlMs) continue;
        rmSync(full, { recursive: true, force: true });
      } catch {
        /* raced with another run, or not ours — skip */
      }
    }
  } catch {
    /* no temp dir to read */
  }
};
sweepStaleProfiles();

let profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
let chromeErr = '';
const CHROME_ARGS = [
  '--headless=new',
  /* Port 0, read back from OUR profile's DevToolsActivePort: a hardcoded port is shared state
     between every run on the machine, and this laptop runs many worktrees at once. */
  '--remote-debugging-port=0',
  '--no-first-run',
  '--disable-extensions',
  '--window-size=1600,1000',
  'about:blank',
];
const chrome = spawn(CHROME, [...CHROME_ARGS, `--user-data-dir=${profile}`], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
chrome.stderr?.on('data', (d) => {
  if (chromeErr.length < 4096) chromeErr += String(d);
});
chrome.exited = false;
chrome.on('error', (e) => {
  chromeErr += `${e.message}\n`;
  chrome.exited = true;
  chrome.exitInfo = e.code ? `spawn ${e.code}` : 'spawn failed';
});
const chromeGone = new Promise((res) => {
  chrome.once('exit', (code, signal) => {
    chrome.exited = true;
    chrome.exitInfo = signal ? `signal ${signal}` : `code ${code}`;
    res();
  });
  chrome.once('error', res);
});

const cleanup = async () => {
  try {
    chrome.kill();
  } catch {
    /* already gone */
  }
  await Promise.race([chromeGone, new Promise((r) => setTimeout(r, 2000))]);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};
const die = async (code, msg) => {
  console.error(msg);
  await cleanup();
  process.exit(code);
};

const START_TIMEOUT_MS = Number(process.env.SCENE_CHROME_TIMEOUT ?? 30000);
let port;
const readActivePort = () => {
  try {
    const first = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    const n = Number(first);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};
const deadline = Date.now() + START_TIMEOUT_MS;
let target = null;
while (Date.now() < deadline && !target) {
  port ??= readActivePort();
  if (port) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = targets?.find((t) => t.type === 'page') ?? null;
    } catch {
      /* port written, socket not up yet */
    }
  }
  if (!target) {
    if (chrome.exited) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}
if (!target) {
  await die(
    2,
    `scene-pixel-check — Chrome (${CHROME}) never opened a debugging port. Nothing was measured.` +
      (chrome.exited ? ` Chrome exited (${chrome.exitInfo}).` : '') +
      (chromeErr.trim()
        ? `\n  Chrome said:\n    ${chromeErr.trim().split('\n').slice(-6).join('\n    ')}`
        : ''),
  );
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
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

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails)
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};

/** Wait until the scene has mounted and painted at least one frame. */
const waitForScene = async (ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ready = await evaluate('!!(window.__office && window.__office.stats().draws > 0)').catch(
      () => false,
    );
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const results = [];
let harnessFailure = null;
for (const state of MATRIX) {
  const url = `${BASE}/office-preview?${state.q}`;
  await send('Page.navigate', { url });
  /* The theme cascades from <html data-theme>, and the scene resolves the palette per paint — so
     setting it after load and before the parity call is enough; no reload needed. */
  if (state.theme) {
    // Navigation is async; wait for the scene first, then set the theme and let a frame pass.
    if (!(await waitForScene())) {
      harnessFailure = `${state.name}: the office never mounted at ${url}`;
      break;
    }
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(state.theme)}`);
    await new Promise((r) => setTimeout(r, 400));
  } else if (!(await waitForScene())) {
    harnessFailure = `${state.name}: the office never mounted at ${url}`;
    break;
  }
  /* The room settles: `?still` plays its script once and stops, so give it a moment to arrive at
     the state we are comparing rather than catching it mid-walk. Parity itself is synchronous, so a
     moving room is still a fair comparison — but a settled one is easier to go and look at. */
  await new Promise((r) => setTimeout(r, 1200));
  const parity = await evaluate('JSON.stringify(window.__office.spriteParity())').catch((e) => {
    harnessFailure = `${state.name}: spriteParity() threw — ${e.message}`;
    return null;
  });
  if (!parity) break;
  results.push({ state: state.name, url, ...JSON.parse(parity) });
}

const line = (r) => {
  const pct = ((r.differing / r.total) * 100).toFixed(4);
  const hist = r.histogram
    .map((n, d) => (n > 0 ? `${d}:${n}` : null))
    .filter(Boolean)
    .slice(0, 8)
    .join(' ');
  return (
    `${r.equal ? 'EQUAL  ' : 'DIFFERS'} ${r.state.padEnd(13)} ` +
    `differing ${String(r.differing).padStart(9)} / ${r.total} (${pct}%)  beyond1 ${String(r.beyondRounding).padStart(6)}  maxDelta ${r.maxDelta}` +
    (hist ? `  deltas ${hist}` : '') +
    (r.worst
      ? `  worst (${r.worst.x},${r.worst.y}) Δ${r.maxDelta} direct [${r.worst.direct}] sprite [${r.worst.sprite}]`
      : '')
  );
};

/** A coarse map of WHERE the differences are — one character per `cell`-square block of the stage. */
const heat = (r) => {
  const mark = (n) => (n === 0 ? '.' : n < 10 ? ':' : n < 100 ? 'o' : n < 1000 ? 'O' : '#');
  const rows = [];
  for (let y = 0; y < r.gridH; y++) {
    rows.push(
      '    ' +
        r.grid
          .slice(y * r.gridW, (y + 1) * r.gridW)
          .map(mark)
          .join(''),
    );
  }
  return rows.join('\n');
};

if (!QUIET) {
  console.log(
    `scene-pixel-check — ${BASE}/office-preview, ${results.length}/${MATRIX.length} states\n`,
  );
  for (const r of results) {
    console.log(line(r));
    if (!r.equal) console.log(heat(r));
  }
}
if (JSON_OUT)
  writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, results, harnessFailure }, null, 2));

if (harnessFailure) {
  await die(
    2,
    `\nscene-pixel-check — HARNESS FAILURE, nothing was measured for the remaining states:\n  ${harnessFailure}\n` +
      `  Is the dev server up at ${BASE}? (pnpm -F @musterd/web dev)`,
  );
}
const failed = results.filter((r) => !r.equal);
if (failed.length) {
  const beyond = failed.reduce((n, r) => n + r.beyondRounding, 0);
  const worst = failed.reduce((m, r) => Math.max(m, r.maxDelta), 0);
  console.error(
    `\nscene-pixel-check — ${failed.length}/${results.length} state(s) DIFFER.` +
      ` ${beyond} pixel(s) across the matrix are more than one step out, worst ${worst}.\n` +
      '  One step is what a second composite costs and cannot be removed; more than one step is\n' +
      '  antialiasing coverage at an edge, or a real fault. `__office.spriteCrops(x, y, r)` returns\n' +
      '  magnified PNGs of both renders at a pixel — look before concluding either way.\n' +
      '  This gate stays red until a person decides the difference is acceptable.',
  );
  await cleanup();
  process.exit(1);
}
console.log(`\nscene-pixel-check — byte-equal across ${results.length} state(s).`);
await cleanup();
process.exit(0);
