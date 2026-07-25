import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

/**
 * `musterd broadcast` — ADR 157 Increment 2: stream the office with no GUI in the loop.
 *
 * Headless Chromium loads `/broadcast?team=…` (the Inc 1 render mode: always-animating office, fixed
 * 1920×1080 at DPR 1, observer-only), a CDP screencast delivers frames as the scene changes, a
 * constant-frame-rate pump re-clocks them (screencast is change-driven; a rested office legitimately
 * emits nothing, but an encoder needs a steady beat), and ffmpeg encodes to either a local file
 * (`--out`, the no-key proof mode) or RTMPS (`--twitch` / `--rtmp`).
 *
 * The stream key is a secret: it comes from `MUSTERD_STREAM_KEY` or the macOS Keychain (service
 * `musterd-stream-key`), never from a flag (argv leaks into shell history and `ps`) and never from
 * musterd config (committed and exported to git, ADR 058).
 *
 * Foreground process, Ctrl-C to stop — the `serve` posture. LaunchAgent supervision is a later
 * increment if unattended streaming ever wants it.
 */

const OptionsSchema = z.object({
  team: z.string().min(1),
  server: z.string().url().default('http://127.0.0.1:4849'),
  fps: z.number().int().min(1).max(60).default(30),
  bitrate: z
    .string()
    .regex(/^\d+k$/, 'bitrate looks like "4500k"')
    .default('4500k'),
  /** Seconds; 0 = run until Ctrl-C. Bounded so a typo can't fill a disk with a "10s" test capture. */
  duration: z.number().int().min(0).max(86_400).default(0),
  out: z.string().min(1).optional(),
  rtmp: z.string().min(1).optional(),
  twitch: z.boolean().default(false),
  encoder: z.enum(['videotoolbox', 'libx264']),
});
export type BroadcastOptions = z.infer<typeof OptionsSchema>;

export function parseOptions(
  flags: Record<string, string | boolean>,
  platform: NodeJS.Platform = process.platform,
): BroadcastOptions {
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
  const num = (k: string) => {
    const raw = str(k);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new CliError(`--${k} needs a number, got "${raw}"`, 2);
    return n;
  };
  const opts = OptionsSchema.parse({
    team: str('team') ?? '',
    server: str('server'),
    fps: num('fps'),
    bitrate: str('bitrate'),
    duration: num('duration'),
    out: str('out'),
    rtmp: str('rtmp'),
    twitch: flags['twitch'] === true,
    // VideoToolbox is the whole point on the laptop (hardware encode); libx264 elsewhere.
    encoder: str('encoder') ?? (platform === 'darwin' ? 'videotoolbox' : 'libx264'),
  });
  const sinks = [opts.out, opts.rtmp, opts.twitch ? 'twitch' : undefined].filter(Boolean).length;
  if (sinks !== 1) {
    throw new CliError(
      'pick exactly one sink: --out <file.mp4> (local proof), --twitch, or --rtmp <url>',
      2,
    );
  }
  return opts;
}

/** The Inc 1 page this captures — observer-only by construction (ADR 157), so a stream can never
 * attach a phantom human presence (ADR 155). */
export function broadcastUrl(server: string, team: string): string {
  return `${server.replace(/\/$/, '')}/broadcast?team=${encodeURIComponent(team)}`;
}

/**
 * Resolve the RTMPS destination. `--rtmp` is taken verbatim (any provider); `--twitch` composes the
 * ingest URL from the secret key. The key resolver is injected so tests never touch the Keychain.
 */
export async function resolveSink(
  opts: BroadcastOptions,
  keychain: (service: string) => Promise<string | null>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ kind: 'file'; target: string } | { kind: 'rtmp'; target: string }> {
  if (opts.out) return { kind: 'file', target: opts.out };
  if (opts.rtmp) return { kind: 'rtmp', target: opts.rtmp };
  const key = env['MUSTERD_STREAM_KEY']?.trim() || (await keychain('musterd-stream-key'));
  if (!key) {
    throw new CliError(
      'no stream key — set MUSTERD_STREAM_KEY or add a Keychain item: ' +
        'security add-generic-password -s musterd-stream-key -a musterd -w <key>',
      2,
    );
  }
  return { kind: 'rtmp', target: `rtmps://live.twitch.tv/app/${key}` };
}

/** macOS Keychain lookup (`security find-generic-password -w`); null on any miss/error. */
export function keychainLookup(service: string): Promise<string | null> {
  return new Promise((res) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], (err, stdout) => {
      res(err ? null : stdout.trim() || null);
    });
  });
}

