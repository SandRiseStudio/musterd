// Footprint sampler (seat-footprint design) — a periodic tick beside the
// presence reaper: one `ps` scan, classify sidecar stacks, persist the tick,
// prune beyond retention. The sampler can never hurt the daemon: any scanner
// throw (including "unsupported platform" on non-darwin) skips the tick with
// one log line and the interval keeps running.
//
// Seat attribution is deliberately v1-honest: stacks carry seat=null until a
// reliable session boundary exists (the desktop app parents every session's
// sidecars itself — measured 2026-08-05, docs/perf/seat-footprint.md finding 2
// — and `lsof` per tick is a cost that deserves its own measurement first).
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { insertFootprintTick, pruneFootprint } from '../store/footprint.js';
import { buildStacks } from './classify.js';
import { scanMachine as scanMachineDefault, scanProcesses as scanProcsDefault } from './scan.js';

export interface SamplerDeps {
  scanProcs?: typeof scanProcsDefault;
  scanMachine?: typeof scanMachineDefault;
}

export function startFootprintSampler(ctx: Ctx, deps: SamplerDeps = {}): () => void {
  const scanProcs = deps.scanProcs ?? scanProcsDefault;
  const scanMachine = deps.scanMachine ?? scanMachineDefault;
  const tick = () => {
    try {
      const ts = Date.now();
      const stacks = buildStacks(scanProcs()).map((s) => ({
        ts,
        classification: s.classification,
        seat: null,
        procs: s.procs,
        rss_kb: s.rssKb,
        pids: JSON.stringify(s.pids),
      }));
      const machine = scanMachine();
      insertFootprintTick(ctx.db, stacks, {
        ts,
        swap_used_mb: machine.swapUsedMb,
        swap_total_mb: machine.swapTotalMb,
        free_mem_mb: machine.freeMemMb,
      });
      pruneFootprint(ctx.db, ts - ctx.config.footprintRetentionMs);
    } catch (err) {
      log.info({ msg: 'footprint_skip', err: String(err) });
    }
  };
  const handle = setInterval(tick, ctx.config.footprintIntervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
