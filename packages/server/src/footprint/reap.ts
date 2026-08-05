// Explicit orphan reaping (seat-footprint design). The ONLY kill path in the
// daemon, and it is triple-guarded: a pid is killed only when, re-verified
// against the live process table AT KILL TIME, it (a) still exists, (b) still
// matches the sidecar allowlist, and (c) is still orphaned (reparented to
// launchd). Anything else is refused with a named reason — a stale pid from a
// minute-old sample must never become a kill of whatever now wears that pid.
// SIGTERM first, a grace, then SIGKILL for survivors; one audit row records
// exactly what the verification let through.
import type { Database } from 'better-sqlite3';
import { appendAudit } from '../store/audit.js';
import { buildStacks, isSidecar, type ProcSample } from './classify.js';
import { scanProcesses as scanProcsDefault } from './scan.js';

export interface ReapDeps {
  scanProcs?: typeof scanProcsDefault;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** SIGTERM → SIGKILL grace. Injectable so tests never sleep. */
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReapResult {
  killed: number[];
  refused: { pid: number; reason: 'not_found' | 'not_sidecar' | 'not_orphaned' | 'unverifiable' }[];
}

export async function reapOrphans(
  db: Database,
  teamId: string,
  actor: string | null,
  pids: number[],
  deps: ReapDeps = {},
): Promise<ReapResult> {
  const scanProcs = deps.scanProcs ?? scanProcsDefault;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const graceMs = deps.graceMs ?? 3_000;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  // No scan, no kill: a platform where the process table cannot be read (or a transient ps
  // failure) refuses every pid rather than erroring — "cannot verify" and "verified ineligible"
  // both mean the same thing to the kill path, which only ever acts on positive verification.
  let procs: ProcSample[];
  try {
    procs = scanProcs();
  } catch {
    return { killed: [], refused: pids.map((pid) => ({ pid, reason: 'unverifiable' as const })) };
  }
  const byPid = new Map<number, ProcSample>(procs.map((p) => [p.pid, p]));
  const orphanPids = new Set(
    buildStacks(procs)
      .filter((s) => s.classification === 'orphaned')
      .flatMap((s) => s.pids),
  );

  const killed: number[] = [];
  const refused: ReapResult['refused'] = [];
  let rssKb = 0;
  for (const pid of pids) {
    const p = byPid.get(pid);
    if (!p) refused.push({ pid, reason: 'not_found' });
    else if (!isSidecar(p.command)) refused.push({ pid, reason: 'not_sidecar' });
    else if (!orphanPids.has(pid)) refused.push({ pid, reason: 'not_orphaned' });
    else {
      killed.push(pid);
      rssKb += p.rssKb;
    }
  }

  for (const pid of killed) {
    try {
      kill(pid, 'SIGTERM');
    } catch {
      /* already gone — the goal state */
    }
  }
  if (killed.length > 0) {
    await sleep(graceMs);
    for (const pid of killed) {
      try {
        kill(pid, 'SIGKILL');
      } catch {
        /* exited within the grace — normal */
      }
    }
    appendAudit(db, teamId, {
      actor,
      action: 'footprint.reaped',
      target: null,
      result: 'allow',
      detail: { killed, refused, rss_kb: rssKb },
    });
  }
  return { killed, refused };
}
