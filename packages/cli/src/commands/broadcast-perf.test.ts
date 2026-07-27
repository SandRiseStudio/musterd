import { describe, expect, it } from 'vitest';
import {
  cpuOfTree,
  cpuTotal,
  makePerfRecorder,
  QUIET_EXTERNAL_CPU_MAX,
  QUIET_LOAD_MAX,
  slope,
  summarize,
  type PerfSample,
} from './broadcast-perf';

/** A sample with sane defaults, so each test states only the field it is about. */
const sample = (over: Partial<PerfSample> = {}): PerfSample => ({
  t: 1000,
  frames: 35,
  bytes: 35 * 181 * 1024,
  deliveredFps: 35,
  kbPerFrame: 181,
  queueBytes: 0,
  emitted: 30,
  load1: 1,
  cpu: { chrome: 100, ffmpeg: 40, pipeline: 150, other: 20 },
  ...over,
});

describe('slope', () => {
  it('is zero for fewer than two points', () => {
    expect(slope([])).toBe(0);
    expect(slope([{ x: 1, y: 5 }])).toBe(0);
  });

  it('recovers a known rate of growth', () => {
    // a queue growing 5.4 MB/s — the #367-era number from a stream that could not keep up
    const pts = [0, 1, 2, 3, 4].map((x) => ({ x, y: x * 5.4e6 }));
    expect(slope(pts)).toBeCloseTo(5.4e6, 0);
  });

  it('is zero for a flat queue — the shape of a pipeline with margin', () => {
    expect(slope([0, 1, 2, 3].map((x) => ({ x, y: 1024 })))).toBeCloseTo(0, 6);
  });

  it('is negative for a draining queue', () => {
    expect(slope([0, 1, 2, 3].map((x) => ({ x, y: 4000 - x * 1000 })))).toBeCloseTo(-1000, 6);
  });

  it('does not divide by zero when every sample lands at the same instant', () => {
    expect(
      slope([
        { x: 2, y: 1 },
        { x: 2, y: 9 },
      ]),
    ).toBe(0);
  });
});

describe('summarize', () => {
  it('reports queue growth as the margin metric, not speed', () => {
    const s = summarize([
      sample({ t: 0, queueBytes: 0 }),
      sample({ t: 1000, queueBytes: 1e6 }),
      sample({ t: 2000, queueBytes: 2e6 }),
    ]);
    expect(s.queueGrowthBytesPerSec).toBeCloseTo(1e6, -3);
    expect(s.peakQueueMb).toBeCloseTo(2e6 / 1024 / 1024, 5);
    expect(s.durationSec).toBe(2);
  });

  it('measures wasted painting against frames that reach the encoder, not deliveries', () => {
    // The state measured 2026-07-26: the page paints at full rAF (60), Chrome's screencast delivers
    // all 60, and the pump hands only 30 to ffmpeg. Dividing draws by *deliveries* reports 1.0 and
    // hides the waste; the honest denominator is the CFR stream the encoder actually consumes.
    const s = summarize([
      sample({ t: 0, deliveredFps: 60, drawFps: 60, emitted: 0 }),
      sample({ t: 2000, deliveredFps: 60, drawFps: 60, emitted: 60 }), // 60 frames over 2s = 30fps
    ]);
    expect(s.encodedFps).toBeCloseTo(30, 5);
    expect(s.drawsPerEncodedFrame).toBeCloseTo(2, 5);
  });

  it('leaves the draw ratio undefined when the office probe never landed', () => {
    const s = summarize([sample({ t: 0 }), sample({ t: 1000 })]);
    expect(s.meanDrawFps).toBeUndefined();
    expect(s.drawsPerEncodedFrame).toBeUndefined();
  });

  it('reports the CLI’s own cost, not the tree that contains its children', () => {
    // `pipeline` is cpuOfTree(cli pid) and chrome/ffmpeg are its children, so presenting all three
    // as peers double-counts — the mistake that made the CLI look like the most expensive component.
    const s = summarize([sample({ cpu: { chrome: 121, ffmpeg: 13, pipeline: 147, other: 10 } })]);
    expect(s.meanCpu.cli).toBeCloseTo(13, 5);
    expect(s.meanCpu.pipeline).toBeCloseTo(147, 5);
  });

  it('never reports a negative CLI cost when sampling skew makes the parts exceed the tree', () => {
    const s = summarize([sample({ cpu: { chrome: 121, ffmpeg: 13, pipeline: 130, other: 0 } })]);
    expect(s.meanCpu.cli).toBe(0);
  });

  it('judges contamination by other processes, not by load the capture itself creates', () => {
    // The capture occupies ~1.5 cores, so load1 clears QUIET_LOAD_MAX on its own and the old gate
    // could never pass while measuring the thing it gated. External CPU is the honest signal.
    const busySelf = summarize([
      sample({
        load1: QUIET_LOAD_MAX + 0.7,
        cpu: { chrome: 121, ffmpeg: 13, pipeline: 147, other: 12 },
      }),
    ]);
    expect(busySelf.contaminated).toBe(false);

    const busyOthers = summarize([
      sample({
        load1: 0.4,
        cpu: { chrome: 121, ffmpeg: 13, pipeline: 147, other: QUIET_EXTERNAL_CPU_MAX + 1 },
      }),
    ]);
    expect(busyOthers.contaminated).toBe(true);
  });

  it('still records load so a reader can see the machine it ran on', () => {
    const s = summarize([sample({ load1: 0.8 }), sample({ load1: 2.4 })]);
    expect(s.peakLoad1).toBeCloseTo(2.4, 5);
    expect(s.meanLoad1).toBeCloseTo(1.6, 5);
  });

  it('survives an empty capture rather than reporting NaN', () => {
    const s = summarize([]);
    expect(s.samples).toBe(0);
    expect(s.durationSec).toBe(0);
    expect(s.queueGrowthBytesPerSec).toBe(0);
    expect(s.meanDeliveredFps).toBe(0);
    expect(s.peakQueueMb).toBe(0);
    expect(s.contaminated).toBe(false);
    expect(s.encodedFps).toBe(0);
    expect(s.drawsPerEncodedFrame).toBeUndefined();
  });
});

