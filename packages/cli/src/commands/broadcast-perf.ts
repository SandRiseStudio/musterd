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
  /** `draws` as a rate over this interval — the waste shows against `emitted`, not `deliveredFps`. */
  drawFps?: number;
  /** 1-minute load average. Context only: the capture's own ~1.5 cores dominate it. @see cpu.other */
  load1: number;
  /**
   * Percent CPU. `chrome` and `ffmpeg` are **children of this process**, so `pipeline` — the whole
   * tree — already contains both; they are not three peers to be added up. `other` is everything on
   * the machine that is not us, and it is the only one of these that can say a run was contaminated.
   */
  cpu: { chrome: number; ffmpeg: number; pipeline: number; other: number };
}

/** What `summarize` reports over a whole capture. */
export interface PerfSummary {
  samples: number;
  /** Seconds spanned by the samples. */
  durationSec: number;
  meanDeliveredFps: number;
  meanKbPerFrame: number;
  meanDrawFps: number | undefined;
  /** Rate of CFR frames the pump handed the encoder — the stream's real output rate. */
  encodedFps: number;
  /**
   * Painted frames per frame that actually reached the encoder. ~2 means the page is drawn twice for
   * every frame that is kept — the plan's candidate #1.
   *
   * The denominator is {@link encodedFps}, deliberately. An earlier version divided by
   * `meanDeliveredFps`, but Chrome's screencast delivers every painted frame, so that ratio was
   * pinned near 1.00 and read as "no waste" while half of every frame's work was being discarded one
   * stage later. Measured 2026-07-26: 60 painted, 60 delivered, 30 encoded.
   */
  drawsPerEncodedFrame: number | undefined;
  /** **The margin metric.** Flat (≈0) = the encoder is keeping up with room to spare. */
  queueGrowthBytesPerSec: number;
  /** Largest backlog seen, MB — context for the growth rate. */
  peakQueueMb: number;
  meanLoad1: number;
  peakLoad1: number;
  /** `cli` is `pipeline` minus its children — the CLI's own frame plumbing, floored at zero. */
  meanCpu: { chrome: number; ffmpeg: number; cli: number; pipeline: number; other: number };
  /** True when *other* processes were busy enough that these numbers should not be trusted. */
  contaminated: boolean;
}

/**
 * The load average above which it is not worth *starting* a capture.
 *
 * Checked **before** a run, when load1 still describes other people's work. It cannot be used to
 * judge a finished run: see {@link QUIET_EXTERNAL_CPU_MAX}.
 */
export const QUIET_LOAD_MAX = 2.0;

/**
 * Percent CPU by processes that are not this capture, above which a run is contaminated.
 *
 * This replaces a load-average test that could never pass. Measured 2026-07-26 on an 8-core M3: every
 * run began under the load bar (1.52, 1.84, 1.73) and finished stamped contaminated, because the
 * capture's own ~1.5 cores drove load1 to 2.4–2.7 on its own. **The gate was failing on the workload
 * it existed to measure**, and no amount of waiting for a quieter laptop could have fixed it.
 *
 * External CPU has no such feedback loop. The threat this guards against is other agents building —
 * which showed up as load swinging between 5 and 63, i.e. many whole cores. 150% is comfortably above
 * a desktop's idle background (a compositor and a browser, ~80–100% on the machine this was tuned on)
 * and far below anything that would distort a measurement.
 */
export const QUIET_EXTERNAL_CPU_MAX = 150;

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
  // `emitted` is cumulative, so the encoder's rate is the span's delta over the span — not a mean of
  // per-sample values, which would weight a short first interval the same as a long one.
  const encodedFps =
    samples.length < 2 || durationSec <= 0
      ? 0
      : (samples[samples.length - 1]!.emitted - samples[0]!.emitted) / durationSec;
  const meanChrome = mean(samples.map((s) => s.cpu.chrome));
  const meanFfmpeg = mean(samples.map((s) => s.cpu.ffmpeg));
  const meanPipeline = mean(samples.map((s) => s.cpu.pipeline));
  return {
    samples: samples.length,
    durationSec,
    meanDeliveredFps,
    meanKbPerFrame: mean(samples.map((s) => s.kbPerFrame)),
    meanDrawFps,
    encodedFps,
    drawsPerEncodedFrame:
      meanDrawFps !== undefined && encodedFps > 0 ? meanDrawFps / encodedFps : undefined,
    queueGrowthBytesPerSec: slope(samples.map((s) => ({ x: s.t / 1000, y: s.queueBytes }))),
    peakQueueMb: Math.max(0, ...samples.map((s) => s.queueBytes)) / 1024 / 1024,
    meanLoad1: mean(loads),
    peakLoad1: Math.max(0, ...loads),
    meanCpu: {
      chrome: meanChrome,
      ffmpeg: meanFfmpeg,
      // Floored: chrome/ffmpeg and the tree total come from one ps snapshot but are summed
      // separately, so rounding can put the parts marginally above the whole.
      cli: Math.max(0, meanPipeline - meanChrome - meanFfmpeg),
      pipeline: meanPipeline,
      other: mean(samples.map((s) => s.cpu.other)),
    },
    contaminated: samples.some((s) => s.cpu.other > QUIET_EXTERNAL_CPU_MAX),
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
  /** Percent CPU per tree, plus everything that is not us. @see PerfSample.cpu */
  cpu: () => Promise<{ chrome: number; ffmpeg: number; pipeline: number; other: number }>;
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

/**
 * Sum `%CPU` across every process in the same `ps` output.
 *
 * Subtracting the capture's own tree from this is what yields "everyone else" — the only signal that
 * can call a run contaminated without being inflated by the capture itself. @see QUIET_EXTERNAL_CPU_MAX
 */
export function cpuTotal(psOutput: string): number {
  let total = 0;
  for (const line of psOutput.trim().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)/.exec(line);
    if (m) total += Number(m[3]);
  }
  return total;
}
