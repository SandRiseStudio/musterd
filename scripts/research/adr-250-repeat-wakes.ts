/**
 * ADR 250 §Eval instrument 2 — "repeat wakes with an unchanged failure reason", as a re-runnable read.
 *
 * WHY THIS EXISTS. ADR 250 named three weekly reads and this one had never been run. ryder's note of
 * 2026-08-21 on that ADR says it exactly: "the instrument still has no periodic read — the fix makes
 * the repeats countable, it does not count them." #987 damped the guardian's raises on their reason
 * and carries a withheld count forward; that made ONE edge's repeats countable. Counting is this.
 *
 * The ADR predicts this number falls to ~zero once backlog item 1 (per-edge firing memory + a
 * spend-level breaker) lands. Item 1 has not landed, so a nonzero answer is the expected baseline —
 * which is also why the criterion can come out false: if item 1 ever ships and this still prints a
 * repeat count in the hundreds, item 1 did not work.
 *
 * READ-ONLY over `~/.musterd/musterd.db`. Touches no lane, no seat, no daemon. No spend.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/adr-250-repeat-wakes.ts [--json] [--days N]
 *
 * THE DEFINITION, and why it is this one.
 *
 * A REPEAT is a wake outcome on the same (member, lane_id, edge, reason) that has occurred before.
 * The count reported is attempts-beyond-the-first, so a group seen once contributes 0 and a group
 * seen 23 times contributes 22. That is the quantity ADR 250 asks for — "do not repeat a wake whose
 * twin just failed for a reason still true" — not the number of groups, which would flatter a rail
 * that re-derives the same conclusion two dozen times in one afternoon.
 *
 * WHY THE TWO HALVES ARE REPORTED SEPARATELY, and never summed into a headline.
 * ADR 250 §2 amended the doctrine to "spend-bearing wakes require a board transition; free state
 * moves may use clocks." So the two outcomes are NOT the same finding:
 *   - DEFERRED — the router declined before spawning. Costs nothing. Repeats here are churn the
 *     breaker cannot see, but they are not burned money, and reporting them as such would overclaim.
 *   - FAILED — a lease was taken and the wake did not land. `lease_expired` is the ADR's own named
 *     instance ("14 lease_expired failures in one day"). These are the spend-bearing repeats.
 * A single blended percentage would let a quiet week on one half hide a bad week on the other.
 *
 * READ THE SPAN, NOT ONLY THE COUNT. The printed `[Nm from ...]` is load-bearing. A group of 26
 * spread over 19 days is a seat that genuinely had a live session on 26 separate occasions; a group
 * of 23 inside 320 minutes is the pathology ADR 250 named. The count alone cannot tell them apart,
 * so this prints both rather than picking a cluster threshold nobody has argued for.
 *
 * TRAPS ALREADY PAID FOR — from ADR 250's own 2026-08-06 amendment. Do not re-key this on
 * `derivation`: `work_order` is emitted by the review loop too (50 leases from 2026-07-31), so
 * reading it as "the dispatch loop fired" is a conflation the ADR corrected in public. The
 * discriminator is `edge`, which `wake_leases` and the audit detail both carry. Two successive
 * acceptance criteria for the 2026-08-06 exercise could not come out false because they keyed on
 * fields shared by every wake shape; an acceptance criterion that cannot come out false is not a
 * criterion.
 *
 * ROWS THAT ALREADY EXIST. ADR 250 §Observability is explicit that its instruments read rows already
 * in the ledger. This reads `audit` only. If a future version needs a table that does not exist yet,
 * that is backlog item 1 — a different lane, and an ADR.
 */
// `node:sqlite`, not better-sqlite3: that dependency lives in packages/server, and a research script
// that has to be run from inside a workspace package is a script nobody re-runs.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The frozen baseline ADR 250 §Eval quotes, for the printed comparison. */
export const BASELINE = {
  taken: '2026-08-05',
  note: '8 lanes woke the same seat 2–5× each; one lane 5 leases ~30 minutes apart; 14 lease_expired in one day',
};

export type Outcome = 'deferred' | 'failed';

export interface Detail {
  lane_id?: string;
  edge?: string;
  reason?: string;
}

export interface Group {
  member: string;
  lane: string;
  edge: string;
  reason: string;
  outcome: Outcome;
  ts: number[];
}

/** An audit row reduced to what the grouping needs — the shape {@link groupRows} consumes. */
export interface WakeRow {
  ts: number;
  action: string;
  target: string | null;
  detail: string | null;
}

/** Field separator for {@link groupKey}. See that function's note on why it is not a space. */
const SEP = '\u0000';

/**
 * The identity a repeat is counted against.
 *
 * `outcome` is part of the key on purpose: a (member, lane, edge, reason) that deferred once and
 * later failed is two findings — one free, one spend-bearing — and collapsing them would let free
 * deferrals inflate the spend-bearing count.
 *
 * The separator is NUL, not a space, because reasons contain spaces ("run exited with code 1") and a
 * space-joined key is reachable from two different field splits. A separator that cannot occur in any
 * field is the difference between a key and a collision waiting for the right reason string.
 */
export function groupKey(member: string, d: Detail, outcome: Outcome): string {
  return [member, d.lane_id ?? '-', d.edge ?? '-', d.reason ?? '-', outcome].join(SEP);
}

/**
 * Fold audit rows into groups. A row whose `detail` will not parse is COUNTED and reported, never
 * dropped silently — an instrument that discards rows it cannot read prints a smaller number with
 * undiminished confidence, which is the failure mode this ADR is about.
 */
