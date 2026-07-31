import { spawn, execFile, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Parsed } from '../args.js';
import { configPath } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { cpuOfTree, cpuTotal, makePerfRecorder } from './broadcast-perf.js';

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
  /** The capture stage. 1080p is the ADR 157 contract and stays the default; 720p exists because
   * the hosting spec's run D showed the render is serial and single-thread-bound — a quarter of the
   * pixels is the one lever that changes what hardware can hold the stream. */
  resolution: z.enum(['720p', '1080p']).default('1080p'),
});
export type BroadcastOptions = z.infer<typeof OptionsSchema>;

/** Stage pixels for a resolution rung (16:9 exactly — the scene bakes to the canvas it gets). */
export function stagePixels(resolution: BroadcastOptions['resolution']): {
  width: number;
  height: number;
} {
  const height = resolution === '720p' ? 720 : 1080;
  return { width: (height * 16) / 9, height };
}

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
    resolution: str('resolution'),
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

/**
 * Assumed compositor rate, in Hz. Chrome's screencast fires per *composited* frame, not on a clock,
 * so this is the only way to reason about `everyNthFrame` — and it is an assumption, not a reading.
 *
 * The assumption is a platform fact, not a constant. On macOS (GPU compositing) the office
 * composites at a true 60Hz — delivery landed on exactly `fps` every measured run. On the Linux
 * boxes this ships to there is no GPU: compositing is software on one serial thread and measured
 * 20Hz at 1080p / ~26Hz at 720p (Fly performance-4x, 2026-07-27). Deriving `everyNthFrame` from 60
 * there threw away half the frames the box could actually produce: 720p30 delivered 14fps under
 * `everyNthFrame: 2` and 26.5fps under `1`, at identical render cost. Assuming 30 keeps the
 * skip-derivation honest on hardware that never had 60 composited frames to skip.
 */
export function compositorHz(platform: NodeJS.Platform = process.platform): number {
  return platform === 'darwin' ? 60 : 30;
}

/**
 * How many composited frames Chrome should skip between screencast deliveries.
 *
 * **This is where Chrome's cost actually lives.** Each delivered frame is JPEG-encoded on the
 * compositor thread (see the `startScreencast` call for why JPEG and not PNG), so delivering ~60/s to
 * feed a 30fps encode pays for the encode twice and throws half away. Measured 2026-07-27 over three
 * 40s captures on a live-room fixture:
 *
 * | arm                          | delivered/s | chrome % | unique frames /1200 |
 * | ---------------------------- | ----------- | -------- | ------------------- |
 * | everyNthFrame 1              | 57.5        | 139.8    | 995                 |
 * | everyNthFrame 2              | 30.0        | 90.7     | 971                 |
 *
 * −35% of Chrome for −2.4% of unique frames. (The same table killed the draw-rate cap that was tried
 * first: capping the canvas saved 3.9 points and cost 77 unique frames. The painting was never the
 * expense.)
 *
 * Clamped to ≥1: an fps at or above the compositor rate must not skip frames, and a nonsense fps must
 * not produce 0 (which CDP reads as "every frame" anyway, but by accident rather than by intent).
 */
export function screencastEveryNthFrame(fps: number, hz = compositorHz()): number {
  if (!Number.isFinite(fps) || fps <= 0) return 1;
  return Math.max(1, Math.floor(hz / fps));
}

/** The Inc 1 page this captures — observer-only by construction (ADR 157), so a stream can never
 * attach a phantom human presence (ADR 155). */
