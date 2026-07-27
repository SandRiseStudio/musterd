import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import {
  broadcastUrl,
  clearRunState,
  daemonRebuilt,
  liveRunState,
  pidAlive,
  readRunState,
  writeRunState,
  type RunState,
  chromeArgs,
  ffmpegArgs,
  killGroup,
  makeFramePump,
  parseOptions,
  resolveSink,
  makeEncoderFeed,
  STALL_BYTES,
  sweepStaleProfiles,
  type EncoderPipe,
} from './broadcast.js';

describe('broadcast parseOptions', () => {
  it('defaults: 30fps, 4500k, localhost daemon, videotoolbox on darwin', () => {
    const o = parseOptions({ team: 'revive', out: 'x.mp4' }, 'darwin');
    expect(o).toMatchObject({
      team: 'revive',
      server: 'http://127.0.0.1:4849',
      fps: 30,
      bitrate: '4500k',
      duration: 0,
      encoder: 'videotoolbox',
    });
  });

  it('falls back to libx264 off macOS (no VideoToolbox there)', () => {
    expect(parseOptions({ team: 't', out: 'x.mp4' }, 'linux').encoder).toBe('libx264');
  });

  it('demands exactly one sink — none, or two, are usage errors', () => {
    expect(() => parseOptions({ team: 't' }, 'darwin')).toThrow(CliError);
    expect(() => parseOptions({ team: 't', out: 'x.mp4', twitch: true }, 'darwin')).toThrow(
      /exactly one sink/,
    );
  });

  it('rejects a non-numeric --fps and an implausible bitrate', () => {
    expect(() => parseOptions({ team: 't', out: 'x.mp4', fps: 'fast' }, 'darwin')).toThrow(
      /needs a number/,
    );
    expect(() => parseOptions({ team: 't', out: 'x.mp4', bitrate: 'lots' }, 'darwin')).toThrow();
  });
});

describe('broadcastUrl', () => {
  it('builds the Inc 1 observer-only page URL, slug encoded, trailing slash tolerated', () => {
    expect(broadcastUrl('http://127.0.0.1:4849/', 'revive')).toBe(
      'http://127.0.0.1:4849/broadcast?team=revive',
    );
    expect(broadcastUrl('https://box.example', 'my team')).toBe(
      'https://box.example/broadcast?team=my%20team',
    );
  });
});

describe('resolveSink (stream-key resolution)', () => {
  const base = parseOptions({ team: 't', out: 'x.mp4' }, 'darwin');

  it('--out is a file sink and never consults the key sources', async () => {
    const sink = await resolveSink(base, async () => 'kc-key', { MUSTERD_STREAM_KEY: 'env-key' });
    expect(sink).toEqual({ kind: 'file', target: 'x.mp4' });
  });

  it('--rtmp is taken verbatim (any provider)', async () => {
    const o = parseOptions({ team: 't', rtmp: 'rtmps://a.b/app/k' }, 'darwin');
    expect(await resolveSink(o, async () => null, {})).toEqual({
      kind: 'rtmp',
      target: 'rtmps://a.b/app/k',
    });
  });

  it('--twitch: env key wins, Keychain is the fallback, no key is a usage error', async () => {
    const o = parseOptions({ team: 't', twitch: true }, 'darwin');
    expect((await resolveSink(o, async () => 'kc', { MUSTERD_STREAM_KEY: 'env' })).target).toBe(
      'rtmps://live.twitch.tv/app/env',
    );
    expect((await resolveSink(o, async () => 'kc', {})).target).toBe(
      'rtmps://live.twitch.tv/app/kc',
    );
    await expect(resolveSink(o, async () => null, {})).rejects.toThrow(/no stream key/);
  });
});

