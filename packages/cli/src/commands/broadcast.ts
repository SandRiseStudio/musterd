import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
 * The ffmpeg invocation, as pure data. Input 0 is the PNG frame pipe at the pump's constant rate;
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
    // video: PNG frames on stdin, already constant-rate thanks to the pump
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
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++msgId;
        pending.set(id, { res, rej });
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
  const profile = mkdtempSync(join(tmpdir(), 'musterd-broadcast-'));

  process.stdout.write(`${theme.accent('broadcast')} — ${opts.team}  ${theme.meta(url)}\n`);
  process.stdout.write(
    theme.meta(
      `${sink.kind === 'file' ? `capturing to ${sink.target}` : 'streaming (rtmps)'} · ` +
        `${opts.fps}fps · ${opts.bitrate} · ${opts.encoder}` +
        (opts.duration ? ` · ${opts.duration}s` : ' · Ctrl-C to stop'),
    ) + '\n',
  );

  const chrome = spawn(chromeBin, chromeArgs(debugPort, profile), { stdio: 'ignore' });
  const ffmpeg: ChildProcess = spawn('ffmpeg', ffmpegArgs(opts, sink), {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  // ffmpeg closes its stdin the moment `-t <duration>` is satisfied (or its sink dies) — a pump tick
  // racing that close is an EPIPE, which on a Socket is an *emitted* error that would crash the
  // process. It's the normal end-of-stream handshake here, not a failure: swallow it and let the
  // `exit` handler below report ffmpeg's real verdict.
  ffmpeg.stdin?.on('error', () => {});

  let pumpTimer: NodeJS.Timeout | undefined;
  let exitCode = 0;
  const cleanup = () => {
    if (pumpTimer) clearInterval(pumpTimer);
    ffmpeg.stdin?.end();
    chrome.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* best-effort: Chrome may still be flushing its profile */
    }
  };

  try {
    const cdp = await connectCdp(debugPort);
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

    const pump = makeFramePump((png) => {
      // Write unconditionally while the pipe is open — Node buffers past the kernel pipe when
      // ffmpeg is briefly behind, and PNG frames are small enough that the window is bounded. The
      // one wrong move is *dropping* frames: image2pipe timestamps are frame-count, so a dropped
      // frame permanently slows the video timeline (the stall the pump exists to prevent).
      if (ffmpeg.stdin?.writable) ffmpeg.stdin.write(png);
    }, opts.fps);
    cdp.on('Page.screencastFrame', (p) => {
      pump.frame(Buffer.from(String(p['data']), 'base64'));
      void cdp.send('Page.screencastFrameAck', { sessionId: p['sessionId'] });
    });
    await cdp.send('Page.startScreencast', {
      format: 'png',
      maxWidth: 1920,
      maxHeight: 1080,
      everyNthFrame: 1,
    });
    // Tick at 2× frame cadence: the pump owes frames by wall clock, so the timer only needs to
    // fire *often enough* — late ticks emit catch-up frames instead of losing them.
    pumpTimer = setInterval(() => pump.tick(), Math.max(1, Math.round(500 / opts.fps)));

    process.stdout.write(`${theme.ok('◉ live')}\n`);

    // Run until ffmpeg exits (its -t duration, its sink failing) or a signal lands.
    exitCode = await new Promise<number>((resolve) => {
      let done = false;
      const stop = () => {
        process.stdout.write(theme.meta('\nstopping…') + '\n');
        if (pumpTimer) clearInterval(pumpTimer);
        ffmpeg.stdin?.end(); // let ffmpeg finalize the container (moov atom in file mode)
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      ffmpeg.once('exit', (code) => {
        done = true;
        if (pumpTimer) clearInterval(pumpTimer); // encoder gone — stop feeding a closed pipe
        resolve(code ?? 1);
      });
      chrome.once('exit', () => {
        // The frame source dying MID-stream is terminal — flush what we have and report it. After a
        // normal end (`done`) this also fires from cleanup's own chrome.kill(); that's not an error.
        if (done) return;
        process.stderr.write(`${theme.err('✗')} headless Chrome exited\n`);
        stop();
      });
    });
  } finally {
    cleanup();
  }
  if (exitCode === 0) process.stdout.write(`${theme.ok('✓')} broadcast ended cleanly\n`);
  return exitCode === 0 ? 0 : 1;
}