export function broadcastUrl(
  server: string,
  team: string,
  resolution: BroadcastOptions['resolution'] = '1080p',
  fps: number = 30,
): string {
  // `h` sizes the page's stage itself. Without it a 720p window would CSS-scale a 1080p render and
  // keep paying the full raster cost — the exact cost the 720p rung exists to remove.
  // `fps` tells the office how fast to paint so canvas draws match the encode (capture-perf draw-rate
  // cap). Absent on older captures → page defaults to 30.
  const h = resolution === '1080p' ? '' : `&h=${stagePixels(resolution).height}`;
  const f = Number.isFinite(fps) && fps > 0 ? `&fps=${Math.round(fps)}` : '';
  return `${server.replace(/\/$/, '')}/broadcast?team=${encodeURIComponent(team)}${h}${f}`;
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
 * **256 MB, ~47 s of video at the measured ~181 KB/frame.** Sized from a real capture, not a guess,
 * and the measurement was a surprise worth writing down: on a *loaded* machine this pipeline does not
 * sustain 30 fps at all. Instrumenting a live run showed the queue climbing 7.9 → 23.6 → 38.0 →
 * 55.8 MB in twelve seconds — ~4.7 MB/s, which is essentially the entire input rate, i.e. ffmpeg was
 * draining almost nothing. That is the `speed < 1x` condition ADR 157 already names as the thing to
 * watch, and it is the most likely reading of what actually killed the 11-hour stream.
 *
 * So the ceiling is deliberately generous rather than tight: a full monorepo build running alongside
 * must not end a stream, and 12 s of slack (the first value tried) ended one within seconds. What it
 * still guarantees is the thing that matters — the queue is *bounded*, so the process can no longer
 * buffer its way into a hung event loop. Past the mark the encoder is not behind, it is gone, and a
 * stream three quarters of a minute in arrears is not worth saving.
 */
export const STALL_BYTES = 256 * 1024 * 1024;

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

/** How often the capture-perf recorder samples the pipeline, when it is switched on at all. */
const PERF_SAMPLE_MS = 1000;

/**
 * Wire up capture-perf recording, or return `undefined` — the normal case.
 *
 * Switched on only by `MUSTERD_BROADCAST_PERF=<path.jsonl>`, so a stream nobody is measuring pays
 * nothing: no CDP round-trips, no `ps` fork per second, no file handle. That is the `?beat=`
 * precedent — instrumentation ships, inert, rather than living on a branch that rots.
 *
 * Every probe is best-effort. A measurement harness must never be the reason a live stream dies, so
 * a failed office eval or a `ps` that races a process exit degrades that field to `undefined` and the
 * capture carries on.
 */
function startPerfRecording(
  page: Cdp,
  ffmpeg: ChildProcess,
  chrome: ChildProcess,
  emitted: () => number,
): { frame: (bytes: number) => void; tick: () => Promise<void> } | undefined {
  const out = process.env['MUSTERD_BROADCAST_PERF'];
  if (!out) return undefined;
  const started = Date.now();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, ''); // truncate: one file per capture, never an append of two runs' numbers
  process.stdout.write(theme.meta(`  perf → ${out}\n`));
  return makePerfRecorder({
    queueBytes: () => ffmpeg.stdin?.writableLength ?? 0,
    emitted,
    office: async () => {
      try {
        const r = await page.send('Runtime.evaluate', {
          expression: 'JSON.stringify(window.__office?.stats?.() ?? null)',
          returnByValue: true,
        });
        const raw = (r['result'] as { value?: unknown } | undefined)?.value;
        const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return undefined;
        const { ticks, draws } = parsed as { ticks?: unknown; draws?: unknown };
        if (typeof ticks !== 'number' || typeof draws !== 'number') return undefined;
        return { ticks, draws };
      } catch {
        return undefined; // scene not mounted yet, or the socket went away mid-capture
      }
    },
    cpu: async () => {
      try {
        const ps = await new Promise<string>((resolve, reject) => {
          execFile('ps', ['-Ao', 'pid,ppid,pcpu'], (err, stdout) =>
            err ? reject(err) : resolve(stdout),
          );
        });
        // Chrome and ffmpeg are spawned by this process, so `pipeline` (the tree from our own pid)
        // already contains both — they are not peers of it. Everything else on the box is `other`,
        // and that is what decides whether the run was contaminated.
        const pipeline = cpuOfTree(ps, process.pid);
        return {
          chrome: chrome.pid ? cpuOfTree(ps, chrome.pid) : 0,
          ffmpeg: ffmpeg.pid ? cpuOfTree(ps, ffmpeg.pid) : 0,
          pipeline,
          other: Math.max(0, cpuTotal(ps) - pipeline),
        };
      } catch {
        return { chrome: 0, ffmpeg: 0, pipeline: 0, other: 0 };
      }
    },
    load1: () => loadavg()[0] ?? 0,
    now: () => Date.now() - started,
    write: (s) => {
      try {
        appendFileSync(out, `${JSON.stringify(s)}\n`);
      } catch {
        /* a full or vanished disk must not take the stream down with it */
      }
    },
  });
}