describe('ffmpegArgs', () => {
  const opts = parseOptions({ team: 't', out: 'proof.mp4', duration: '10' }, 'darwin');

  it('encodes the contract: image2pipe at the pump rate, silent audio, 2s keyframes, yuv420p', () => {
    const args = ffmpegArgs(opts, { kind: 'file', target: 'proof.mp4' });
    const joined = args.join(' ');
    expect(joined).toContain('-f image2pipe -framerate 30 -i -');
    expect(joined).toContain('anullsrc'); // ingests reject video-only streams
    expect(joined).toContain('-c:v h264_videotoolbox');
    expect(joined).toContain('-g 60'); // keyframe every 2s at 30fps (Twitch spacing)
    expect(joined).toContain('-pix_fmt yuv420p');
    expect(joined).toContain('-t 10');
    expect(args.at(-1)).toBe('proof.mp4');
  });

  it('rtmp sink switches the muxer to flv; file sink gets faststart', () => {
    const rtmp = ffmpegArgs(opts, { kind: 'rtmp', target: 'rtmps://x/app/k' }).join(' ');
    expect(rtmp).toContain('-f flv rtmps://x/app/k');
    expect(rtmp).not.toContain('faststart');
    const file = ffmpegArgs(opts, { kind: 'file', target: 'p.mp4' }).join(' ');
    expect(file).toContain('+faststart');
  });

  it('libx264 swaps the codec only — the pipeline shape is identical', () => {
    const linux = parseOptions({ team: 't', out: 'p.mp4' }, 'linux');
    const args = ffmpegArgs(linux, { kind: 'file', target: 'p.mp4' }).join(' ');
    expect(args).toContain('-c:v libx264');
    expect(args).not.toContain('videotoolbox');
  });

  it('no -t when duration is 0 (run until stopped)', () => {
    const forever = parseOptions({ team: 't', out: 'p.mp4' }, 'darwin');
    expect(ffmpegArgs(forever, { kind: 'file', target: 'p.mp4' })).not.toContain('-t');
  });
});

describe('makeFramePump (the drift-compensating CFR re-clock)', () => {
  const harness = (fps: number) => {
    const out: Buffer[] = [];
    let clock = 0;
    const pump = makeFramePump(
      (b) => out.push(b),
      fps,
      () => clock,
    );
    return { out, pump, advance: (ms: number) => (clock += ms) };
  };

  it('holds silent until the first frame — never encodes a black lie', () => {
    const { out, pump, advance } = harness(30);
    expect(pump.tick()).toBe(0);
    advance(1000);
    expect(pump.tick()).toBe(0);
    expect(out).toHaveLength(0);
  });

  it('emits exactly fps frames per second of wall clock, duplicating a rested office', () => {
    const { out, pump, advance } = harness(30);
    pump.frame(Buffer.from('f1'));
    expect(pump.tick()).toBe(1); // t=0 → frame 0
    for (let i = 0; i < 30; i++) {
      advance(1000 / 30);
      pump.tick();
    }
    expect(out).toHaveLength(31); // 1s of video at 30fps, plus the epoch frame
    expect(new Set(out.map(String))).toEqual(new Set(['f1']));
  });

  it('CATCH-UP: a late tick emits every frame owed, so the video timeline never falls behind wall clock', () => {
    const { out, pump, advance } = harness(30);
    pump.frame(Buffer.from('f1'));
    pump.tick();
    advance(334); // the timer fired ~10 frames late (a loaded laptop) — this was the Twitch stall
    expect(pump.tick()).toBe(10);
    expect(out).toHaveLength(11);
  });

  it('a process-level pause (lid close, SIGSTOP) re-anchors instead of bursting minutes of frames', () => {
    const { out, pump, advance } = harness(30);
    pump.frame(Buffer.from('f1'));
    pump.tick();
    advance(60_000); // a minute of dead air — 1800 owed
    expect(pump.tick()).toBe(30); // capped at 1s of catch-up
    // and the timeline is re-anchored: the next frame is owed one frame-interval later, not 1769 at once
    advance(1000 / 30);
    expect(pump.tick()).toBe(1);
    expect(out).toHaveLength(32);
  });

  it('a newer frame replaces the old one between ticks (no backlog, no queue)', () => {
    const { out, pump, advance } = harness(30);
    pump.frame(Buffer.from('f1'));
    pump.frame(Buffer.from('f2')); // f1 was never ticked out — it is simply gone
    pump.tick();
    advance(1000 / 30);
    pump.frame(Buffer.from('f3'));
    pump.tick();
    expect(out.map(String)).toEqual(['f2', 'f3']);
  });

  it('an on-time cadence never double-emits (owed stays 0 between frame boundaries)', () => {
    const { pump, advance } = harness(30);
    pump.frame(Buffer.from('f1'));
    pump.tick();
    advance(10); // timer ticking faster than the frame interval
    expect(pump.tick()).toBe(0);
    advance(10);
    expect(pump.tick()).toBe(0);
    advance(14); // 34ms total → frame 1 is now owed
    expect(pump.tick()).toBe(1);
  });
});

