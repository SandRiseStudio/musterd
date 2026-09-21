#!/usr/bin/env node
/**
 * ONE headless Chrome, brought up safely — the plumbing under every a11y sweep.
 *
 * Extracted from `contrast-sweep.mjs` on 2026-09-21 (lane 01M32HG5GJ) when a SECOND sweep needed
 * it. Nothing here is new; every line below was written one incident at a time, and the comments
 * are the incidents. That is exactly why it was extracted rather than copied: a second copy starts
 * identical and drifts, and the half that drifts is the half nobody re-learns until it costs
 * another green-run-on-the-wrong-page. The failures it already knows about, in order:
 *
 *   • a hardcoded debugging port, so sweep B drove sweep A's browser and filed a GREEN report for
 *     a page nobody looked at (the one direction an a11y tool must never fail in);
 *   • 400 profile directories / 240 MB left in tmp, because every run starts from a virgin profile;
 *   • `kill()` then `rmSync()` in one breath, which leaks a profile on EVERY clean run;
 *   • a 3s SIGKILL timer that read a mutable binding and killed the RETRY's healthy browser;
 *   • a cold first start on CI reported as a hard failure rather than retried once;
 *   • `stdio: 'ignore'`, which threw away the only artifact that says why a start failed.
 *
 * Usage:
 *
 *     const { send, exit } = await openChromePage({ tool: 'target-size-sweep' });
 *     await send('Page.navigate', { url });
 *     …
 *     await exit(0);
 *
 * `exit(code)` is the ONLY way out that takes the profile with it. Exit 2 is reserved, by
 * convention shared with `contrast-sweep.mjs`, for "the harness failed and nothing was measured" —
 * never for a verdict about the page. `openChromePage` refuses with 2 itself when Chrome will not
 * come up, so a caller that got a session has a browser.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Start Chrome, connect to its own page target, and hand back a CDP `send`.
 *
 * @param tool          this sweep's name — it prefixes the profile directory AND every refusal, so
 *                      an operator reading CI knows which gate refused.
 * @param verdictNoun   what this tool takes verdicts about ("contrast", "target size"), used only
 *                      in the harness-failure refusal to say what was NOT concluded.
 * @param windowSize    Chrome's window, as `W,H`. A sweep that measures layout wants the viewport
 *                      it is judging; one that measures colour does not care.
 */
export const openChromePage = async ({
  tool,
  verdictNoun = 'measurement',
  windowSize = '1440,900',
} = {}) => {
  const PROFILE_PREFIX = `${tool}-`;
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
    `--window-size=${windowSize}`,
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
          `${tool} — Chrome did not come up (${failures[failures.length - 1]});` +
            ' retrying once with a fresh profile.',
        );
        launch();
      }
    }

    /* Chrome's own words, last. Without this the operator gets a timeout and nothing to act on, which
       is why every previous occurrence was re-run rather than diagnosed. */
    const stderrTail = chromeErr.trim().split('\n').slice(-6).join('\n    ');
    console.error(
      `${tool} — Chrome (${CHROME}) never opened a debugging port in ${START_ATTEMPTS} attempt(s).` +
        ` Nothing was measured. This is a harness failure, not a ${verdictNoun} result.\n  ` +
        failures.join('\n  ') +
        (stderrTail
          ? `\n  Chrome said:\n    ${stderrTail}`
          : '\n  Chrome wrote nothing to stderr.'),
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
  /* Both domains, here rather than in each caller: a sweep that forgets `Runtime.enable` gets
     evaluations that silently never resolve, which reads as a hung page rather than a missing
     line. */
  await send('Page.enable');
  await send('Runtime.enable');

  return { send, exit, page, chromeBinary: CHROME };
};
