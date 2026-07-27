/**
 * ADR 166 — how often is `binding.session` wrong, and in which direction?
 *
 * WHY THIS EXISTS RATHER THAN THE DATASET THE ADR PRE-REGISTERED. ADR 166 increment 1 says to flip
 * to enumeration "once increment 1 shows the disagreement rate ... on real wake decisions". Measured
 * afterwards: the daemon has recorded **31 wake leases in total, at 1–3 per day**. A disagreement is
 * only observable when a wake happens to land on a workspace that happens to hold a phantom capture,
 * so that dataset reaches useful n in months, not days. The gate as written would have stalled the
 * increment silently — the same failure shape ADR 164 hit twice, an instrument that looks like it is
 * working while producing nothing.
 *
 * So this sweeps the fleet instead: every workspace in the binding registry (ADR 020), both
 * judgements, on a schedule. It is a **proxy and is labelled as one** — it measures how often the
 * slot is wrong AT REST, whereas the cost lands at wake time. The proxy is tight because the guard
 * calls exactly this function: a workspace whose slot is wrong right now is a workspace where a wake
 * arriving right now would be misjudged. What it cannot capture is whether wakes correlate with
 * phantoms (they may: both cluster on busy workspaces), so the sweep bounds the error rate the guard
 * is exposed to, not the rate at which it is actually bitten.
 *
 * Read-only over the fleet. Touches no seat, no daemon, no lane — which is the property that makes
 * it safe to run on a timer. Append-only JSONL so samples accumulate across runs.
 *
 * SCHEDULED (ADR 166 follow-through): `musterd service install --sweep` runs this every 5 minutes.
 * The cadence is derived, not chosen by taste — a `demoted` case persists for at least
 * `LOCAL_SESSION_LIVE_MS` (10 min) from the last touch of the slot's transcript, so any interval
 * ≤10 min cannot miss an instance and 5 min leaves margin for launchd drift and sleep. Sampling
 * slower would make ADR 166's "target: zero" claim unfalsifiable rather than merely unproven.
 *
 * ESCALATION. Zero demoted is silent — the target is zero, so an always-on line is wallpaper.
 * A hit logs loudly and exits non-zero (so the launchd log and any wrapper both see a real
 * failure), and shows up in `musterd report` until it clears. Only a workspace demoted by two
 * consecutive runs fires an OS push: demotion is structural rather than transient (both judgements
 * share one clock and one threshold, so a session going quiet mid-sweep makes *both* say not-live
 * and produces no disagreement), so a real finding repeats and the confirm costs one interval.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/adr-166-slot-sweep.ts [--out <path>] [--json] [--quiet]
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// Imports the BUILT cli — the same artifact the wake guard loads, so the sweep cannot drift from
// what production actually judges. Run `pnpm build` first.
import { osNotify } from '../../packages/cli/dist/notify/os.js';
import { localSessionLiveness } from '../../packages/cli/dist/session/liveness.js';
import {
  readSweepSeries,
  repeatedDemotions,
  sweepSeriesPath,
} from '../../packages/cli/dist/session/sweep-series.js';

interface WorkspaceSample {
  workspace: string;
  seat?: string;
  slot: string;
  /** The enumerated verdict — since increment 2 this is also the ACTED-ON verdict. The field keeps
   *  its pre-flip name so the JSONL series stays one series. */
  shadow?: string;
  /** How many sessions the harness actually has here. The slot can only ever describe one. */
  count?: number;
  disagreed?: boolean;
  /** The direction that was money-losing pre-flip: slot says no live session, enumeration says
   *  there is one. Post-flip the guard acts on enumeration, so this is a case CAUGHT, not a risk. */
  dangerous?: boolean;
  /** Post-flip watch metric (ADR 166 eval item 3): slot says live, enumeration disagrees —
   *  enumeration may be demoting a live seat. Any instance is a finding. */
  demoted?: boolean;
}

function registryWorkspaces(home = homedir()): { path: string; seat?: string }[] {
  try {
    const cfg = JSON.parse(readFileSync(join(home, '.musterd', 'config.json'), 'utf8')) as {
      bindings?: Record<string, { seat?: string }>;
    };
    return Object.entries(cfg.bindings ?? {}).map(([path, v]) => ({
      path,
      ...(v?.seat ? { seat: v.seat } : {}),
    }));
  } catch {
    return [];
  }
}