describe('killGroup (the orphaned-ffmpeg backstop)', () => {
  const fake = (
    over: Partial<{ pid: number; exitCode: number | null; signalCode: string | null }>,
  ) => ({
    pid: 1234,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
    ...over,
  });

  it('signals the process GROUP (negative pid) — children spawn detached as group leaders', () => {
    const child = fake({});
    const kill = vi.fn(() => true as const);
    killGroup(child, 'SIGTERM', kill);
    expect(kill).toHaveBeenCalledWith(-1234, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('skips a child that already exited, was signaled, or never spawned — no pid-reuse roulette', () => {
    const kill = vi.fn(() => true as const);
    killGroup(fake({ exitCode: 0 }), 'SIGTERM', kill);
    killGroup(fake({ signalCode: 'SIGTERM' as never }), 'SIGTERM', kill);
    killGroup(fake({ pid: undefined as never }), 'SIGTERM', kill);
    expect(kill).not.toHaveBeenCalled();
  });

  it('falls back to the direct child on a group-kill error (not detached, group already gone)', () => {
    const child = fake({});
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    killGroup(child, 'SIGKILL', kill);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('is silent when both paths fail — it runs inside process.on(exit), where throwing is forbidden', () => {
    const child = fake({});
    child.kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    const kill = vi.fn(() => {
      throw new Error('EPERM');
    });
    expect(() => killGroup(child, 'SIGTERM', kill)).not.toThrow();
  });
});

describe('chromeArgs', () => {
  it('pins the Inc 1 capture contract: headless new, 1920×1080, DPR forced to 1', () => {
    const args = chromeArgs(9333, '/tmp/profile');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--window-size=1920,1080');
    expect(args).toContain('--force-device-scale-factor=1');
    expect(args).toContain('--remote-debugging-port=9333');
  });
});

describe('sweepStaleProfiles (the 837MB the incident left behind)', () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'sweep-test-'));
  }
  const HOUR = 60 * 60 * 1000;

  it('removes capture profiles older than the TTL', () => {
    const dir = tmp();
    const old = join(dir, 'musterd-broadcast-aaaaaa');
    mkdirSync(old);
    writeFileSync(join(old, 'big'), 'x');
    utimesSync(old, new Date(0), new Date(0));

    expect(sweepStaleProfiles(dir, 6 * HOUR, Date.now())).toBe(1);
    expect(existsSync(old)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a live run alone — a fresh profile belongs to a broadcast still running', () => {
    const dir = tmp();
    const fresh = join(dir, 'musterd-broadcast-bbbbbb');
    mkdirSync(fresh);

    expect(sweepStaleProfiles(dir, 6 * HOUR, Date.now())).toBe(0);
    expect(existsSync(fresh)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('never touches anything that is not ours', () => {
    const dir = tmp();
    const other = join(dir, 'someone-elses-tmpdir');
    mkdirSync(other);
    utimesSync(other, new Date(0), new Date(0));

    expect(sweepStaleProfiles(dir, 6 * HOUR, Date.now())).toBe(0);
    expect(existsSync(other)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is silent when the temp dir cannot be read — a sweep must never fail a run', () => {
    expect(() => sweepStaleProfiles(join(tmpdir(), 'definitely-not-here-xyz'))).not.toThrow();
  });
});

/**
 * The watermark that ends the hang. These drive the real pump against a stdin stand-in whose
 * `writableLength` we control, which is the whole mechanism: the old code wrote regardless, so a
 * sink that stopped draining grew the queue ~5.4MB/s until the event loop starved.
 */
describe('the stall watermark', () => {
  function pipe(over: Partial<EncoderPipe> = {}) {
    return { writable: true, writableLength: 0, write: vi.fn(), ...over } as EncoderPipe & {
      write: ReturnType<typeof vi.fn>;
    };
  }

  it('keeps writing while the encoder is merely behind', () => {
    const stdin = pipe({ writableLength: STALL_BYTES - 1 });
    const onStall = vi.fn();
    makeEncoderFeed(stdin, onStall)(Buffer.alloc(8));
    expect(stdin.write).toHaveBeenCalledTimes(1);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('stops feeding once the queue passes the mark — the buffer cannot run away', () => {
    const stdin = pipe({ writableLength: STALL_BYTES + 1 });
    const onStall = vi.fn();
    const feed = makeEncoderFeed(stdin, onStall);
    // Drive it through the real pump, the way the command does: ten seconds of owed frames.
    let t = 0;
    const pump = makeFramePump(feed, 30, () => t);
    pump.frame(Buffer.alloc(8));
    for (let i = 1; i <= 10; i++) {
      t = i * 1000;
      pump.tick();
    }
    expect(stdin.write).not.toHaveBeenCalled();
    expect(onStall).toHaveBeenCalled();
  });

  it('writes nothing at all once the pipe is closed', () => {
    const stdin = pipe({ writable: false });
    const onStall = vi.fn();
    makeEncoderFeed(stdin, onStall)(Buffer.alloc(8));
    expect(stdin.write).not.toHaveBeenCalled();
    expect(onStall).not.toHaveBeenCalled(); // a closed pipe is an ending, not a stall
  });

  it('tolerates a child that never got a stdin', () => {
    expect(() => makeEncoderFeed(null, vi.fn())(Buffer.alloc(8))).not.toThrow();
  });

  it('leaves enough slack for a loaded machine, and still bounds the queue', () => {
    // Sized from a measured capture: the queue climbed ~4.7MB/s under load (ffmpeg draining almost
    // nothing), and a 64MB ceiling ended a healthy stream within seconds. What must hold is that the
    // queue is bounded at all — that is what stops the process buffering into a hung event loop.
    const secondsOfSlack = STALL_BYTES / 181_000 / 30;
    expect(secondsOfSlack).toBeGreaterThan(30); // survives a monorepo build running alongside
    expect(secondsOfSlack).toBeLessThan(120); // but a stream this far behind is not worth saving
  });
});

describe('ffmpeg terminates when the video pipe does', () => {
  it('passes -shortest, or the infinite silent audio keeps it alive forever', () => {
    // The graceful stop closes stdin and gives ffmpeg 5s to finalize. `anullsrc` never ends, so
    // without -shortest ffmpeg outlives that window every time: Ctrl-C always fell through to the
    // force-kill and a file capture came out with no moov atom. This flag is what makes the whole
    // graceful path reachable.
    const args = ffmpegArgs(parseOptions({ team: 't', out: 'x.mp4' }, 'darwin'), {
      kind: 'file',
      target: 'x.mp4',
    });
    expect(args).toContain('-shortest');
    expect(args).toContain('anullsrc=r=44100:cl=stereo');
  });

  it('passes it for a stream sink too — a wedged ingest is where it matters most', () => {
    const args = ffmpegArgs(parseOptions({ team: 't', twitch: true }, 'darwin'), {
      kind: 'rtmp',
      target: 'rtmps://example/app/key',
    });
    expect(args).toContain('-shortest');
  });
});

describe('daemonRebuilt (staying current with main)', () => {
  it('restarts once the daemon has moved to a different commit', () => {
    expect(daemonRebuilt('aaa111', 'bbb222')).toBe(true);
  });

  it('sits still while the daemon has not moved', () => {
    expect(daemonRebuilt('aaa111', 'aaa111')).toBe(false);
  });

  it('compares the daemon against itself, so a branch build does not restart forever', () => {
    // The trap this shape avoids: comparing *our* stamp to the daemon's. A dev streaming their own
    // work-in-progress never matches the daemon and never will, so that comparison would tear the
    // stream down every single poll. The baseline is the daemon's build as we found it.
    const branchBuildRunningAgainstAStableDaemon = daemonRebuilt('daemon-sha', 'daemon-sha');
    expect(branchBuildRunningAgainstAStableDaemon).toBe(false);
  });

  it('stays silent when either side is unstamped — never restart on a guess', () => {
    // ADR 135: a published tarball or stripped dist has no build.json, and reading "unknown" as
    // "changed" is how you build a restart loop.
    expect(daemonRebuilt(undefined, 'bbb222')).toBe(false);
    expect(daemonRebuilt('aaa111', undefined)).toBe(false);
    expect(daemonRebuilt(undefined, undefined)).toBe(false);
  });
});

describe('run state (finding a stream without hunting PIDs)', () => {
  function statePath(): string {
    return join(mkdtempSync(join(tmpdir(), 'runstate-')), 'current.json');
  }
  const base = (over: Partial<RunState> = {}): RunState => ({
    pid: process.pid,
    startedAt: Date.now(),
    team: 'revive',
    sink: 'rtmp',
    server: 'http://127.0.0.1:4849',
    ...over,
  });

  it('round-trips what an operator needs to identify the stream', () => {
    const p = statePath();
    writeRunState(base({ build: 'abc1234' }), p);
    const read = readRunState(p);
    expect(read?.team).toBe('revive');
    expect(read?.pid).toBe(process.pid);
    expect(read?.build).toBe('abc1234');
  });

  it('never records the sink target — for --twitch that string embeds the stream key', () => {
    const p = statePath();
    writeRunState(base(), p);
    expect(readFileSync(p, 'utf8')).not.toContain('rtmps://');
    expect(readRunState(p)?.sink).toBe('rtmp');
  });

  it('reports a live stream, and forgets one whose process is gone', () => {
    const p = statePath();
    writeRunState(base(), p); // our own pid — definitely alive
    expect(liveRunState(p)?.team).toBe('revive');

    writeRunState(base({ pid: 0x7ffffff0 }), p); // a pid that is not running
    expect(liveRunState(p)).toBeNull();
    expect(existsSync(p)).toBe(false); // and the stale record is tidied away
  });

  it('only lets a process retract its own claim — the restart hand-off depends on it', () => {
    // On a build restart the replacement is spawned while the old process is still alive, so both
    // exist at once. An unconditional unlink in the old process's exit handler would delete the NEW
    // stream's record and leave it unfindable by --status/--stop.
    const p = statePath();
    const replacementPid = process.pid + 1;
    writeRunState(base({ pid: replacementPid }), p); // the replacement has claimed it

    clearRunState(process.pid, p); // the outgoing process tidies up
    expect(readRunState(p)?.pid).toBe(replacementPid); // ...and does not clobber the newcomer

    clearRunState(replacementPid, p); // its own claim, though, it may drop
    expect(existsSync(p)).toBe(false);
  });

  it('survives a missing or corrupt record rather than failing a stream over bookkeeping', () => {
    expect(readRunState(join(tmpdir(), 'definitely-not-here-xyz.json'))).toBeNull();
    const p = statePath();
    writeFileSync(p, 'not json at all');
    expect(readRunState(p)).toBeNull();
    expect(liveRunState(p)).toBeNull();
  });

  it('pidAlive asks without signalling — kill(pid, 0) must send nothing', () => {
    const kill = vi.fn();
    expect(pidAlive(1234, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(1234, 0);
    const dead = vi.fn(() => {
      throw new Error('ESRCH');
    });
    expect(pidAlive(1234, dead)).toBe(false);
  });
});