/** How long a single CDP call may go unanswered before we stop waiting on a socket that may be dead. */
const CDP_TIMEOUT_MS = 15_000;

/** How often a live stream checks whether the code under it has moved. Well inside the ADR 152
 * auto-refresher's 120s tick, so a rebuild is picked up on the next poll rather than the next hour. */
const BUILD_POLL_MS = 60_000;

/**
 * Has the daemon been rebuilt *since this stream started*?
 *
 * The comparison is against the daemon's build **as observed at startup**, not against this
 * process's own stamp. That distinction is the whole design:
 *
 * - Comparing our stamp to the daemon's would restart forever for anyone running a branch build,
 *   because those two never match and never will. A dev streaming their own work-in-progress would
 *   get a stream that tears itself down every minute.
 * - Comparing the daemon to *itself over time* asks the question that actually matters: the ADR 152
 *   auto-refresher rebuilds the shared checkout and bounces the daemon, so the moment its build ref
 *   changes is precisely the moment this process's `dist` went stale underneath it.
 *
 * Pure SHA inequality, no git — and silence whenever either side is unstamped, per ADR 135: a
 * published tarball or stripped dist has no `build.json`, and reading "unknown" as "changed" is how
 * you build a restart loop.
 */
export function daemonRebuilt(baseline: string | undefined, current: string | undefined): boolean {
  if (!baseline || !current) return false;
  return baseline !== current;
}

/**
 * The exit code that asks a supervisor to run us again on the new code (`EX_TEMPFAIL`).
 *
 * ADR 159 restarts a stale stream by spawning a **detached** replacement and letting this process
 * return 0. That is right on a laptop — the shell prompt comes back while the stream continues — and
 * it is fatal in a container, because there the parent is not merely a parent: `entrypoint.sh`
 * `exec`s it, so it *is* the machine's main process. Fly's init sees `Main child exited normally
 * with code: 0`, runs cleanup, and destroys the VM (`--restart no` + `--rm`) — taking the
 * one-second-old detached replacement with it. Observed live twice on 2026-07-27; both hosted runs
 * died this way, at 4 and 6 minutes, the second killed by a **docs-only** merge (the ADR 152
 * auto-refresher bounces the daemon for any commit, and any daemon bounce trips the currency check).
 *
 * The process model is the container's business, so the container supervises: under
 * `MUSTERD_BROADCAST_SUPERVISED` we do not fork at all, we exit with this code and the entrypoint
 * loop runs a genuinely fresh process. That keeps ADR 159 §4's actual decision intact — a full
 * restart on new code, not a page reload, which the ADR rejected as "half a fix wearing the costume
 * of a whole one" (reloading refreshes the web bundle while this process's capture pipeline stays
 * stale). Only the *mechanism* is environment-specific, and now it says so.
 */
export const RESTART_EXIT_CODE = 75;

/** Is something outside this process willing to run us again? See `RESTART_EXIT_CODE`. */
export function supervised(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['MUSTERD_BROADCAST_SUPERVISED'];
  return v !== undefined && v !== '' && v !== '0';
}

