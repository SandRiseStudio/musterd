/**
 * How often could a cross-family review have happened at all? — asked of the ROSTER, not inferred
 * from the lanes that were already swept.
 *
 * WHY THIS EXISTS. ADR 277 measures the same worry from the wreckage: it groups swept closes by
 * `ask_outcome` to find how many lanes nobody was ever asked to review. That works, but swept
 * closes arrive at ~0.6/day, so a ±10pp read needs n≈72 — roughly 120 days. The daemon records
 * `family_posture` on `lane.ready_for_review` rows, which is the same question asked directly,
 * with n in the dozens already on disk.
 *
 * THE ESTIMAND IS CONDITIONAL FOR ROWS BEFORE 2026-08-17, and the headline says so. Until the fix
 * that accompanied this restatement (lane 01M08AMC4F, declined by miley 2026-08-17), the daemon
 * wrote `family_posture` ONLY on the degraded routing paths — no reviewer pickable, wake queued,
 * or breaker tripped (http.ts: `postureForAudit`). A submit that routed cleanly recorded a
 * `reviewer` and NO posture, so it was invisible here. The pre-fix headline therefore reads
 * "among submits where routing degraded, X% had no cross-family counterpart" — NOT the
 * unconditional rate. The exclusion is not random: on the 2026-08-17 ledger, 147 of 159
 * posture-less rows carried a reviewer, against 36 of 87 sampled rows. The unconditional number
 * is bracketed instead: the FLOOR counts every posture-less ready row as if a cross-family review
 * had been possible there, the sampled share is the ceiling. Rows written after the fix carry a
 * posture on clean routes too, so the conditioning washes out as new data accrues.
 *
 * The two are complements, not rivals. This one says whether the roster COULD have reviewed;
 * ADR 277's says what actually happened to the lane. When they disagree, that disagreement is the
 * finding.
 *
 * SAMPLING FRAME, stated because it is a choice and not an accident. This samples AT SUBMIT — the
 * moment a review is needed — rather than uniformly in wall-clock. A 3am sample where nobody is
 * working would be noise about a question nobody asked. So the number answers "when work was ready
 * for review, how often was a cross-family counterpart available", which is the decision's own
 * frame. It is NOT "what fraction of the day is this team a monoculture", and must not be quoted
 * as if it were.
 *
 * READ-ONLY over `~/.musterd/musterd.db`. Touches no lane, no seat, no daemon.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/roster-diversity.ts [--json]
 *
 * DEFINITIONS, taken from `packages/server/src/store/review.ts:231` rather than invented here:
 *   diverse     — ≥2 distinct model families attesting live
 *   monoculture — ≥2 attesting, all one family
 *   unknown     — <2 attesting
 *
 * The headline folds `monoculture` AND `unknown` together, because both mean the ladder had no
 * cross-family counterpart to route to. `unknown` is not missing data — it is a roster too thin to
 * hold two seats, which is the same outcome by a different road. Reporting `monoculture` alone
 * understates the condition, and that is the mistake this file is shaped to prevent.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface PostureSample {
  ts: number;
  state: 'diverse' | 'monoculture' | 'unknown';
  attesting: number;
  families: Record<string, number>;
}

export interface Interval {
  lo: number;
  hi: number;
}

/**
 * Wilson score interval — used rather than the normal approximation because the shares here sit
 * near the ends (81%, and small n), exactly where the naive interval runs past 0 or 1 and stops
 * meaning anything. `null` on an empty sample: no observations is not the same as "0% to 100%".
 */