describe('cpuTotal', () => {
  const ps = [
    '  PID  PPID %CPU',
    '    1     0  0.0',
    '  100     1 12.5',
    '  101   100 68.0',
    '  200     1 40.0',
  ].join('\n');

  it('sums every process, which is what makes "everyone else" derivable', () => {
    expect(cpuTotal(ps)).toBeCloseTo(12.5 + 68 + 40, 5);
  });

  it('ignores the header rather than parsing it as a process', () => {
    expect(cpuTotal('  PID  PPID %CPU')).toBe(0);
  });
});

describe('makePerfRecorder', () => {
  /** Drives the recorder with a scripted clock and office counters; returns what it wrote. */
  const run = async (steps: { atMs: number; frames: number[]; draws: number }[]) => {
    const out: PerfSample[] = [];
    let t = 0;
    let draws = 0;
    const rec = makePerfRecorder({
      queueBytes: () => 0,
      emitted: () => 0,
      office: async () => ({ ticks: draws, draws }),
      cpu: async () => ({ chrome: 0, ffmpeg: 0, pipeline: 0, other: 0 }),
      load1: () => 0.5,
      now: () => t,
      write: (s) => out.push(s),
    });
    for (const step of steps) {
      t = step.atMs;
      draws = step.draws;
      for (const b of step.frames) rec.frame(b);
      await rec.tick();
    }
    return out;
  };

  it('turns per-interval deliveries into a rate and a mean frame size', async () => {
    const kb181 = 181 * 1024;
    const out = await run([{ atMs: 1000, frames: Array(35).fill(kb181), draws: 60 }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.deliveredFps).toBeCloseTo(35, 5);
    expect(out[0]!.kbPerFrame).toBeCloseTo(181, 5);
    expect(out[0]!.frames).toBe(35);
  });

  it('resets its accumulator each tick, so rates are per-interval not cumulative', async () => {
    const out = await run([
      { atMs: 1000, frames: Array(35).fill(1024), draws: 60 },
      { atMs: 2000, frames: Array(20).fill(1024), draws: 120 },
    ]);
    expect(out[0]!.deliveredFps).toBeCloseTo(35, 5);
    expect(out[1]!.deliveredFps).toBeCloseTo(20, 5); // not 55
  });

  it('derives drawFps from the delta of a cumulative counter, not the total', async () => {
    const out = await run([
      { atMs: 1000, frames: [], draws: 60 },
      { atMs: 2000, frames: [], draws: 120 },
      { atMs: 3000, frames: [], draws: 150 },
    ]);
    // first tick has no previous reading to difference against
    expect(out[0]!.drawFps).toBeUndefined();
    expect(out[0]!.draws).toBe(60);
    expect(out[1]!.drawFps).toBeCloseTo(60, 5);
    expect(out[2]!.drawFps).toBeCloseTo(30, 5); // the delta, not 150/3
  });

  it('records a sample even when the office probe fails', async () => {
    const out: PerfSample[] = [];
    const rec = makePerfRecorder({
      queueBytes: () => 4096,
      emitted: () => 30,
      office: async () => undefined, // scene not up, or the CDP eval threw
      cpu: async () => ({ chrome: 1, ffmpeg: 2, pipeline: 6, other: 4 }),
      load1: () => 0.5,
      now: () => 1000,
      write: (s) => out.push(s),
    });
    rec.frame(1024);
    await rec.tick();
    expect(out[0]!.queueBytes).toBe(4096);
    expect(out[0]!.draws).toBeUndefined();
    expect(out[0]!.drawFps).toBeUndefined();
  });
});

describe('cpuOfTree', () => {
  const ps = [
    '  PID  PPID %CPU',
    '    1     0  0.0',
    '  100     1 12.5', // chrome browser process
    '  101   100 68.0', // its renderer — where the compositor cost actually lands
    '  102   100  9.5', // gpu process
    '  200     1 40.0', // ffmpeg, a sibling not a child
  ].join('\n');

  it('sums a process and its descendants', () => {
    expect(cpuOfTree(ps, 100)).toBeCloseTo(12.5 + 68 + 9.5, 5);
  });

  it('does not sweep in siblings', () => {
    expect(cpuOfTree(ps, 200)).toBeCloseTo(40, 5);
  });

  it('is zero for a pid that has already exited', () => {
    expect(cpuOfTree(ps, 999)).toBe(0);
  });

  it('ignores the header row rather than parsing it as a process', () => {
    expect(cpuOfTree(ps, 1)).toBeCloseTo(0 + 12.5 + 68 + 9.5 + 40, 5);
  });

  it('terminates on a cycle instead of hanging the sampler', () => {
    expect(
      cpuOfTree(['  PID  PPID %CPU', '   10    11  1.0', '   11    10  2.0'].join('\n'), 10),
    ).toBeCloseTo(3, 5);
  });
});