export function sweep(now = Date.now()): {
  at: number;
  workspaces: WorkspaceSample[];
  judged: number;
  disagreed: number;
  dangerous: number;
  demoted: number;
} {
  const rows: WorkspaceSample[] = [];
  for (const { path, seat } of registryWorkspaces()) {
    let v;
    try {
      v = localSessionLiveness(path, now);
    } catch {
      continue; // a workspace that has been deleted out from under the registry — not a datum
    }
    // Post-flip shape (ADR 166 inc 2): v.state IS the enumerated verdict when source==='enumerated',
    // and the slot's counter-verdict lives in v.slotState.
    rows.push({
      workspace: path,
      ...(seat ? { seat } : {}),
      slot: v.source === 'enumerated' ? (v.slotState ?? 'none') : v.state,
      ...(v.source === 'enumerated' && v.enumerated
        ? {
            shadow: v.state,
            count: v.enumerated.count,
            disagreed: v.disagreed ?? false,
            ...(v.disagreed && v.state === 'live' ? { dangerous: true } : {}),
            ...(v.demoted ? { demoted: true } : {}),
          }
        : {}),
    });
  }
  // Only workspaces where the harness could enumerate are judgeable; the rest have no challenger and
  // must not dilute the denominator into looking healthier than it is.
  const judged = rows.filter((r) => r.shadow !== undefined);
  return {
    at: now,
    workspaces: rows,
    judged: judged.length,
    disagreed: judged.filter((r) => r.disagreed).length,
    dangerous: judged.filter((r) => r.dangerous).length,
    demoted: judged.filter((r) => r.demoted).length,
  };
}

if (process.argv[1]?.endsWith('adr-166-slot-sweep.ts')) {
  const outIdx = process.argv.indexOf('--out');
  // Defaults to the canonical series (shared with `musterd report` via one exported constant) so a
  // scheduled run and a hand-run land in the SAME file — two series is how a repeat goes unnoticed.
  const out = outIdx > -1 ? process.argv[outIdx + 1] : sweepSeriesPath();
  // Read before appending: the last row is the previous run, the other half of the repeat test.
  const previous = readSweepSeries(out).pop();

  const s = sweep();
  mkdirSync(dirname(out), { recursive: true });
  appendFileSync(out, JSON.stringify(s) + '\n');

  const repeated = repeatedDemotions(previous, s);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ ...s, repeated }, null, 1) + '\n');
  } else if (!process.argv.includes('--quiet') || s.demoted > 0) {
    // --quiet keeps a clean scheduled run out of the log entirely; a finding always speaks.
    const line =
      `sweep ${new Date(s.at).toISOString()} — ${s.judged} judgeable, ` +
      `${s.disagreed} disagreed, ${s.dangerous} caught-by-flip, ${s.demoted} DEMOTED\n`;
    (s.demoted > 0 ? process.stderr : process.stdout).write(line);
    for (const r of s.workspaces.filter((r) => r.disagreed)) {
      (r.demoted ? process.stderr : process.stdout).write(
        `  ${r.demoted ? (repeated.includes(r.workspace) ? 'DEMOTED(repeat)' : 'DEMOTED') : r.dangerous ? 'caught' : 'disagreed'}` +
          `  ${r.workspace}  slot=${r.slot} shadow=${r.shadow} sessions=${String(r.count)}\n`,
      );
    }
  }

  if (repeated.length > 0) {
    // A confirmed case: enumeration has demoted the same live workspace twice running. This is the
    // one direction ADR 166 says would make the flip worse than what it replaced, so it earns the
    // away-human channel (ADR 035/024) rather than waiting to be read.
    osNotify({
      id: `adr166-demoted-${String(s.at)}`,
      title: 'musterd — liveness demoted (ADR 166)',
      body: `${repeated.length} workspace(s) judged not-live while the slot says live: ${repeated.join(', ')}`,
    });
  }
  // Non-zero on a finding so launchd's log and any wrapper see a real failure, never a quiet no-op.
  if (s.demoted > 0) process.exitCode = 1;
}
