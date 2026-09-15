/**
 * ADR 250 §Eval instrument 1 — "asks-to-founder per merged PR", the headline weekly read.
 *
 * WHY THIS EXISTS. ADR 250 restated the loop family's governing goal as "maximize verified
 * throughput per unit of human judgment" and made the founder's ask queue the DENOMINATOR, not a
 * fixed cost. This is the instrument that reads the denominator. It had never been run: the wiki
 * recorded "prose instructions, no instrument, no schedule" until this file.
 *
 * The ADR predicts this ratio FALLS as backlog item 2 (the merge loop) and item 4 (acceptance
 * absorption) land — merge authorization and standard-tier acceptance were the two largest
 * delegable classes in the 2026-08-05 corpus. A ratio that does not fall after those land is the
 * finding that they did not work, which is why the criterion can come out false.
 *
 * READ-ONLY over `~/.musterd/musterd.db`. Touches no lane, no seat, no daemon. No spend.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/adr-250-asks-per-pr.ts [--json] [--days N]
 *
 * THE DEFINITION, and why it is this one.
 *
 * An ASK-TO-FOUNDER is a `messages` row with act='ask', to_kind='member', whose recipient is a
 * kind='human' member — the ADR's own words are "directed `ask` acts in `messages`". Team-wide
 * asks (to_kind='team') are not directed at the founder's judgment and are not counted; an
 * unanswered team ask does not sit in one human's queue. Humans are identified by the members
 * table, not by hardcoding 'nick' — the roster carries several human rows (driver, web-*
 * visitors), and the per-recipient breakdown is printed so a future second human is visible
 * rather than silently folded in.
 *
 * A MERGED PR is an audit row with action 'git.pr_merged' — the ADR's named join. The ratio is
 * asks-to-humans / merged PRs over the same window: how much founder judgment each landed PR
 * cost. The per-ISO-week series is printed because a single window ratio hides the trend the
 * ADR actually cares about.
 *
 * ZERO PRs IS NOT NaN. A week with merged PRs = 0 and asks > 0 prints 'no merged PRs' — the
 * honest reading — not a NaN a reader rounds to "fine" and not a 0 that flatters the loops.
 *
 * ROWS THAT ALREADY EXIST. ADR 250 §Observability is explicit that its instruments read rows
 * already in the ledger. This reads `messages` and `audit` only.
 */
// `node:sqlite`, not better-sqlite3: that dependency lives in packages/server, and a research script
// that has to be run from inside a workspace package is a script nobody re-runs.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The frozen baselines ADR 250 §Eval quotes, for the printed comparison. */
export const BASELINE = {
  taken: '2026-08-05',
  note: '26 open founder-directed asks; the 2026-07-28 day had 40 merged PRs steered by 23 manually started sessions',
};

export interface AskRow {
  ts: number;
  to_member: string | null;
}

export interface PrRow {
  ts: number;
}

export interface WeekBucket {
  /** ISO week label, e.g. 2026-W32. */
  week: string;
  asks: number;
  prs: number;
}

/** Monday-starting ISO week label for a millisecond epoch. */
export function isoWeek(ts: number): string {
  const d = new Date(ts);
  // ISO week date: week starts Monday; the week's year is the year of its Thursday.
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const thursday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 3 - day),
  );
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - firstDay);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Fold asks and merged PRs into per-week buckets. Rows outside [sinceMs, nowMs] are dropped by
 * the query, not here — this folds what it is given, so the tests can drive it with bare arrays.
 */