/** The daemon's current build ref (ADR 130's `/health.build`), or undefined if it can't be read. */
async function fetchDaemonBuild(server: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${server.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return ((await res.json()) as { build?: string }).build;
  } catch {
    return undefined; // unreachable or unparseable — a watcher never acts on a guess
  }
}

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

/**
 * What a live stream records about itself, so it can be found without `ps | grep`.
 *
 * The incident this comes from had no terminal at all: the process's parent was `launchd`, so the
 * documented "Ctrl-C to stop" was not merely inconvenient, it was unavailable. The build restart
 * (ADR 159) makes that the *normal* state rather than an accident — the replacement is spawned
 * detached, so after the first restart there is no foreground process to interrupt.
 */
export interface RunState {
  pid: number;
  startedAt: number;
  team: string;
  /** `file` or `rtmp` — never the target, which for `--twitch` embeds the stream key. */
  sink: 'file' | 'rtmp';
  server: string;
  /** The daemon build this stream is pinned to, when known. */
  build?: string;
}

export function runStatePath(): string {
  return join(dirname(configPath()), 'broadcast', 'current.json');
}

export function writeRunState(state: RunState, path: string = runStatePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    /* best-effort bookkeeping — never fail a stream over it */
  }
}

export function readRunState(path: string = runStatePath()): RunState | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunState;
  } catch {
    return null;
  }
}

/**
 * Clear the record — **only if it still names `pid`**.
 *
 * The guard is load-bearing, not defensive habit. On a build restart the replacement is spawned
 * while this process is still alive, so both exist at once; an unconditional unlink in the old
 * process's exit handler would delete the *new* stream's record and leave it unfindable. Standard
 * pidfile discipline: you may only retract your own claim.
 */
export function clearRunState(pid: number, path: string = runStatePath()): void {
  try {
    if (readRunState(path)?.pid !== pid) return;
    rmSync(path, { force: true });
  } catch {
    /* nothing to clear */
  }
}

