/**
 * Broadcast capture-perf instrumentation (plan: docs/superpowers/plans/2026-07-25-broadcast-capture-perf.md).
 *
 * `musterd broadcast` has no margin: on a quiet machine it holds ~0.99× real time, and under load it
 * falls behind until the ADR 159 stall watchdog ends the stream. Three optimization hypotheses have
 * already died against it — JPEG quality, "ffmpeg is the bottleneck", and frame deduplication — which
 * is why this module measures before anything changes.
 *
 * **`speed=` is not the margin metric.** ffmpeg reports ≈1× for a live source *by construction*: the
 * pump feeds it on a wall clock, so `speed=` says only whether the encoder kept up, never by how much
 * it could have. Captures at 30/20/15 fps all returned ~1.0×, which reads like "fps makes no
 * difference" and means nothing of the sort. **Queue growth rate is the margin metric** — a pipeline
 * with headroom holds a flat queue; one without grows one, and `queueGrowthBytesPerSec` is the number
 * that says which.
 *
 * Inert unless `MUSTERD_BROADCAST_PERF` names a file to write JSONL samples to, so this ships dark
 * (the `?beat=` precedent). Read the output with `scripts/perf/broadcast-baseline.mjs`.
 */

/** One interval's worth of pipeline state. Written as a JSONL line; summarized by the harness. */
export interface PerfSample {
  /** Milliseconds since the capture started. */
  t: number;
  /** Screencast frames Chrome delivered during this interval — the pipeline's real input rate. */
  frames: number;
  /** Screencast bytes delivered during this interval. */
  bytes: number;
  /** `frames` as a rate. Expected ~35 at 1080p jpeg@85 (measured in #369). */
  deliveredFps: number;
  /** Mean delivered frame size, KB. Expected ~181 at 1080p jpeg@85. */
  kbPerFrame: number;
  /** `ffmpeg.stdin.writableLength` at sample time — the backlog. Its *slope* is the margin. */
  queueBytes: number;
  /** Constant-frame-rate frames the pump has emitted to the encoder, cumulative. */
  emitted: number;
  /** Canvas rAF callbacks, cumulative (from `window.__office.stats()`); undefined if the probe failed. */
  ticks?: number;
  /** Canvas frames actually painted, cumulative. Under broadcast this equals `ticks` today. */
  draws?: number;
  /** `draws` as a rate over this interval — the suspected waste when it sits ~2× `deliveredFps`. */
  drawFps?: number;
  /** 1-minute load average. Recorded so contamination is visible in the data, not inferred later. */
  load1: number;
  /** Percent CPU by process tree: the capture's own Chrome, its ffmpeg, and this process. */
  cpu: { chrome: number; ffmpeg: number; self: number };
}

/** What `summarize` reports over a whole capture. */
export interface PerfSummary {
  samples: number;
  /** Seconds spanned by the samples. */
  durationSec: number;
  meanDeliveredFps: number;
  meanKbPerFrame: number;
  meanDrawFps: number | undefined;
  /**
   * Painted frames per frame that actually reached the encoder. ~2 means the page is being drawn
   * twice for every frame captured — the plan's candidate #1.
   */
  drawsPerDeliveredFrame: number | undefined;
  /** **The margin metric.** Flat (≈0) = the encoder is keeping up with room to spare. */
  queueGrowthBytesPerSec: number;
  /** Largest backlog seen, MB — context for the growth rate. */
  peakQueueMb: number;
  meanLoad1: number;
  peakLoad1: number;
  meanCpu: { chrome: number; ffmpeg: number; self: number };
  /** True when load was high enough that these numbers should not be trusted. @see QUIET_LOAD_MAX */
  contaminated: boolean;
}

/**
 * The load average above which a measurement is not worth taking.
 *
 * Every number in the previous session was contaminated — load swung between 5 and 63 as other
 * sessions built, and one lucky run under that noise is exactly what made the JPEG-quality hypothesis
 * briefly look like a win. This box has 10 cores; a run at ≤2 is a quiet machine, and past that the
 * harness says so rather than letting a plausible-looking table into the record.
 */
export const QUIET_LOAD_MAX = 2.0;