/**
 * The ffmpeg invocation, as pure data. Input 0 is the image frame pipe (JPEG — see the screencast
 * format note below) at the pump's constant rate;
 * input 1 is silent audio — RTMP ingests (Twitch included) reject a video-only stream, and muxing
 * silence is cheaper than explaining that in a runbook. Keyframe every 2s (`-g 2*fps`), the spacing
 * Twitch asks for. File mode keeps the same encode so a local proof exercises the streaming path.
 */
export function ffmpegArgs(
  opts: BroadcastOptions,
  sink: { kind: 'file' | 'rtmp'; target: string },
): string[] {
  const vcodec = opts.encoder === 'videotoolbox' ? 'h264_videotoolbox' : 'libx264';
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    // The delivery truth, printed every 10s regardless of loglevel: frame count, fps, and `speed=`.
    // speed < 1.0x means the pipeline is falling behind real time (the viewer-buffering failure
    // mode); 1.0x with viewers still stalling exonerates this process entirely.
    '-stats',
    '-stats_period',
    '10',
    // video: image frames on stdin (codec sniffed per-frame), already constant-rate via the pump
    '-f',
    'image2pipe',
    '-framerate',
    String(opts.fps),
    '-i',
    '-',
    // audio: silence (ingests require an audio track)
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=stereo',
    '-c:v',
    vcodec,
    '-b:v',
    opts.bitrate,
    '-maxrate',
    opts.bitrate,
    '-bufsize',
    opts.bitrate.replace(/k$/, '') + 'k',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(opts.fps * 2),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    // End when the *video* pipe ends. `anullsrc` is an infinite source, so without this ffmpeg keeps
    // muxing silence after stdin closes and never exits — which made the graceful stop unreachable:
    // every Ctrl-C fell through to the 5s force-kill, and a file capture lost its moov atom because
    // the container was never finalized. The stop path was only ever as graceful as this flag.
    '-shortest',
  ];
  if (opts.duration > 0) args.push('-t', String(opts.duration));
  if (sink.kind === 'file') args.push('-movflags', '+faststart', '-y', sink.target);
  else args.push('-f', 'flv', sink.target);
  return args;
}

/**
 * The constant-frame-rate pump. CDP screencast frames arrive only when pixels change; the encoder
 * needs one every 1000/fps ms regardless, so the pump re-emits the latest frame on a clock — a
 * rested office becomes a perfectly still (and perfectly valid) stream.
 *
 * **Drift-compensating**, and this is load-bearing: image2pipe synthesizes timestamps from frame
 * *count*, so every tick the interval timer fires late (Node under load fires late and never makes
 * up) is a frame the video timeline falls behind wall clock. A stream 5% short of frames plays 5%
 * slower than real time — the viewer's buffer drains and the player stalls on a fast connection
 * (the first live Twitch run found exactly this). So `tick` doesn't emit one frame per call; it
 * emits however many frames wall clock says are owed since the first one. Pure: the clock is
 * injected, tests drive it by hand.
 */
export function makeFramePump(
  write: (png: Buffer) => void,
  fps: number,
  now: () => number = () => performance.now(),
): {
  frame: (png: Buffer) => void;
  tick: () => number;
} {
  let latest: Buffer | null = null;
  let start = -1; // wall-clock ms of the first emitted frame — the timeline's epoch
  let emitted = 0;
  /** Late by more than this → a suspend/SIGSTOP-sized gap. Re-anchor instead of fast-forwarding
   * thousands of catch-up frames through the encoder in one burst. */
  const MAX_CATCHUP = fps; // 1 second
  return {
    frame: (png) => {
      latest = png;
    },
    /** Emit every frame owed since the epoch; returns how many went out (0 while nothing has
     * arrived yet — don't encode a black lie). */
    tick: () => {
      if (!latest) return 0;
      if (start < 0) start = now();
      const owed = Math.floor(((now() - start) * fps) / 1000) + 1 - emitted;
      if (owed <= 0) return 0;
      const n = Math.min(owed, MAX_CATCHUP);
      if (owed > MAX_CATCHUP) {
        // The process itself was paused (laptop lid, debugger, SIGSTOP) — skip the dead air:
        // re-anchor the epoch so the (emitted + n)th frame is the one due exactly now.
        start = now() - (emitted + n - 1) * (1000 / fps);
      }
      for (let i = 0; i < n; i++) write(latest);
      emitted += n;
      return n;
    },
  };
}