/** Is that process still there? `kill(pid, 0)` signals nothing and only asks the question. */
export function pidAlive(
  pid: number,
  kill: (p: number, s: number) => unknown = process.kill,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The recorded stream, if one is genuinely running. A record naming a dead pid is a run that ended
 * without tidying up (an external `SIGKILL`, a power cut) — report nothing and clear it, so a stale
 * file can never make `--stop` signal a pid the OS has since handed to something else.
 */
export function liveRunState(path: string = runStatePath()): RunState | null {
  const state = readRunState(path);
  if (!state) return null;
  if (pidAlive(state.pid)) return state;
  clearRunState(state.pid, path);
  return null;
}

const CHROME_MACOS = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_LINUX = '/usr/bin/chromium';

export function chromeDefault(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? CHROME_MACOS : CHROME_LINUX;
}

export function chromeArgs(
  debugPort: number,
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
  stage: { width: number; height: number } = { width: 1920, height: 1080 },
): string[] {
  return [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-extensions',
    // The Inc 1 contract: a stage-sized window at DPR 1 captures the stage 1:1.
    `--window-size=${stage.width},${stage.height}`,
    '--force-device-scale-factor=1',
    // A rented capture box runs this as root in a container, where Chrome's setuid sandbox refuses
    // to start at all, and where /dev/shm is 64MB — small enough that the compositor falls back to
    // disk mid-capture. Both are container facts, not Linux facts, but every Linux host this runs on
    // is a container, and neither flag costs anything on a machine whose only job is the capture.
    ...(platform === 'darwin' ? [] : ['--no-sandbox', '--disable-dev-shm-usage']),
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

/** How long `--stop` waits for a graceful exit before saying so. */
const STOP_WAIT_MS = 12_000;

/** `musterd broadcast --status` — is anything streaming, and on which build? */
function statusVerb(): number {
  const state = liveRunState();
  if (!state) {
    process.stdout.write(theme.meta('no broadcast running') + '\n');
    return 0;
  }
  const mins = Math.round((Date.now() - state.startedAt) / 60_000);
  process.stdout.write(
    `${theme.ok('◉ live')} ${state.team} ${theme.meta(
      `· ${state.sink} · pid ${state.pid} · up ${mins}m` +
        (state.build ? ` · ${state.build.slice(0, 7)}` : ''),
    )}\n`,
  );
  return 0;
}

/**
 * `musterd broadcast --stop` — the affordance the incident needed and did not have.
 *
 * `SIGTERM` rather than `SIGINT`: both take the same graceful path, and `SIGTERM` is what a
 * supervisor would send, so the one documented stop works whether the stream is in a terminal, was
 * orphaned, or is a detached replacement from a build restart.
 */
async function stopVerb(): Promise<number> {
  const state = liveRunState();
  if (!state) {
    process.stdout.write(theme.meta('no broadcast running') + '\n');
    return 0;
  }
  process.stdout.write(theme.meta(`stopping broadcast (pid ${state.pid})…`) + '\n');
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    throw new CliError(`could not signal pid ${state.pid} — is it yours?`, 1);
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(state.pid)) {
      clearRunState(state.pid);
      process.stdout.write(`${theme.ok('✓')} stopped\n`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // Deliberately not escalating to SIGKILL: that skips the container finalize, and after ADR 159 a
  // stream that ignores SIGTERM is a bug worth seeing rather than papering over.
  process.stderr.write(
    `${theme.err('✗')} pid ${state.pid} did not stop within ${STOP_WAIT_MS / 1000}s — still running\n`,
  );
  return 1;
}

export async function broadcastCommand(parsed: Parsed): Promise<number> {
  // The two read-only verbs come first: neither needs a sink or a --team, and both must work when
  // the stream they are asking about belongs to some other terminal (or to none at all).
  if (parsed.flags['status'] === true) return statusVerb();
  if (parsed.flags['stop'] === true) return stopVerb();

  const opts = parseOptions(parsed.flags);
  if (!opts.team) throw new CliError('which team? — pass --team <slug>', 2);
  const sink = await resolveSink(opts, keychainLookup);
  const url = broadcastUrl(opts.server, opts.team, opts.resolution, opts.fps);
  const stage = stagePixels(opts.resolution);

  const chromeBin = process.env['CHROME_BIN'] ?? chromeDefault();
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
  let buildTimer: NodeJS.Timeout | undefined;
  let perfTimer: NodeJS.Timeout | undefined;
  let live = false; // flips when the pump starts feeding ffmpeg
  let stopping = false;
  /** Set when the stop in flight is a build pickup, not an ending — see the build watch below. */
  let restarting = false;
  let checking = false; // one health poll at a time
  /** The daemon's build as we found it — the reference the watch compares against. */
  let baselineBuild: string | undefined;
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
      `${theme.err('✗')} the encoder is not keeping up — ${Math.round(STALL_BYTES / 1024 / 1024)}MB of frames queued and growing. ` +
        `Ending the stream rather than buffering into a hang; try a lower --fps or --bitrate.\n`,
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
    clearRunState(process.pid); // only if it is still ours — see clearRunState
  });

  // `detached: true` makes each child its own process-group leader, which is what lets the
  // stop path kill *everything* it spawned with one group signal — see killGroup.
  const chrome = spawn(chromeBin, chromeArgs(debugPort, profile, process.platform, stage), {
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
    if (buildTimer) clearInterval(buildTimer);
    if (perfTimer) clearInterval(perfTimer);
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
          width: stage.width,
          height: stage.height,
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
    // Capture-perf instrumentation — dark unless MUSTERD_BROADCAST_PERF names a JSONL path.
    // See broadcast-perf.ts for why queue *growth*, not ffmpeg's `speed=`, is the margin metric.
    let emitted = 0;
    const perf = startPerfRecording(page, ffmpeg, chrome, () => emitted);
    page.on('Page.screencastFrame', (p) => {
      const frame = Buffer.from(String(p['data']), 'base64');
      perf?.frame(frame.byteLength);
      pump.frame(frame);
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
      maxWidth: stage.width,
      maxHeight: stage.height,
      // Deliver at the encode rate, not at every composited frame — the JPEG encode above is the
      // single largest cost in the pipeline, and feeding 60/s into a 30fps encode pays for it twice.
      everyNthFrame: screencastEveryNthFrame(opts.fps),
    });
    // Tick at 2× frame cadence: the pump owes frames by wall clock, so the timer only needs to
    // fire *often enough* — late ticks emit catch-up frames instead of losing them.
    pumpTimer = setInterval(
      () => {
        emitted += pump.tick();
      },
      Math.max(1, Math.round(500 / opts.fps)),
    );
    if (perf) {
      perfTimer = setInterval(() => void perf.tick(), PERF_SAMPLE_MS);
      perfTimer.unref(); // measurement never holds the stream open
    }
    live = true; // signals now stop gracefully — there are frames worth finalizing

    baselineBuild = await fetchDaemonBuild(opts.server);
    writeRunState({
      pid: process.pid,
      startedAt: Date.now(),
      team: opts.team,
      sink: sink.kind,
      server: opts.server,
      ...(baselineBuild ? { build: baselineBuild } : {}),
    });
    process.stdout.write(
      `${theme.ok('◉ live')}${baselineBuild ? theme.meta(`  ${baselineBuild.slice(0, 7)}`) : ''}\n`,
    );

    /**
     * Stay current with `main`.
     *
     * A stream is the one musterd surface that can run for a day, and this one ran 11 hours showing
     * an office that was a merged PR out of date — the daemon and `/live` both refresh themselves,
     * the encoder had nothing. A long-lived Node process cannot hot-swap its own code, so picking up
     * a rebuild means starting again: tear the stream down cleanly and re-exec, which is the same
     * conclusion ADR 152 reached for the daemon.
     *
     * The restart is deliberately *not* a page reload. Reloading would keep the RTMP session alive
     * and never interrupt viewers, but it only refreshes the web bundle — the capture pipeline in
     * this process would stay stale, which is half a fix wearing the costume of a whole one.
     */
    buildTimer = setInterval(() => {
      if (checking || stopping || restarting) return;
      checking = true;
      void (async () => {
        try {
          const daemon = await fetchDaemonBuild(opts.server);
          if (!daemonRebuilt(baselineBuild, daemon)) return;
          process.stdout.write(
            theme.meta(
              `\ndaemon rebuilt (${baselineBuild?.slice(0, 7)} → ${daemon?.slice(0, 7)}) — restarting the stream on the new code`,
            ) + '\n',
          );
          restarting = true;
          gracefulStop(); // ffmpeg finalizes and exits → the await below returns → we re-exec
        } finally {
          checking = false;
        }
      })();
    }, BUILD_POLL_MS);
    buildTimer.unref(); // never the reason this process stays alive

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
  if (restarting) {
    // Only *after* cleanup: the old ffmpeg has finalized and released the ingest, so the replacement
    // isn't a second publisher on the same stream key — which the sink would reject.
    process.stdout.write(theme.meta('restarting…') + '\n');
    // Release the claim *before* the replacement starts, so its own `writeRunState` is not then
    // deleted by this process's exit handler. Both are briefly alive; only one may hold the record.
    clearRunState(process.pid);
    if (supervised()) return RESTART_EXIT_CODE;
    spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      env: process.env,
    }).unref();
    return 0;
  }
  if (exitCode === 0) process.stdout.write(`${theme.ok('✓')} broadcast ended cleanly\n`);
  return exitCode === 0 ? 0 : 1;
}
