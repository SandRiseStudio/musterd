// Footprint store (seat-footprint design) — persistence for the sampler's
// ticks. One tick = one machine row + zero-or-more sidecar-stack rows sharing
// its ts. Reads answer only "what does the machine look like now" (latest
// tick); history stays queryable in sqlite for the eval loop until retention
// prunes it.
import type { Database } from 'better-sqlite3';

export interface FootprintStackRow {
  ts: number;
  classification: 'live' | 'orphaned' | 'unattributed';
  /** Attributed seat name when known; null is honest ambiguity, never guessed. */
  seat: string | null;
  procs: number;
  rss_kb: number;
  /** JSON-encoded pid array — the reap surface re-verifies these before any kill. */
  pids: string;
}

export interface FootprintMachineRow {
  ts: number;
  swap_used_mb: number | null;
  swap_total_mb: number | null;
  free_mem_mb: number | null;
}

export interface FootprintTick {
  ts: number;
  stacks: FootprintStackRow[];
  machine: FootprintMachineRow;
}

export function insertFootprintTick(
  db: Database,
  stacks: FootprintStackRow[],
  machine: FootprintMachineRow,
): void {
  const insertMachine = db.prepare(
    `INSERT INTO footprint_machine (ts, swap_used_mb, swap_total_mb, free_mem_mb)
     VALUES (@ts, @swap_used_mb, @swap_total_mb, @free_mem_mb)
     ON CONFLICT(ts) DO UPDATE SET
       swap_used_mb = excluded.swap_used_mb,
       swap_total_mb = excluded.swap_total_mb,
       free_mem_mb = excluded.free_mem_mb`,
  );
  const insertStack = db.prepare(
    `INSERT INTO footprint_stacks (ts, classification, seat, procs, rss_kb, pids)
     VALUES (@ts, @classification, @seat, @procs, @rss_kb, @pids)`,
  );
  db.transaction(() => {
    insertMachine.run(machine);
    for (const s of stacks) insertStack.run(s);
  })();
}

export function latestFootprint(db: Database): FootprintTick | null {
  const machine = db
    .prepare<
      [],
      FootprintMachineRow
    >('SELECT ts, swap_used_mb, swap_total_mb, free_mem_mb FROM footprint_machine ORDER BY ts DESC LIMIT 1')
    .get();
  if (!machine) return null;
  const stacks = db
    .prepare<[number], FootprintStackRow>(
      `SELECT ts, classification, seat, procs, rss_kb, pids
       FROM footprint_stacks WHERE ts = ? ORDER BY rss_kb DESC`,
    )
    .all(machine.ts);
  return { ts: machine.ts, stacks, machine };
}

/** Drop ticks strictly older than cutoffTs; returns the number of machine rows removed. */
export function pruneFootprint(db: Database, cutoffTs: number): number {
  return db.transaction(() => {
    db.prepare('DELETE FROM footprint_stacks WHERE ts < ?').run(cutoffTs);
    const res = db.prepare('DELETE FROM footprint_machine WHERE ts < ?').run(cutoffTs);
    return res.changes;
  })();
}
