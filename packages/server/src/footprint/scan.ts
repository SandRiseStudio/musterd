// Darwin platform scanners for the footprint sampler. Thin execFileSync
// wrappers — the parsing regexes are shared with scripts/perf/seat-footprint.mjs
// and exercised there against the live machine; keep both in step. Callers own
// failure policy: every function throws on exec/parse trouble, and the sampler
// turns a throw into a skipped tick (never a crashed daemon). On non-darwin
// platforms scanProcesses throws immediately; the sampler disables itself with
// one log line rather than sampling garbage.
import { execFileSync } from 'node:child_process';
import type { ProcSample } from './classify.js';

export interface MachineSample {
  swapUsedMb: number | null;
  swapTotalMb: number | null;
  freeMemMb: number | null;
}

function assertDarwin(): void {
  if (process.platform !== 'darwin') throw new Error('footprint: unsupported platform');
}

export function scanProcesses(): ProcSample[] {
  assertDarwin();
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,args='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const procs: ProcSample[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: +m[1]!, ppid: +m[2]!, rssKb: +m[3]!, command: m[4]! });
  }
  return procs;
}

export function scanMachine(): MachineSample {
  assertDarwin();
  const swapOut = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
  const swap = swapOut.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
  const vmOut = execFileSync('vm_stat', [], { encoding: 'utf8' });
  const page = +(vmOut.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const free = vmOut.match(/Pages free:\s+(\d+)\./);
  return {
    swapTotalMb: swap ? Math.round(+swap[1]!) : null,
    swapUsedMb: swap ? Math.round(+swap[2]!) : null,
    freeMemMb: free ? Math.round((+free[1]! * page) / 1024 / 1024) : null,
  };
}
