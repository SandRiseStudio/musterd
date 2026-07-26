import { describe, expect, it } from 'vitest';
import {
  cpuOfTree,
  makePerfRecorder,
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
  cpu: { chrome: 100, ffmpeg: 40, self: 5 },
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

  it('exposes the draw-to-delivered ratio the plan is hunting', () => {
    // the suspected state today: the page paints at full rAF (~60) while Chrome delivers ~35
    const s = summarize([
      sample({ t: 0, deliveredFps: 35, drawFps: 60 }),
      sample({ t: 1000, deliveredFps: 35, drawFps: 60 }),
    ]);
    expect(s.drawsPerDeliveredFrame).toBeCloseTo(60 / 35, 5);
  });

  it('leaves the draw ratio undefined when the office probe never landed', () => {
    const s = summarize([sample({ t: 0 }), sample({ t: 1000 })]);
    expect(s.meanDrawFps).toBeUndefined();
    expect(s.drawsPerDeliveredFrame).toBeUndefined();
  });

  it('flags a contaminated run so a lucky number cannot enter the record', () => {
    const quiet = summarize([sample({ load1: 0.8 }), sample({ load1: 1.2 })]);
    expect(quiet.contaminated).toBe(false);

    // one spike is enough — the previous session's numbers were ruined exactly this way
    const noisy = summarize([sample({ load1: 0.8 }), sample({ load1: QUIET_LOAD_MAX + 0.1 })]);
    expect(noisy.contaminated).toBe(true);
    expect(noisy.peakLoad1).toBeCloseTo(QUIET_LOAD_MAX + 0.1, 5);
  });

  it('survives an empty capture rather than reporting NaN', () => {
    const s = summarize([]);
    expect(s.samples).toBe(0);
    expect(s.durationSec).toBe(0);
    expect(s.queueGrowthBytesPerSec).toBe(0);
    expect(s.meanDeliveredFps).toBe(0);
    expect(s.peakQueueMb).toBe(0);
    expect(s.contaminated).toBe(false);
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
      cpu: async () => ({ chrome: 0, ffmpeg: 0, self: 0 }),
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
      cpu: async () => ({ chrome: 1, ffmpeg: 2, self: 3 }),
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
