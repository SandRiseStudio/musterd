import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configPath } from '../config.js';

/**
 * The ADR 166 slot-sweep series — the append-only JSONL that
 * `scripts/research/adr-166-slot-sweep.ts` writes and everything else reads.
 *
 * WHY THIS LIVES IN THE CLI RATHER THAN BESIDE THE SCRIPT. Two readers need to agree on one path
 * and one row shape: the sweep (writer, and the repeat-detector that decides whether to escalate)
 * and `musterd report` (the surface a human actually reads). A path duplicated in two files is a
 * path that drifts, and a drifted series reads as "no findings" — the instrument-that-looks-like-
 * it-is-working failure ADR 166 names as this family's recurring one. So: one constant, here,
 * imported by the script from `dist` exactly as it already imports `localSessionLiveness`.
 */

/** One sweep run's row, as the script appends it. Fields beyond these are ignored on read. */
export interface SweepSample {
  at: number;
  judged: number;
  disagreed: number;
  dangerous: number;
  demoted: number;
  workspaces: { workspace: string; seat?: string; demoted?: boolean }[];
}

/** The canonical series path: `~/.musterd/research/adr-166-slot-sweep.jsonl`, following the global
 *  config's home so a test (or `MUSTERD_CONFIG`) relocates the whole thing together. */
export function sweepSeriesPath(): string {
  return join(dirname(configPath()), 'research', 'adr-166-slot-sweep.jsonl');
}

function parseSample(line: string): SweepSample | undefined {
  try {
    const v = JSON.parse(line) as Partial<SweepSample>;
    if (typeof v.at !== 'number' || typeof v.demoted !== 'number') return undefined;
    return { ...v, workspaces: Array.isArray(v.workspaces) ? v.workspaces : [] } as SweepSample;
  } catch {
    return undefined;
  }
}

/**
 * Read the series oldest-first. A missing file means "never run", not an error — the report must be
 * able to say nothing rather than fail. A torn last line (a run killed mid-append) is skipped: one
 * bad line must never blind the reader to the good ones above it.
 */
export function readSweepSeries(path = sweepSeriesPath()): SweepSample[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: SweepSample[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const s = parseSample(line);
    if (s) out.push(s);
  }
  return out;
}

function demotedWorkspaces(s: SweepSample | undefined): string[] {
  return (s?.workspaces ?? []).filter((w) => w.demoted).map((w) => w.workspace);
}

/**
 * Workspaces `cur` demotes that `prev` demoted too — the escalation gate. Demotion is structural,
 * not transient (both judgements share one clock and one 10-minute threshold, so a session going
 * quiet mid-sweep makes *both* say not-live and produces no disagreement), so a repeat is near
 * certain when the finding is real. Confirming costs one interval and buys immunity from any
 * file-timing oddity, which is why the OS push waits for it and the log does not.
 */
export function repeatedDemotions(prev: SweepSample | undefined, cur: SweepSample): string[] {
  const before = new Set(demotedWorkspaces(prev));
  return demotedWorkspaces(cur).filter((w) => before.has(w));
}

export interface SweepFinding {
  /** When the finding was measured. */
  at: number;
  demoted: number;
  workspaces: string[];
  /** Those also demoted by the immediately-preceding run — a confirmed case. */
  repeated: string[];
}

/**
 * The newest run's finding, or `undefined` when the newest run was clean (or nothing has ever run).
 * Undefined-at-zero is deliberate: a health line printed on every report is wallpaper within a week,
 * and ADR 166's target for this metric is zero, so the only informative render is the exception.
 */
export function latestFinding(series: SweepSample[]): SweepFinding | undefined {
  const cur = series[series.length - 1];
  if (!cur || cur.demoted === 0) return undefined;
  return {
    at: cur.at,
    demoted: cur.demoted,
    workspaces: demotedWorkspaces(cur),
    repeated: repeatedDemotions(series[series.length - 2], cur),
  };
}