export function bucketByWeek(asks: AskRow[], prs: PrRow[]): WeekBucket[] {
  const weeks = new Map<string, WeekBucket>();
  const bucket = (ts: number): WeekBucket => {
    const w = isoWeek(ts);
    let b = weeks.get(w);
    if (!b) {
      b = { week: w, asks: 0, prs: 0 };
      weeks.set(w, b);
    }
    return b;
  };
  for (const a of asks) bucket(a.ts).asks++;
  for (const p of prs) bucket(p.ts).prs++;
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/** asks-per-PR for one bucket; null when there are no merged PRs (rendered as its own words). */
export function ratio(b: WeekBucket): number | null {
  return b.prs === 0 ? null : b.asks / b.prs;
}

export interface Summary {
  windowDays: number | null;
  asks: number;
  prs: number;
  /** asks / prs over the whole window; null when prs = 0. */
  ratio: number | null;
  /** asks per recipient name, descending — the founder is a row, not an assumption. */
  byRecipient: Array<{ name: string; asks: number }>;
  weeks: WeekBucket[];
}

export function summarize(
  asks: AskRow[],
  prs: PrRow[],
  recipientNames: Map<string, string>,
  windowDays: number | null,
): Summary {
  const byRecipient = new Map<string, number>();
  for (const a of asks) {
    const name = (a.to_member && recipientNames.get(a.to_member)) || '(unknown)';
    byRecipient.set(name, (byRecipient.get(name) ?? 0) + 1);
  }
  return {
    windowDays,
    asks: asks.length,
    prs: prs.length,
    ratio: prs.length ? asks.length / prs.length : null,
    byRecipient: [...byRecipient.entries()]
      .map(([name, n]) => ({ name, asks: n }))
      .sort((a, b) => b.asks - a.asks),
    weeks: bucketByWeek(asks, prs),
  };
}

function read(dbPath: string, sinceMs: number | null) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const humans = db
      .prepare(`SELECT id, name FROM members WHERE kind = 'human'`)
      .all() as unknown as Array<{ id: string; name: string }>;
    const names = new Map(humans.map((h) => [h.id, h.name]));
    const asks =
      humans.length === 0
        ? []
        : (db
            .prepare(
              `SELECT ts, to_member FROM messages
                WHERE act = 'ask' AND to_kind = 'member'
                  AND to_member IN (SELECT id FROM members WHERE kind = 'human')
                  AND (? IS NULL OR ts >= ?)
                ORDER BY ts`,
            )
            .all(sinceMs, sinceMs) as unknown as AskRow[]);
    const prs = db
      .prepare(
        `SELECT ts FROM audit
          WHERE action = 'git.pr_merged' AND (? IS NULL OR ts >= ?)
          ORDER BY ts`,
      )
      .all(sinceMs, sinceMs) as unknown as PrRow[];
    return { asks, prs, names };
  } finally {
    db.close();
  }
}

export function render(dbPath: string, s: Summary): string {
  const out: string[] = [];
  out.push('ADR 250 §Eval — asks-to-founder per merged PR (the headline)');
  out.push(`db ${dbPath}${s.windowDays ? `  ·  last ${s.windowDays}d` : '  ·  all time'}`);
  out.push(`baseline (${BASELINE.taken}): ${BASELINE.note}`);
  out.push('');
  out.push(
    `window: ${s.asks} asks to humans · ${s.prs} merged PRs · ` +
      (s.ratio === null
        ? 'no merged PRs — the ratio is unbounded, not zero'
        : `ratio ${s.ratio.toFixed(2)} asks/PR`),
  );
  out.push('');
  out.push('per recipient:');
  for (const r of s.byRecipient) out.push(`  ${String(r.asks).padStart(4)}  ${r.name}`);
  out.push('');
  out.push('per ISO week (the trend is the read, not the window):');
  out.push('  week        asks   prs   asks/PR');
  for (const w of s.weeks) {
    const r = ratio(w);
    out.push(
      `  ${w.week}  ${String(w.asks).padStart(5)} ${String(w.prs).padStart(5)}   ${r === null ? '—' : r.toFixed(2)}`,
    );
  }
  out.push('');
  out.push('ADR 250 predicts this falls as the merge loop (item 2) and acceptance absorption');
  out.push('(item 4) land. A ratio that does not fall after they land is the finding.');
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  const dIdx = argv.indexOf('--days');
  const days = dIdx >= 0 ? Number(argv[dIdx + 1]) : null;
  const since = days && Number.isFinite(days) ? Date.now() - days * 86_400_000 : null;

  const dbPath = process.env.MUSTERD_DB ?? join(homedir(), '.musterd', 'musterd.db');
  const { asks, prs, names } = read(dbPath, since);
  const s = summarize(asks, prs, names, days);

  if (wantJson) {
    process.stdout.write(`${JSON.stringify({ db: dbPath, baseline: BASELINE, ...s }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${render(dbPath, s)}\n`);
}

// Only when run directly — the test imports the pure halves and must not touch the live ledger.
if (process.argv[1]?.endsWith('adr-250-asks-per-pr.ts')) main();