/**
 * Best-effort, synchronous kill of a child's whole process group. Both children spawn
 * `detached: true`, so each leads its own group and `kill(-pid)` reaches it plus anything it
 * spawned. This is the backstop for the ungraceful stop: when the parent dies to an external
 * signal, `cleanup()`'s polite stdin-close never happens — and an orphaned ffmpeg keeps holding
 * the RTMP connection and encoding forever (observed on the first real stream; every restart
 * needed a manual second pkill). Synchronous because one call site is `process.on('exit')`,
 * where nothing async runs and throwing is forbidden.
 */
export function killGroup(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>,
  signal: NodeJS.Signals = 'SIGTERM',
  kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
): void {
  // Already reaped (exitCode/signalCode set) or never spawned → nothing to do. The guard matters:
  // signaling a dead group is pid-reuse roulette against some innocent future process.
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal); // not a group leader after all (or the group is gone) — direct shot
    } catch {
      /* already gone */
    }
  }
}

/**
 * How much unwritten video may pile up in ffmpeg's stdin before we call the encoder wedged.
 *
 * The pump deliberately writes without waiting for drain — dropping a frame permanently slows the
 * `image2pipe` timeline, which is the stall the pump exists to prevent. That trade is right while
 * ffmpeg is *briefly* behind. It is catastrophic when ffmpeg stops draining altogether (a wedged
 * RTMPS ingest): at ~181 KB/frame × 30 fps the queue grows ~5.4 MB/s with no ceiling, and hours of
 * that is what took the event loop down — the heap into GC thrash, and with the loop no longer
 * turning, `SIGCHLD` went unreaped (children stuck `<defunct>`), the unref'd force-stop timer never
 * fired, and even `SIGTERM` was swallowed, because a listener means it is delivered *through* the
 * loop. Only `SIGKILL` remained.
 *
 * 64 MB is ~12 s of video at the measured frame size. Past that the encoder is not behind, it is
 * gone — and a stream twelve seconds in arrears is worthless anyway, so the honest move is to stop
 * feeding it and end the run loudly rather than buffer toward a hang.
 */
export const STALL_BYTES = 64 * 1024 * 1024;

/** The bit of a writable stream this policy needs — so a test can stand one up without a real pipe. */
export interface EncoderPipe {
  writable: boolean;
  writableLength: number;
  write: (chunk: Buffer) => unknown;
}

/**
 * The pump's write policy, as a function rather than a closure buried in the command — so the rule
 * that ends the hang is the same code a test can drive.
 *
 * Deliberately still does **not** wait for drain: dropping a frame permanently slows the
 * `image2pipe` timeline, which is the stall the pump exists to prevent, so riding a brief backlog is
 * correct. What it adds is a ceiling on "brief".
 */
export function makeEncoderFeed(
  stdin: EncoderPipe | null | undefined,
  onStall: () => void,
): (frame: Buffer) => void {
  return (frame) => {
    if (!stdin?.writable) return;
    if (stdin.writableLength > STALL_BYTES) {
      onStall();
      return;
    }
    stdin.write(frame);
  };
}

/** How long a single CDP call may go unanswered before we stop waiting on a socket that may be dead. */
const CDP_TIMEOUT_MS = 15_000;

/** Profile directories older than this are from runs that are long over — see `sweepStaleProfiles`. */
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;

const PROFILE_PREFIX = 'musterd-broadcast-';

/**
 * Delete Chrome profile directories left behind by earlier runs.
 *
 * Every run gets its own `mkdtemp` profile, and `cleanup()` removes it — but only on the path where
 * the command returns normally. Every forced stop calls `process.exit()`, and an external `SIGKILL`
 * skips JS entirely, so those runs leak. They are not small: each is ~150 MB of Chrome's own model
 * store, component cache and Safe Browsing database, re-downloaded because each run starts from a
 * virgin profile. The incident that prompted this left 23 of them, 837 MB.
 *
 * Sweeping at startup is what recovers ground already lost — a fix that only stops *new* leaks would
 * never clear the existing pile. Age-gated so it can never touch a concurrent run's live profile.
 */
export function sweepStaleProfiles(
  dir: string = tmpdir(),
  ttlMs: number = PROFILE_TTL_MS,
  now: number = Date.now(),
): number {
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
}

