#!/usr/bin/env node
/**
 * Ambient density harness (E1b) — how many idle beats does the room actually DELIVER per minute?
 *
 * The E1 spec (docs/superpowers/specs/2026-08-25-seeded-idle-life-design.md §3) states density as
 * beats per idle minute. That is not the fire probability: a slot can fire, pick a beat, and the
 * browser can still decline to play it (the chosen member is mid-walk, the lounge is full, the pet
 * is already up). `AMBIENT_FIRE_P` is what the lattice DECIDES; this script measures what the room
 * DOES, which is the only number the reading in §3 is about.
 *
 * Why the distinction is load-bearing here, and not pedantry (stanley, on #1060): the pre-E1a
 * scheduler fell THROUGH on a failed category inside one firing — pet declined, so it tried a pair;
 * pair declined, so it moved a member. The slot lattice deliberately does not, because a fallthrough
 * is per-browser state deciding WHICH beat plays, which is the one thing E1 exists to prevent. So
 * E1a's delivered rate sits BELOW the old scheduler's at an identical fire probability, and an E1b
 * that measures itself against the E1a floor would quietly ship a room calmer than the one nick
 * signed off on. The baseline is the old delivered rate; the decline loss is what the E1b curve has
 * to buy back on top of the occupancy raise.
 *
 * Fixture: `/office-preview?quiet` — the pool seated, no looping choreography, ambient scheduler
 * live (`?still` would stand the scheduler down, `?quiet` does not). `?n=<count>` sizes the room,
 * which is the occupancy axis. Wall minutes are idle minutes on this fixture: nothing but ambient
 * life ever makes the room busy, so `played / minutes` is beats per idle minute directly.
 *
 * Usage:
 *   node scripts/perf/ambient-density.mjs [url] [--minutes 30] [--json out.json]
 *   node scripts/perf/ambient-density.mjs 'http://127.0.0.1:5173/office-preview?quiet&n=8' --minutes 40
 *
 * Baseline doc: docs/perf/web-live-baseline.md
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:5173/office-preview?quiet';
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const MINUTES = Number(flag('minutes') ?? 30);
const JSON_OUT = flag('json');
const PORT = Number(flag('port') ?? 9366);

const profile = mkdtempSync(join(tmpdir(), 'ambient-density-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1440,900',
    'about:blank',
  ],
  // Own process group, so cleanup can take the renderer and GPU children down with the parent:
  // `chrome.kill()` signals only the top process, and headless Chrome's helpers outlive it.
  { stdio: 'ignore', detached: true },
);
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try {
    // Negative pid = the whole group. SIGKILL, not SIGTERM: this is a throwaway profile with
    // nothing to flush, and a graceful stop we cannot await is a stop we cannot guarantee.
    process.kill(-chrome.pid, 'SIGKILL');
  } catch {
    // already gone
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // best-effort: Chrome may still be flushing its profile as we exit
  }
};
// `exit` alone is not enough — it does not fire on a signal, which is exactly how a 30-minute run
// ends when the caller gives up. Without the signal hooks Chrome is reparented to PID 1 and spins
// its render loop forever; several arms running concurrently is enough to stall the machine.
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}
process.on('uncaughtException', (err) => {
  cleanup();
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});

let targets;
for (let i = 0; i < 50; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
const handlers = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message));
    else res(m.result);
  } else if (m.method && handlers.has(m.method)) handlers.get(m.method)(m.params);
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJson = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
const loaded = new Promise((res) => handlers.set('Page.loadEventFired', res));
await send('Page.navigate', { url });
await loaded;

// The scene is a lazy chunk mounted in an effect: wait for the handle rather than a fixed sleep.
let ready = false;
for (let i = 0; i < 100; i++) {
  ready = await evalJson('typeof window.__office?.ambientLog === "function"');
  if (ready) break;
  await new Promise((r) => setTimeout(r, 200));
}
if (!ready) throw new Error('window.__office.ambientLog never appeared — wrong route, or a stale build');

// Occupancy is the independent variable, so record it from the fixture rather than the caller's
// intent: `?n` sizes the pool, but away/offline/dnd members are seated too and the ambient pool is
// only the present desk members.
const occupancy = await evalJson('new URLSearchParams(location.search).get("n")');

// The in-page log is capped at 200 entries, so poll and merge by slot rather than reading once at
// the end: a long window at a raised probability can overflow it.
const seen = new Map();
const started = Date.now();
const endAt = started + MINUTES * 60_000;
process.stdout.write(`ambient-density: ${url}\n  window ${MINUTES}min, polling every 15s\n`);
while (Date.now() < endAt) {
  await new Promise((r) => setTimeout(r, 15_000));
  const log = await evalJson('JSON.parse(JSON.stringify(window.__office.ambientLog()))');
  for (const e of log) seen.set(e.slot, e);
  process.stdout.write(
    `  ${Math.round((Date.now() - started) / 60_000)}min: ${seen.size} fires, ` +
      `${[...seen.values()].filter((e) => e.played).length} played\n`,
  );
}
const elapsedMs = Date.now() - started;

const entries = [...seen.values()].sort((a, b) => a.slot - b.slot);
const played = entries.filter((e) => e.played);
const byKind = {};
for (const e of entries) {
  const k = (byKind[e.kind] ??= { fired: 0, played: 0 });
  k.fired += 1;
  if (e.played) k.played += 1;
}
const minutes = elapsedMs / 60_000;
// Slots that elapsed in the window, from the lattice itself — the denominator the fire probability
// is defined against. Fires below this ratio mean slots were skipped before the roll: a busy room
// (an errand still running) never reaches `decideAmbient` at all.
const slotsElapsed = Math.round(elapsedMs / 20_000);
const out = {
  url,
  minutes: Number(minutes.toFixed(2)),
  occupancy,
  slotsElapsed,
  fired: entries.length,
  played: played.length,
  firesPerMin: Number((entries.length / minutes).toFixed(2)),
  /* THE E1b NUMBER: beats the viewer actually saw, per idle minute. */
  beatsPerIdleMin: Number((played.length / minutes).toFixed(2)),
  observedFireRate: Number((entries.length / slotsElapsed).toFixed(3)),
  playRate: entries.length ? Number((played.length / entries.length).toFixed(3)) : null,
  byKind,
};
process.stdout.write(`\n${JSON.stringify(out, null, 2)}\n`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
process.exit(0);
