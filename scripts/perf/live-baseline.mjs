#!/usr/bin/env node
/**
 * Web UI performance baseline harness (no deps — native fetch + WebSocket + headless Chrome).
 *
 * Measures, for a given page (default /live):
 *  - network: request count, transferred bytes, per-type breakdown
 *  - paint: FCP, LCP, DOMContentLoaded, load
 *  - main thread: long tasks (count, total ms) during load + settle
 *  - runtime: FPS over a sampling window, JS heap, DOM node count
 *  - live-data: WebSocket frames received during the window; optionally the
 *    latency from an injected event (--send-cmd) to its WS frame arriving
 *
 * Usage:
 *   node scripts/perf/live-baseline.mjs [url] [--window 10000] [--send-cmd '<shell cmd>'] [--json out.json]
 *
 * Baseline doc: docs/perf/web-live-baseline.md
 */
import { spawn, exec } from 'node:child_process';
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
const WINDOW_MS = Number(flag('window') ?? 10_000);
const SEND_CMD = flag('send-cmd');
const JSON_OUT = flag('json');

const port = 9333;
const profile = mkdtempSync(join(tmpdir(), 'live-baseline-'));
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

// Wait for the DevTools endpoint, then attach to the blank page target.
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
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('Chrome DevTools endpoint never came up');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
const eventHandlers = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message));
    else res(m.result);
  } else if (m.method && eventHandlers.has(m.method)) {
    eventHandlers.get(m.method)(m.params);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const on = (method, fn) => eventHandlers.set(method, fn);

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Performance.enable');

// Collect observer data from inside the page before any app code runs.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__perf = { lcp: 0, fcp: 0, longTasks: [], cls: 0 };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__perf.lcp = Math.max(window.__perf.lcp, e.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__perf.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__perf.longTasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  `,
});

// Network accounting.
const net = { requests: 0, bytes: 0, byType: {} };
const reqType = new Map();
on('Network.responseReceived', (p) => {
  reqType.set(p.requestId, p.type ?? 'Other');
});
on('Network.loadingFinished', (p) => {
  net.requests += 1;
  net.bytes += p.encodedDataLength;
  const t = reqType.get(p.requestId) ?? 'Other';
  net.byType[t] = (net.byType[t] ?? 0) + p.encodedDataLength;
});

// App WebSocket frames (live data channel).
const wsFrames = [];
// Wall-clock arrival (handler fires promptly); CDP's own timestamp is monotonic, not epoch.
on('Network.webSocketFrameReceived', (p) => {
  wsFrames.push({ t: Date.now(), len: (p.response?.payloadData ?? '').length });
});

const loaded = new Promise((res) => on('Page.loadEventFired', res));
const navStart = Date.now();
await send('Page.navigate', { url });
await loaded;
await new Promise((r) => setTimeout(r, 2000)); // settle: lazy chunks, WS connect, first data

const evalJson = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

const loadMetrics = await evalJson(`(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource');
  return JSON.parse(JSON.stringify({
    ttfb: nav.responseStart,
    domContentLoaded: nav.domContentLoadedEventEnd,
    load: nav.loadEventEnd,
    fcp: window.__perf.fcp,
    lcp: window.__perf.lcp,
    cls: window.__perf.cls,
    longTasksLoad: window.__perf.longTasks.length,
    longTasksLoadMs: window.__perf.longTasks.reduce((a, t) => a + t.dur, 0),
    resourceCount: res.length,
    domNodes: document.querySelectorAll('*').length,
  }));
})()`);

// Runtime window: FPS + long tasks while the live scene animates.
const preTasks = await evalJson('window.__perf.longTasks.length');
const wsFramesBefore = wsFrames.length;
let sendResult = null;
const fpsPromise = evalJson(
  `(async () => {
  const frames = [];
  let last = performance.now();
  const end = last + ${WINDOW_MS};
  while (performance.now() < end) {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    frames.push(now - last);
    last = now;
  }
  frames.sort((a, b) => a - b);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  return {
    frames: frames.length,
    avgMs: avg,
    fps: 1000 / avg,
    p95Ms: frames[Math.floor(frames.length * 0.95)],
    worstMs: frames[frames.length - 1],
  };
})()`,
  true,
);

if (SEND_CMD) {
  await new Promise((r) => setTimeout(r, 1500));
  const sentAt = Date.now();
  await new Promise((res, rej) => exec(SEND_CMD, (err) => (err ? rej(err) : res())));
  const sentDone = Date.now();
  // First app WS frame after the command STARTED — the frame often lands while the CLI is still
  // doing its post-send inbox reads, so correlating from completion would miss it. The reported
  // latency therefore includes the sender-CLI startup; `cmdMs` bounds that overhead.
  const deadline = Date.now() + 10_000;
  let frame;
  while (Date.now() < deadline) {
    frame = wsFrames.find((f) => f.t > sentAt);
    if (frame) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  sendResult = frame
    ? { cmdMs: sentDone - sentAt, cmdStartToFrameMs: Math.round(frame.t - sentAt) }
    : { cmdMs: sentDone - sentAt, cmdStartToFrameMs: null };
}

const fps = await fpsPromise;
const postTasks = await evalJson('window.__perf.longTasks.length');
const perfMetrics = await send('Performance.getMetrics');
const metric = (n) => perfMetrics.metrics.find((m) => m.name === n)?.value ?? 0;

const result = {
  url,
  at: new Date(navStart).toISOString(),
  windowMs: WINDOW_MS,
  load: loadMetrics,
  network: net,
  runtime: {
    ...fps,
    longTasksInWindow: postTasks - preTasks,
    jsHeapUsedMB: metric('JSHeapUsedSize') / 1048576,
    domNodes: metric('Nodes'),
    wsFramesInWindow: wsFrames.length - wsFramesBefore,
  },
  liveDataLatency: sendResult,
};

const ms = (v) => `${Math.round(v)}ms`;
console.log(`\n== ${url} @ ${result.at} ==`);
console.log(
  `load:    TTFB ${ms(loadMetrics.ttfb)} · FCP ${ms(loadMetrics.fcp)} · LCP ${ms(loadMetrics.lcp)} · DCL ${ms(loadMetrics.domContentLoaded)} · load ${ms(loadMetrics.load)} · CLS ${loadMetrics.cls.toFixed(3)}`,
);
console.log(
  `network: ${net.requests} requests · ${(net.bytes / 1024).toFixed(0)}KB transferred · ${JSON.stringify(Object.fromEntries(Object.entries(net.byType).map(([k, v]) => [k, `${(v / 1024).toFixed(0)}KB`])))}`,
);
console.log(
  `main:    ${loadMetrics.longTasksLoad} long tasks (${ms(loadMetrics.longTasksLoadMs)}) during load · ${result.runtime.longTasksInWindow} during ${WINDOW_MS / 1000}s window`,
);
console.log(
  `runtime: ${fps.fps.toFixed(1)} fps (avg ${fps.avgMs.toFixed(1)}ms, p95 ${fps.p95Ms.toFixed(1)}ms, worst ${fps.worstMs.toFixed(0)}ms) · heap ${result.runtime.jsHeapUsedMB.toFixed(1)}MB · ${result.runtime.domNodes} DOM nodes · ${result.runtime.wsFramesInWindow} WS frames`,
);
if (sendResult)
  console.log(
    `live-data: cmd ${sendResult.cmdMs}ms · cmd-start→WS-frame ${sendResult.cmdStartToFrameMs === null ? 'NOT SEEN in 10s' : sendResult.cmdStartToFrameMs + 'ms'}`,
  );

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
ws.close();
process.exit(0);