export function wilson(p: number, n: number, z = 1.96): Interval | null {
  if (n <= 0) return null;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

export interface Summary {
  n: number;
  diverse: number;
  monoculture: number;
  unknown: number;
  /** monoculture + unknown: the ladder had no cross-family counterpart either way. */
  noCrossFamily: number;
  /** `null` at n=0 — a share of nothing is not zero. */
  noCrossFamilyShare: number | null;
  ci: Interval | null;
}

export function summarise(samples: PostureSample[]): Summary {
  const diverse = samples.filter((s) => s.state === 'diverse').length;
  const monoculture = samples.filter((s) => s.state === 'monoculture').length;
  const unknown = samples.filter((s) => s.state === 'unknown').length;
  const n = samples.length;
  const noCrossFamily = monoculture + unknown;
  const share = n > 0 ? noCrossFamily / n : null;
  return {
    n,
    diverse,
    monoculture,
    unknown,
    noCrossFamily,
    noCrossFamilyShare: share,
    ci: share === null ? null : wilson(share, n),
  };
}

export interface Floor {
  noCrossFamily: number;
  /** Every ready row, posture or not — the denominator the conditional headline cannot use. */
  readyRows: number;
  share: number | null;
}

/**
 * The unconditional FLOOR: count every posture-less ready row as if a cross-family review had been
 * possible there. Excluded rows are overwhelmingly clean routes (see LoadResult.excluded), and a
 * clean route does not prove diversity — the picker can route same-family — so the true
 * unconditional rate sits somewhere between this floor and the conditional (sampled) share.
 */
export function floorOverReadyRows(s: Summary, excluded: number): Floor {
  const readyRows = s.n + excluded;
  return {
    noCrossFamily: s.noCrossFamily,
    readyRows,
    share: readyRows > 0 ? s.noCrossFamily / readyRows : null,
  };
}

export interface DayRow {
  day: string;
  n: number;
  noCrossFamily: number;
}

/**
 * The per-day series, because the aggregate hides the shape. Measured 2026-08-17: 17/17 on 08-05
 * but 2/4 on 08-13 — diversity appears when the non-claude seats are awake. "How often does it
 * clear, and for how long" is a different and arguably more actionable question than the headline,
 * and a single percentage cannot express it.
 */
export function dailySeries(samples: PostureSample[]): DayRow[] {
  const by = new Map<string, DayRow>();
  for (const s of samples) {
    const day = new Date(s.ts).toISOString().slice(0, 10);
    const row = by.get(day) ?? { day, n: 0, noCrossFamily: 0 };
    row.n += 1;
    if (s.state !== 'diverse') row.noCrossFamily += 1;
    by.set(day, row);
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export interface LoadResult {
  samples: PostureSample[];
  /**
   * Ready rows carrying NO `family_posture`. These do NOT predate the field — they span the same
   * date range as the sampled rows. Before 2026-08-17 the daemon simply omitted the posture on
   * clean routes, so exclusion is CORRELATED WITH ROUTING SUCCESS and the sampled share is a
   * conditional rate, not the population rate. See the header, and `floor` in Summary.
   */
  excluded: number;
  /** Of the excluded rows, how many recorded a `reviewer` — i.e. routed cleanly. */
  excludedWithReviewer: number;
}

/**
 * Read the recorded postures. Rows carrying no posture are excluded from the conditional sample
 * and reported, with the reviewer-bearing count split out: a denominator that quietly swallows
 * rows which recorded nothing is how an instrument reports a share of a population it never
 * observed — and this instrument did exactly that until miley's decline caught it.
 */
export function load(
  dbPath = process.env['MUSTERD_DB'] ?? join(homedir(), '.musterd', 'musterd.db'),
): LoadResult {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // `node:sqlite` (not better-sqlite3) — its `prepare` carries no row generics, so the shape is
  // asserted at the boundary exactly as the ADR 260 eval does. One cast, at the edge, where the
  // schema is the thing being trusted.
  const rows = db
    .prepare(`SELECT ts, detail FROM audit WHERE action = 'lane.ready_for_review' ORDER BY ts ASC`)
    .all() as { ts: number; detail: string | null }[];
  const samples: PostureSample[] = [];
  let excluded = 0;
  let excludedWithReviewer = 0;
  for (const r of rows) {
    let posture: PostureSample['state'] | undefined;
    let attesting = 0;
    let families: Record<string, number> = {};
    let hadReviewer = false;
    try {
      const d = JSON.parse(r.detail ?? '{}') as {
        reviewer?: string;
        family_posture?: {
          state?: string;
          attesting?: number;
          families?: Record<string, number>;
        };
      };
      hadReviewer = typeof d.reviewer === 'string';
      const fp = d.family_posture;
      if (fp?.state === 'diverse' || fp?.state === 'monoculture' || fp?.state === 'unknown') {
        posture = fp.state;
        attesting = fp.attesting ?? 0;
        families = fp.families ?? {};
      }
    } catch {
      // An unparseable detail is an excluded row, not a guess.
    }
    if (posture === undefined) {
      excluded += 1;
      if (hadReviewer) excludedWithReviewer += 1;
    } else samples.push({ ts: r.ts, state: posture, attesting, families });
  }
  return { samples, excluded, excludedWithReviewer };
}

function main(): void {
  const { samples, excluded, excludedWithReviewer } = load();
  const s = summarise(samples);
  const fl = floorOverReadyRows(s, excluded);
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        { ...s, excluded, excludedWithReviewer, floor: fl, series: dailySeries(samples) },
        null,
        2,
      ),
    );
    return;
  }
  const pct = (x: number) => (100 * x).toFixed(1) + '%';
  console.log('=== could a cross-family review have happened? (sampled at submit) ===');
  console.log(`  ready rows, total: ${fl.readyRows}`);
  console.log(`  with a recorded posture (the conditional sample): ${s.n}`);
  console.log(
    `  without one (excluded from the conditional sample): ${excluded}` +
      ` — ${excludedWithReviewer} of these routed to a reviewer`,
  );
  if (s.n === 0) {
    console.log('  nothing to report — no ready row carries family_posture yet.');
    return;
  }
  console.log(`    diverse ......................... ${s.diverse}`);
  console.log(`    monoculture (>=2, one family) ... ${s.monoculture}`);
  console.log(`    unknown (<2 attesting) .......... ${s.unknown}`);
  console.log(
    `  CONDITIONAL (among submits where a posture was recorded — before 2026-08-17 that means\n` +
      `  routing had already degraded): ${s.noCrossFamily}/${s.n} = ${pct(s.noCrossFamilyShare!)}` +
      (s.ci ? `  (95% CI ${pct(s.ci.lo)} - ${pct(s.ci.hi)})` : ''),
  );
  console.log(
    `  FLOOR (every posture-less row counted as if cross-family had been possible):\n` +
      `    ${fl.noCrossFamily}/${fl.readyRows} = ${pct(fl.share!)}`,
  );
  console.log(
    `  The unconditional rate sits between the two. Rows written after 2026-08-17 record a\n` +
      `  posture on clean routes as well, so the gap closes as new data accrues.`,
  );
  console.log('\n  by day (no-cross-family / samples with posture):');
  for (const d of dailySeries(samples)) console.log(`    ${d.day}  ${d.noCrossFamily}/${d.n}`);
  console.log(
    '\n  Frame: sampled when work was READY FOR REVIEW, not uniformly in wall-clock. This is not\n' +
      '  "what fraction of the day is this team a monoculture" and must not be quoted as if it were.',
  );
}

if (process.argv[1]?.endsWith('roster-diversity.ts')) main();