/** Least-squares slope of y over x. The queue-growth estimator; 0 for fewer than two points. */
export function slope(points: readonly { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.x - mx;
    num += dx * (p.y - my);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Reduce a capture's samples to the table row that goes in `docs/perf/broadcast-baseline.md`. */
export function summarize(samples: readonly PerfSample[]): PerfSummary {
  const durationSec =
    samples.length < 2 ? 0 : (samples[samples.length - 1]!.t - samples[0]!.t) / 1000;
  const drawFps = samples.map((s) => s.drawFps).filter((v): v is number => v !== undefined);
  const meanDeliveredFps = mean(samples.map((s) => s.deliveredFps));
  const meanDrawFps = drawFps.length ? mean(drawFps) : undefined;
  const loads = samples.map((s) => s.load1);
  return {
    samples: samples.length,
    durationSec,
    meanDeliveredFps,
    meanKbPerFrame: mean(samples.map((s) => s.kbPerFrame)),
    meanDrawFps,
    drawsPerDeliveredFrame:
      meanDrawFps !== undefined && meanDeliveredFps > 0
        ? meanDrawFps / meanDeliveredFps
        : undefined,
    queueGrowthBytesPerSec: slope(samples.map((s) => ({ x: s.t / 1000, y: s.queueBytes }))),
    peakQueueMb: Math.max(0, ...samples.map((s) => s.queueBytes)) / 1024 / 1024,
    meanLoad1: mean(loads),
    peakLoad1: Math.max(0, ...loads),
    meanCpu: {
      chrome: mean(samples.map((s) => s.cpu.chrome)),
      ffmpeg: mean(samples.map((s) => s.cpu.ffmpeg)),
      self: mean(samples.map((s) => s.cpu.self)),
    },
    contaminated: loads.some((l) => l > QUIET_LOAD_MAX),
  };
}

/** What the recorder needs from the running capture — narrow, so a test can drive it with no pipeline. */
export interface PerfProbes {
  /** `ffmpeg.stdin.writableLength`. */
  queueBytes: () => number;
  /** Cumulative CFR frames the pump has emitted. */
  emitted: () => number;
  /** `window.__office.stats()` over CDP; undefined when the probe fails or the scene isn't up yet. */
  office: () => Promise<{ ticks: number; draws: number } | undefined>;
  /** Percent CPU per tree. */
  cpu: () => Promise<{ chrome: number; ffmpeg: number; self: number }>;
  /** 1-minute load average. */
  load1: () => number;
  /** Milliseconds since capture start. */
  now: () => number;
  /** Where a finished sample goes — one JSONL line in the real recorder. */
  write: (s: PerfSample) => void;
}

/**
 * Accumulates screencast deliveries between ticks and emits one {@link PerfSample} per tick.
 *
 * Split from the command so the arithmetic that produces the numbers — per-interval rates from
 * cumulative counters, which is where an off-by-one silently becomes a plausible-looking table — is
 * driven by tests rather than only by a live stream.
 */
export function makePerfRecorder(probes: PerfProbes): {
  frame: (bytes: number) => void;
  tick: () => Promise<void>;
} {
  let frames = 0;
  let bytes = 0;
  let lastT = 0;
  let lastDraws: number | undefined;
  return {
    frame(n) {
      frames++;
      bytes += n;
    },
    async tick() {
      const t = probes.now();
      const dtSec = (t - lastT) / 1000;
      const [office, cpu] = await Promise.all([probes.office(), probes.cpu()]);
      // Rates come from *deltas* of cumulative counters: the office reports since-mount totals, so a
      // naive `draws / elapsed` would smear a mid-capture change across the whole run.
      const drawDelta = office && lastDraws !== undefined ? office.draws - lastDraws : undefined;
      const sample: PerfSample = {
        t,
        frames,
        bytes,
        deliveredFps: dtSec > 0 ? frames / dtSec : 0,
        kbPerFrame: frames > 0 ? bytes / frames / 1024 : 0,
        queueBytes: probes.queueBytes(),
        emitted: probes.emitted(),
        ...(office ? { ticks: office.ticks, draws: office.draws } : {}),
        ...(drawDelta !== undefined && dtSec > 0 ? { drawFps: drawDelta / dtSec } : {}),
        load1: probes.load1(),
        cpu,
      };
      probes.write(sample);
      frames = 0;
      bytes = 0;
      lastT = t;
      lastDraws = office?.draws ?? lastDraws;
    },
  };
}

/**
 * Sum `%CPU` over a process and all its descendants, from `ps -Ao pid,ppid,pcpu` output.
 *
 * Chrome is a process *tree* — renderer, GPU, and zygote are separate pids, and the compositor cost
 * this whole investigation points at lands in the renderer, not the pid we spawned. Summing only the
 * root would report a near-idle Chrome while the machine burns.
 */
export function cpuOfTree(psOutput: string, root: number): number {
  const kids = new Map<number, number[]>();
  const pcpu = new Map<number, number>();
  for (const line of psOutput.trim().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)/.exec(line);
    if (!m) continue; // the header row, and anything ps prints that isn't a process
    const [pid, ppid, cpu] = [Number(m[1]), Number(m[2]), Number(m[3])];
    pcpu.set(pid, cpu);
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  let total = 0;
  const seen = new Set<number>();
  const walk = (pid: number) => {
    if (seen.has(pid)) return; // ps output is a snapshot; a pid cycle would otherwise hang the walk
    seen.add(pid);
    total += pcpu.get(pid) ?? 0;
    for (const k of kids.get(pid) ?? []) walk(k);
  };
  walk(root);
  return total;
}