const CHROME_DEFAULT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function chromeArgs(debugPort: number, profileDir: string): string[] {
  return [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-extensions',
    // The Inc 1 contract: a 1920×1080 window at DPR 1 captures the stage 1:1.
    '--window-size=1920,1080',
    '--force-device-scale-factor=1',
    'about:blank',
  ];
}

/** Minimal CDP client over the DevTools WebSocket — the live-baseline.mjs pattern, typed. */
interface Cdp {
  send: (method: string, params?: object) => Promise<Record<string, unknown>>;
  on: (method: string, fn: (params: Record<string, unknown>) => void) => void;
  close: () => void;
}

async function connectCdp(debugPort: number): Promise<Cdp> {
  let targets: Array<{ type: string; webSocketDebuggerUrl: string }> | undefined;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      targets = (await res.json()) as typeof targets;
      if (targets?.some((t) => t.type === 'page')) break;
    } catch {
      /* devtools endpoint not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) throw new CliError('headless Chrome never exposed a page target', 1);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new CliError('could not attach to the Chrome DevTools socket', 1));
  });
  let msgId = 0;
  const pending = new Map<
    number,
    { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void }
  >();
  const handlers = new Map<string, (params: Record<string, unknown>) => void>();
  /**
   * Fail everything in flight. Without this, a `pending` entry could only ever be settled by a reply
   * — so if Chrome died mid-handshake, every `await cdp.send(...)` parked forever. That is why
   * `waitBroadcastReady`'s "30s timeout" was not a timeout at all: its deadline is only tested
   * between settled awaits, and none of them ever settled.
   */
  const failAll = (err: Error): void => {
    for (const p of [...pending.values()]) p.rej(err);
    pending.clear();
  };
  ws.onclose = () => failAll(new CliError('the Chrome DevTools socket closed', 1));
  ws.onerror = () => failAll(new CliError('the Chrome DevTools socket errored', 1));
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as {
      id?: number;
      error?: { message: string };
      result?: Record<string, unknown>;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message));
      else p.res(m.result ?? {});
    } else if (m.method && handlers.has(m.method)) {
      handlers.get(m.method)!(m.params ?? {});
    }
  };
  return {
    // Every call is time-boxed. A socket that goes quiet without closing (Chrome swapped out, the
    // compositor wedged) is indistinguishable from a slow reply until a deadline says otherwise.
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++msgId;
        const timer = setTimeout(() => {
          if (pending.delete(id)) rej(new CliError(`Chrome did not answer ${method} in time`, 1));
        }, CDP_TIMEOUT_MS);
        pending.set(id, {
          res: (v) => {
            clearTimeout(timer);
            res(v);
          },
          rej: (e) => {
            clearTimeout(timer);
            rej(e);
          },
        });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    on: (method, fn) => void handlers.set(method, fn),
    close: () => ws.close(),
  };
}

/** Poll the Inc 1 readiness probe: "the page loaded" and "the page is streaming a real team" are
 * different states, and only the second is safe to start encoding on. */
async function waitBroadcastReady(cdp: Cdp, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'window.__broadcastReady === true',
      returnByValue: true,
    });
    if ((r['result'] as { value?: unknown } | undefined)?.value === true) return;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new CliError(
    'the broadcast page never reported ready — is the daemon serving /broadcast, and does the team exist?',
    1,
  );
}