export function groupRows(rows: WakeRow[]): { groups: Group[]; unparseable: number } {
  const groups = new Map<string, Group>();
  let unparseable = 0;
  for (const r of rows) {
    let d: Detail;
    try {
      d = JSON.parse(r.detail ?? '{}') as Detail;
    } catch {
      unparseable++;
      continue;
    }
    const outcome: Outcome = r.action === 'residency.wake_deferred' ? 'deferred' : 'failed';
    const member = r.target ?? '(none)';
    const key = groupKey(member, d, outcome);
    const g = groups.get(key);
    if (g) g.ts.push(r.ts);
    else
      groups.set(key, {
        member,
        lane: d.lane_id ?? '-',
        edge: d.edge ?? '-',
        reason: d.reason ?? '-',
        outcome,
        ts: [r.ts],
      });
  }
  return { groups: [...groups.values()], unparseable };
}

export interface Summary {
  attempts: number;
  groups: number;
  repeatedGroups: number;
  repeats: number;
  share: number;
  worst: Array<{
    n: number;
    member: string;
    lane: string;
    edge: string;
    reason: string;
    first: string;
    last: string;
    spanMinutes: number;
  }>;
}

export function summarize(groups: Group[], outcome: Outcome): Summary {
  const mine = groups.filter((g) => g.outcome === outcome);
  const attempts = mine.reduce((s, g) => s + g.ts.length, 0);
  const repeats = mine.reduce((s, g) => s + Math.max(0, g.ts.length - 1), 0);
  const repeated = mine.filter((g) => g.ts.length > 1);
  const worst = [...repeated].sort((a, b) => b.ts.length - a.ts.length).slice(0, 8);
  return {
    attempts,
    groups: mine.length,
    repeatedGroups: repeated.length,
    repeats,
    // An empty window reports 0, not NaN: a rail that woke nobody has no repeats, and a NaN in a
    // weekly read is the kind of thing a reader rounds to "fine".
    share: attempts ? repeats / attempts : 0,
    worst: worst.map((g) => ({
      n: g.ts.length,
      member: g.member,
      lane: g.lane,
      edge: g.edge,
      reason: g.reason,
      first: new Date(g.ts[0]!).toISOString(),
      last: new Date(g.ts[g.ts.length - 1]!).toISOString(),
      spanMinutes: Math.round((g.ts[g.ts.length - 1]! - g.ts[0]!) / 60000),
    })),
  };
}

function read(dbPath: string, sinceMs: number | null) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT ts, action, target, detail FROM audit
        WHERE action IN ('residency.wake_deferred','residency.wake_failed')
          AND (? IS NULL OR ts >= ?)
        ORDER BY ts`,
    )
    .all(sinceMs, sinceMs) as unknown as WakeRow[];
  db.close();
  return { ...groupRows(rows), rows: rows.length };
}

export function render(
  dbPath: string,
  days: number | null,
  deferred: Summary,
  failed: Summary,
  unparseable: number,
): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const out: string[] = [];
  out.push('ADR 250 §Eval — repeat wakes with an unchanged failure reason');
  out.push(`db ${dbPath}${days ? `  ·  last ${days}d` : '  ·  all time'}`);
  out.push(`baseline (${BASELINE.taken}): ${BASELINE.note}`);
  out.push('');
  out.push('A repeat = an outcome on a (member, lane, edge, reason) seen before, counted as');
  out.push('attempts-beyond-the-first. The two halves are never summed — ADR 250 §2.');
  out.push('');
  for (const [label, s, gloss] of [
    ['DEFERRED (free — the router declined before spawning)', deferred, 'churn, not spend'],
    ['FAILED   (a lease was taken and the wake did not land)', failed, 'spend-bearing'],
  ] as const) {
    out.push(`${label}  — ${gloss}`);
    out.push(
      `  ${s.attempts} outcomes · ${s.groups} distinct (member,lane,edge,reason) · ` +
        `${s.repeatedGroups} repeated · ${s.repeats} repeats (${pct(s.share)} of outcomes)`,
    );
    for (const w of s.worst) {
      out.push(
        `    ${String(w.n).padStart(3)}×  ${w.member} · ${w.lane} · ${w.edge} · ${w.reason.slice(0, 44)}` +
          `  [${w.spanMinutes}m from ${w.first.slice(0, 16)}]`,
      );
    }
    out.push('');
  }
  if (unparseable)
    out.push(`${unparseable} audit row(s) had unparseable detail and were excluded.`);
  out.push('ADR 250 predicts ~zero once backlog item 1 lands. Item 1 has not landed.');
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  const dIdx = argv.indexOf('--days');
  const days = dIdx >= 0 ? Number(argv[dIdx + 1]) : null;
  const since = days && Number.isFinite(days) ? Date.now() - days * 86_400_000 : null;

  const dbPath = process.env.MUSTERD_DB ?? join(homedir(), '.musterd', 'musterd.db');
  const { groups, rows, unparseable } = read(dbPath, since);
  const deferred = summarize(groups, 'deferred');
  const failed = summarize(groups, 'failed');

  if (wantJson) {
    process.stdout.write(
      `${JSON.stringify({ db: dbPath, windowDays: days, rows, unparseable, baseline: BASELINE, deferred, failed }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`${render(dbPath, days, deferred, failed, unparseable)}\n`);
}

// Only when run directly — the test imports the pure halves and must not touch the live ledger.
if (process.argv[1]?.endsWith('adr-250-repeat-wakes.ts')) main();
