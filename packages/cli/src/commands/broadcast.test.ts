import { describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import {
  broadcastUrl,
  chromeArgs,
  ffmpegArgs,
  makeFramePump,
  parseOptions,
  resolveSink,
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

describe('chromeArgs', () => {
  it('pins the Inc 1 capture contract: headless new, 1920×1080, DPR forced to 1', () => {
    const args = chromeArgs(9333, '/tmp/profile');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--window-size=1920,1080');
    expect(args).toContain('--force-device-scale-factor=1');
    expect(args).toContain('--remote-debugging-port=9333');
  });
});