export async function broadcastCommand(parsed: Parsed): Promise<number> {
  const opts = parseOptions(parsed.flags);
  if (!opts.team) throw new CliError('which team? — pass --team <slug>', 2);
  const sink = await resolveSink(opts, keychainLookup);
  const url = broadcastUrl(opts.server, opts.team);

  const chromeBin = process.env['CHROME_BIN'] ?? CHROME_DEFAULT;
  const debugPort = 9222 + Math.floor(Math.random() * 500);
  // Clear other runs' leavings before adding our own — see `sweepStaleProfiles`.
  const swept = sweepStaleProfiles();
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));

  process.stdout.write(`${theme.accent('broadcast')} — ${opts.team}  ${theme.meta(url)}\n`);
  process.stdout.write(
    theme.meta(
      `${sink.kind === 'file' ? `capturing to ${sink.target}` : 'streaming (rtmps)'} · ` +
        `${opts.fps}fps · ${opts.bitrate} · ${opts.encoder}` +
        (opts.duration ? ` · ${opts.duration}s` : ' · Ctrl-C to stop'),
    ) + '\n',
  );
  if (swept > 0) {
    process.stdout.write(theme.meta(`swept ${swept} stale capture profile(s)`) + '\n');
  }

  // ── Stop-path hardening ─────────────────────────────────────────────────────────────────────
  // Handlers are installed BEFORE the children are spawned, and that ordering is the fix: the old
  // wiring registered them only once streaming was live, so a kill during the (up to 30s) CDP
  // connect / ready wait hit Node's default handler and orphaned both children — and a preempted
  // parent (this box encodes video while it works) widens any spawn→register gap to tens of ms.
  // Registered first, a signal either arrives before the spawns (nothing exists to orphan) or
  // after (always caught). Default signal death runs no `exit` listeners, so no sweep can repair
  // a missed signal after the fact. Three tiers:
  //   · graceful (first SIGINT/SIGTERM/SIGHUP while live): close ffmpeg's stdin and let it
  //     finalize the container — a hard kill leaves a file capture without a moov atom, and the
  //     `exit` listener on ffmpeg below turns its departure into a normal return.
  //   · forced (second signal, or any signal before frames flow): nothing worth finalizing —
  //     group-kill both children and go.
  //   · sweep (`process.on('exit')`): whatever path led here, no child survives the parent.
  //     Synchronous by necessity; a no-op when the graceful path already reaped them.
  // (The closures below reference `chrome`/`ffmpeg` before their declaration — safe: handlers
  // only ever run on an event-loop turn, and the spawns happen in this same synchronous block.)
  let pumpTimer: NodeJS.Timeout | undefined;
  let live = false; // flips when the pump starts feeding ffmpeg
  let stopping = false;
  const forceStop = (code: number): never => {
    killGroup(ffmpeg, 'SIGKILL');
    killGroup(chrome, 'SIGKILL');
    process.exit(code);
  };
  const gracefulStop = () => {
    if (pumpTimer) clearInterval(pumpTimer);
    ffmpeg.stdin?.end(); // let ffmpeg finalize the container (moov atom in file mode)
    // If ffmpeg never exits (wedged RTMP socket), the stop must still stop. unref'd: it never
    // holds the process open, it only fires if something else still is.
    setTimeout(() => forceStop(1), 5000).unref();
  };
  /**
   * The encoder has stopped draining. Stop feeding it and end the run — do **not** wait politely for
   * ffmpeg to finalize, because a wedged sink is precisely the case where it never will, and the
   * graceful path's 5s backstop is `unref()`'d, so it only fires if the loop is still healthy. Going
   * straight to the force path is what guarantees this terminates.
   */
  let stalled = false;
  const onStall = () => {
    if (stalled) return;
    stalled = true;
    process.stderr.write(
      `${theme.err('✗')} encoder stopped draining (>${Math.round(STALL_BYTES / 1024 / 1024)}MB queued) — ending the stream\n`,
    );
    forceStop(1);
  };
  const onSignal = (sig: NodeJS.Signals) => {
    if (stopping || !live) forceStop(sig === 'SIGINT' ? 130 : 1);
    stopping = true;
    process.stdout.write(theme.meta(`\nstopping (${sig}) — again to force`) + '\n');
    gracefulStop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('exit', () => {
    killGroup(ffmpeg);
    killGroup(chrome);
    // The profile has to be removed here, not only in `cleanup()`. Every forced stop reaches
    // `process.exit()` without unwinding the `try`, so `cleanup()` never ran on exactly the paths
    // that leak. Synchronous by necessity — nothing async runs in an exit handler.
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Chrome may still hold a handle; the next run's startup sweep will get it */
    }
  });

  // `detached: true` makes each child its own process-group leader, which is what lets the
  // stop path kill *everything* it spawned with one group signal — see killGroup.
  const chrome = spawn(chromeBin, chromeArgs(debugPort, profile), {
    stdio: 'ignore',
    detached: true,
  });
  const ffmpeg: ChildProcess = spawn('ffmpeg', ffmpegArgs(opts, sink), {
    stdio: ['pipe', 'inherit', 'inherit'],
    detached: true,
  });
  // ffmpeg closes its stdin the moment `-t <duration>` is satisfied (or its sink dies) — a pump tick
  // racing that close is an EPIPE, which on a Socket is an *emitted* error that would crash the
  // process. It's the normal end-of-stream handshake here, not a failure: swallow it and let the
  // `exit` handler below report ffmpeg's real verdict.
  ffmpeg.stdin?.on('error', () => {});

  /**
   * Both children's exits are captured **here**, next to the spawns — not at the point we finally
   * want to await them.
   *
   * The old code registered `ffmpeg.once('exit')` after `connectCdp` (≤10s of polling) and
   * `waitBroadcastReady` (≤30s), so a child that died inside that window emitted `exit` with nobody
   * listening. `once` does not replay: the promise then never resolved, the `finally` never ran, and
   * the command hung holding a profile directory. A bad stream key does exactly that.
   */
  const ffmpegExit = new Promise<number>((resolve) => {
    ffmpeg.once('exit', (code) => {
      if (pumpTimer) clearInterval(pumpTimer); // encoder gone — stop feeding a closed pipe
      resolve(code ?? 1);
    });
  });
  const chromeExit = new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
  /** Either child dying *before* the stream is live is terminal, and must beat the startup awaits. */
  const diedDuringStartup = new Promise<never>((_, reject) => {
    void ffmpegExit.then((code) => {
      if (!live) {
        reject(
          new CliError(
            `ffmpeg exited (code ${code}) before the first frame — check the sink is reachable`,
            1,
          ),
        );
      }
    });
    void chromeExit.then(() => {
      if (!live) reject(new CliError('headless Chrome exited before the page was ready', 1));
    });
  });
  // A losing racer's rejection is still "handled" by the race, but if startup wins outright this
  // promise may reject later with nobody looking — claim it so Node doesn't call it unhandled.
  diedDuringStartup.catch(() => {});

  let exitCode = 0;
  let cdp: Cdp | undefined;
  const cleanup = () => {
    if (pumpTimer) clearInterval(pumpTimer);
    ffmpeg.stdin?.end();
    cdp?.close(); // an open DevTools socket is a live handle; nothing else closes it
    killGroup(chrome);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* best-effort: Chrome may still be flushing its profile */
    }
  };

  try {
    // Race the whole startup sequence against either child dying: every await below can otherwise
    // outlive the thing it is waiting for.
    await Promise.race([
      (async () => {
        cdp = await connectCdp(debugPort);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        // `--window-size` is the *window*; even headless, the viewport comes up short of it (~88px of
        // phantom window chrome → 1920×992 frames). The emulation override pins the viewport itself, so
        // the screencast delivers exactly the 1920×1080 stage.
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1920,
          height: 1080,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await cdp.send('Page.navigate', { url });
        await waitBroadcastReady(cdp, 30_000);
      })(),
      diedDuringStartup,
    ]);
    const page = cdp!;

    const pump = makeFramePump(makeEncoderFeed(ffmpeg.stdin, onStall), opts.fps);
    page.on('Page.screencastFrame', (p) => {
      pump.frame(Buffer.from(String(p['data']), 'base64'));
      void page.send('Page.screencastFrameAck', { sessionId: p['sessionId'] });
    });
    // JPEG, and this is load-bearing: Chrome encodes screencast frames on the compositor thread,
    // and 1080p PNG is so expensive there that delivery measured 4.7fps — a slideshow the pump then
    // padded with duplicates (the residual stutter after the cadence fixes). JPEG@85 measured
    // 35.3fps at ~181KB/frame on the same scene. Visually lossless here (flat colors, no gradients
    // worth 9× the bytes), and ffmpeg's image2pipe sniffs the codec per-frame, so nothing else
    // changes.
    await page.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 85,
      maxWidth: 1920,
      maxHeight: 1080,
      everyNthFrame: 1,
    });
    // Tick at 2× frame cadence: the pump owes frames by wall clock, so the timer only needs to
    // fire *often enough* — late ticks emit catch-up frames instead of losing them.
    pumpTimer = setInterval(() => pump.tick(), Math.max(1, Math.round(500 / opts.fps)));
    live = true; // signals now stop gracefully — there are frames worth finalizing

    process.stdout.write(`${theme.ok('◉ live')}\n`);

    // The frame source dying MID-stream is terminal — flush what we have and report it. After the
    // encoder has already exited this also fires from cleanup's own group-kill; not an error.
    void chromeExit.then(() => {
      if (ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) return;
      process.stderr.write(`${theme.err('✗')} headless Chrome exited\n`);
      if (!stopping) {
        stopping = true;
        gracefulStop();
      }
    });
    // Run until ffmpeg exits — its -t duration, its sink failing, a signal ending its stdin, or the
    // stall watchdog above. Every road converges here.
    exitCode = await ffmpegExit;
  } finally {
    cleanup();
  }
  if (exitCode === 0) process.stdout.write(`${theme.ok('✓')} broadcast ended cleanly\n`);
  return exitCode === 0 ? 0 : 1;
}
