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
 * Read-only. Touches no seat, no daemon, no lane. Append-only JSONL so samples accumulate across runs.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/adr-166-slot-sweep.ts [--out <path>] [--json]
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Imports the BUILT cli — the same artifact the wake guard loads, so the sweep cannot drift from
// what production actually judges. Run `pnpm build` first.
import { localSessionLiveness } from '../../packages/cli/dist/session/liveness.js';

interface WorkspaceSample {
  workspace: string;
  seat?: string;
  slot: string;
  shadow?: string;
  /** How many sessions the harness actually has here. The slot can only ever describe one. */
  count?: number;
  disagreed?: boolean;
  /** The money-losing direction: slot says no live session, enumeration says there is one. */
  dangerous?: boolean;
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
} {
  const rows: WorkspaceSample[] = [];
  for (const { path, seat } of registryWorkspaces()) {
    let v;
    try {
      v = localSessionLiveness(path, now);
    } catch {
      continue; // a workspace that has been deleted out from under the registry — not a datum
    }
    rows.push({
      workspace: path,
      ...(seat ? { seat } : {}),
      slot: v.state,
      ...(v.shadow
        ? {
            shadow: v.shadow.state,
            count: v.shadow.count,
            disagreed: v.shadow.disagreed,
            ...(v.shadow.dangerous ? { dangerous: true } : {}),
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
  };
}

if (process.argv[1]?.endsWith('adr-166-slot-sweep.ts')) {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > -1 ? process.argv[outIdx + 1] : undefined;
  const s = sweep();
  if (out) appendFileSync(out, JSON.stringify(s) + '\n');
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(s, null, 1) + '\n');
  } else {
    process.stdout.write(
      `sweep ${new Date(s.at).toISOString()} — ${s.judged} judgeable, ` +
        `${s.disagreed} disagreed, ${s.dangerous} DANGEROUS\n`,
    );
    for (const r of s.workspaces.filter((r) => r.disagreed)) {
      process.stdout.write(
        `  ${r.dangerous ? 'DANGEROUS' : 'disagreed'}  ${r.workspace}` +
          `  slot=${r.slot} shadow=${r.shadow} sessions=${String(r.count)}\n`,
      );
    }
  }
}
