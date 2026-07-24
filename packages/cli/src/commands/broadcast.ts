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
 * needs one every 1000/fps ms regardless, so the pump re-emits the latest frame on a fixed clock —
 * a rested office becomes a perfectly still (and perfectly valid) stream. Pure: callers wire the
 * clock and the sink, tests drive it by hand.
 */
export function makeFramePump(write: (png: Buffer) => void): {
  frame: (png: Buffer) => void;
  tick: () => boolean;
} {
  let latest: Buffer | null = null;
  return {
    frame: (png) => {
      latest = png;
    },
    /** Emit the newest frame; false while nothing has arrived yet (don't encode a black lie). */
    tick: () => {
      if (!latest) return false;
      write(latest);
      return true;
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
    await cdp.send('Page.navigate', { url });
    await waitBroadcastReady(cdp, 30_000);

    const pump = makeFramePump((png) => {
      // Backpressure by drop, not by buffer: if ffmpeg is briefly behind, skipping a duplicate
      // frame is invisible; an unbounded write queue is an OOM with extra steps.
      if (ffmpeg.stdin?.writable) ffmpeg.stdin.write(png);
    });
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
    pumpTimer = setInterval(() => pump.tick(), Math.round(1000 / opts.fps));

    process.stdout.write(`${theme.ok('◉ live')}\n`);

    // Run until ffmpeg exits (its -t duration, its sink failing) or a signal lands.
    exitCode = await new Promise<number>((resolve) => {
      const stop = () => {
        process.stdout.write(theme.meta('\nstopping…') + '\n');
        if (pumpTimer) clearInterval(pumpTimer);
        ffmpeg.stdin?.end(); // let ffmpeg finalize the container (moov atom in file mode)
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      ffmpeg.once('exit', (code) => resolve(code ?? 1));
      chrome.once('exit', () => {
        // The frame source dying mid-stream is terminal — flush what we have and report it.
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
