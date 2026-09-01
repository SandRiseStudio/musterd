/**
 * ADR 260 / quiet-set spec increment 1 — the pre-registered acceptance Eval, as a re-runnable query.
 *
 * WHY A SCRIPT AND NOT A NUMBER IN A MESSAGE. The Eval is pre-registered in two places (ADR 260
 * §Observability items 1–2, the spec's §Observability items 1–5) and its verdict decides whether
 * increment 2 — an ADR-gated protocol change — gets built at all. A number posted once cannot be
 * falsified by the next seat; this can. Re-run it and disagree with the numbers, not with my memory.
 *
 * READ-ONLY over `~/.musterd/musterd.db`. Touches no lane, no seat, no daemon.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/adr-260-acceptance-eval.ts [--json]
 *
 * THE WINDOW BOUNDARIES ARE EVIDENCE, NOT TASTE.
 *  - ARM  = 2026-08-12 21:14, the `policy.change` row that armed `stakes_defaults packages/web/**=low`.
 *    The spec conditions the whole dataset on "post-arming", because arming changes the population
 *    of lanes that route an ask at all, not only how fast they close.
 *  - ON   = 2026-08-13 10:02, the first autorefresh daemon bounce carrying #785 (33489b4c). NOT the
 *    merge time (09:33) and emphatically not the commit's author date (08-12): the filter is in the
 *    daemon, so it starts existing when the daemon restarts on a main that contains it.
 *    Falsify: `git merge-base --is-ancestor 33489b4c 5f9d427`.
 *
 * DEFINITIONS, taken from the spec rather than invented here:
 *  - live-routed = non-exempt, not human_required, not no_candidate, not wake_queued, reviewer set.
 *  - good        = the routed counterpart's `counterpart_confirm` within 10 minutes (nick's bar).
 *  - jumped route = closer is neither the asked reviewer nor the owner. The spec says drop these
 *    from the CONFIRM NUMERATOR — they stay in the denominator, because the ask that was routed
 *    still went unanswered. Dropping them from both (the tempting read) silently flatters every
 *    window that contains one.
 *  - the daemon (`musterd`) closing a swept or timed-out lane is the ADR 229 sweep, not a seat
 *    jumping the route. It is a plain miss and is counted as one.
 */
// `node:sqlite`, not better-sqlite3: that dependency lives in packages/server, and a research
// script that has to be run from inside a workspace package is a script nobody re-runs.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ARM = Date.parse('2026-08-12T21:14:00-07:00');
const ON = Date.parse('2026-08-13T10:02:00-07:00');
const BASELINE_START = Date.parse('2026-07-30T00:00:00-07:00');
const GOOD_MS = 10 * 60 * 1000;

interface ReadyDetail {
  lane: string;
  owner: string;
  reviewer?: string;
  route?: string;
  review_grade?: string;
  wake_queued?: boolean;
  no_candidate?: boolean;
  human_required?: boolean;
  acceptance_exempt?: boolean;
}
interface ClosedDetail {
  lane: string;
  closed_by: string;
  reason: string;
}
interface Submit {
  ts: number;
  d: ReadyDetail;
  close?: { ts: number; d: ClosedDetail };
}

function load(dbPath = process.env['MUSTERD_DB'] ?? join(homedir(), '.musterd', 'musterd.db')) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = (action: string) =>
    db.prepare('select ts, detail from audit where action = ? order by ts').all(action) as {
      ts: number;
      detail: string;
    }[];
  const closes = new Map<string, { ts: number; d: ClosedDetail }[]>();
  for (const r of rows('lane.closed')) {
    const d = JSON.parse(r.detail) as ClosedDetail;
    if (!closes.has(d.lane)) closes.set(d.lane, []);
    closes.get(d.lane)!.push({ ts: r.ts, d });
  }
  const seatFamily = new Map<string, string>();
  for (const r of db
    .prepare(
      "select actor, detail from audit where action = 'occupancy.model_attested' order by ts",
    )
    .all() as { actor: string; detail: string }[]) {
    const j = JSON.parse(r.detail) as { new?: string };
    if (r.actor && j.new) seatFamily.set(r.actor, familyOf(j.new));
  }
  const submits: Submit[] = rows('lane.ready_for_review').map((r) => {
    const d = JSON.parse(r.detail) as ReadyDetail;
    const close = (closes.get(d.lane) ?? []).find((c) => c.ts >= r.ts);
    return close ? { ts: r.ts, d, close } : { ts: r.ts, d };
  });
  return { db, submits, seatFamily };
}

/**
 * The population this instrument is entitled to reason about: submits the LADDER routed.
 *
 * `route: 'named'` (dolly's #1152, 2026-09-01) is excluded, and the exclusion is the load-bearing
 * line rather than a tidy-up. Every other filter here removes a submit the picker could not act on
 * — exempt, human-required, no candidate, queued to a wake. A named row is the opposite case: the
 * picker was ABLE and was overruled, because a human named the acceptor by hand. Counting it would
 * grade the ladder on a decision the ladder did not make, in both directions at once — a person
 * repeatedly routing to one trusted seat reads as the picker concentrating (the primary
 * pre-registered metric), and the honest `same_model` abstention a named route records would drag
 * `crossFamilyShare` down as if the ladder had settled for it.
 *
 * The general rule, which outlives this instance: an experimenter's hand in the population is not
 * data. Any future route value that means "chosen by something other than the ladder" belongs on
 * this exclusion list on arrival, BEFORE its first row lands — see the dated amendment beside
 * CONCENTRATION_PREDICTION.
 */
const liveRouted = (rs: Submit[]) =>
  rs.filter(
    (r) =>
      !r.d.acceptance_exempt &&
      !r.d.human_required &&
      !r.d.no_candidate &&
      !r.d.wake_queued &&
      r.d.route !== 'named' &&
      r.d.reviewer,
  );

export interface WindowResult {
  name: string;
  submits: number;
  liveRouted: number;
  wakeQueued: number;
  noCandidate: number;
  exempt: number;
  good: number;
  confirms: number;
  jumped: number;
  stillOpen: number;
  goodRate: number;
  medianAgeMin: number;
  over12hRate: number;
  perDay: number;
  topReviewer: [string, number] | null;
  crossFamilyShare: number;
}

export function evaluate(name: string, rs: Submit[]): WindowResult {
  const lr = liveRouted(rs);
  let good = 0;
  let confirms = 0;
  let jumped = 0;
  let stillOpen = 0;
  for (const r of lr) {
    if (!r.close) {
      stillOpen++;
      continue;
    }
    const { closed_by, reason } = r.close.d;
    const isJumped =
      closed_by !== r.d.reviewer && closed_by !== r.d.owner && closed_by !== 'musterd';
    if (isJumped) {
      jumped++;
      continue; // out of the numerator, still in the denominator
    }
    if (reason === 'counterpart_confirm') {
      confirms++;
      if (r.close.ts - r.ts <= GOOD_MS) good++;
    }
  }

  // Item 2 — uncensored age-at-close over every non-exempt submit, sweeps included.
  const ages = rs
    .filter((r) => !r.d.acceptance_exempt && r.close)
    .map((r) => (r.close!.ts - r.ts) / 60000)
    .sort((a, b) => a - b);

  const reviewers = new Map<string, number>();
  for (const r of lr) reviewers.set(r.d.reviewer!, (reviewers.get(r.d.reviewer!) ?? 0) + 1);
  const top = [...reviewers.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  const spanDays = rs.length ? Math.max((rs[rs.length - 1]!.ts - rs[0]!.ts) / 86_400_000, 1e-9) : 1;

  return {
    name,
    submits: rs.length,
    liveRouted: lr.length,
    wakeQueued: rs.filter((r) => r.d.wake_queued).length,
    noCandidate: rs.filter((r) => r.d.no_candidate).length,
    exempt: rs.filter((r) => r.d.acceptance_exempt).length,
    good,
    confirms,
    jumped,
    stillOpen,
    goodRate: lr.length ? good / lr.length : 0,
    medianAgeMin: ages.length ? ages[Math.floor(ages.length / 2)]! : 0,
    over12hRate: ages.length ? ages.filter((a) => a > 720).length / ages.length : 0,
    perDay: rs.filter((r) => !r.d.acceptance_exempt).length / spanDays,
    topReviewer: top,
    crossFamilyShare: lr.length
      ? lr.filter((r) => r.d.review_grade === 'cross_family').length / lr.length
      : 0,
  };
}

/** Item 5. ADR 252: `cost_usd_total` under-prices the failure path, so count leases and deferrals. */
function wakeVolume(db: DatabaseSync, lo: number, hi: number) {
  const n = (action: string) =>
    (
      db
        .prepare('select count(*) c from audit where action = ? and ts >= ? and ts < ?')
        .get(action, lo, hi) as { c: number }
    ).c;
  // DISTINCT ACTS, not leases. An act that cannot settle is re-leased, so the lease count is a
  // churn metric wearing a volume metric's clothes: measured 2026-08-14, one act held 12 leases and
  // leases-per-act ran 2.7 (baseline) → 5.2 (post-#785). Reporting leases alone is what let this
  // Eval's item 5 claim a 5x rise that was mostly the same handful of acts failing to settle.
  const leaseRows = db
    .prepare(
      "select detail from audit where action = 'residency.wake_leased' and ts >= ? and ts < ?",
    )
    .all(lo, hi) as { detail: string }[];
  const actIds = new Set(
    leaseRows.map((r) => {
      const j = JSON.parse(r.detail) as { act_id?: string; act?: string };
      return j.act_id ?? j.act ?? 'unknown';
    }),
  );
  return {
    leased: n('residency.wake_leased'),
    /** The honest volume figure — one per wake DECISION, however many times it was re-leased. */
    wakeDecisions: actIds.size,
    woke: n('residency.woke'),
    deferred: n('residency.wake_deferred'),
    failed: n('residency.wake_failed'),
    priced: n('residency.wake_cost'),
    hours: (hi - lo) / 3_600_000,
  };
}

/**
 * THE WINDOW GUARD — the reason this script exists as more than a query.
 *
 * The 2026-08-14 run's entire verdict was "unreadable": the window contained ADR 253 and the
 * arrival of the team's only cross-family seat, so neither the credit nor the disproof direction
 * survived. An instrument that cannot notice that condition will make the same mistake again and
 * report a number with a straight face. This one refuses.
 *
 * Two disqualifying classes, both pre-registered by what actually went wrong:
 *  - a `policy.change` audit row inside the window — arming a stakes default changes the POPULATION
 *    of lanes that route an ask at all, not merely their speed (spec §Confounds);
 *  - a commit touching the routing code inside the window — `review.ts` picks the counterpart,
 *    `orientation.ts` decides what re-surfaces, `envelope.ts` gates which acts may fan out.
 *
 * Deliberately NOT disqualifying: a new seat joining, which also moves the grade ladder. That is
 * the confound that broke the last run and it is invisible in both sources here — it shows up only
 * as a shift in `cross_family` share, which is why the printed comparison always carries that
 * column and why concentration is the PRIMARY metric on re-run rather than the 10-minute rate.
 */
export interface GuardVerdict {
  clean: boolean;
  reasons: string[];
}

export function windowGuard(
  policyChanges: number[],
  routingCommits: { sha: string; ts: number; subject: string }[],
  lo: number,
  hi: number,
): GuardVerdict {
  const reasons: string[] = [];
  const inWindow = (t: number) => t >= lo && t < hi;
  const policies = policyChanges.filter(inWindow);
  if (policies.length > 0) {
    reasons.push(
      `${policies.length} policy.change row(s) inside the window (${policies
        .map((t) => new Date(t).toISOString().slice(0, 16))
        .join(', ')}) — arming changes the population, not only its speed`,
    );
  }
  for (const c of routingCommits.filter((c) => inWindow(c.ts))) {
    reasons.push(
      `routing code changed inside the window: ${c.sha.slice(0, 8)} ${c.subject} ` +
        `(${new Date(c.ts).toISOString().slice(0, 16)})`,
    );
  }
  return { clean: reasons.length === 0, reasons };
}

/** Commits touching the files that decide who is asked, within [lo, hi). */
/**
 * WHO IS ASKED. These three decide the routing itself: who gets picked, what re-surfaces, which
 * acts may fan out. This is also the set a freeze would hold still.
 */
export const ROUTING_PATHS = [
  'packages/server/src/store/review.ts',
  'packages/server/src/store/orientation.ts',
  'packages/protocol/src/envelope.ts',
] as const;

/**
 * WHAT MOVES THE DENOMINATOR. Added 2026-08-14 after stanley's #844 showed the original predicate
 * was one category too narrow (their message, and verified here before believing it).
 *
 * Eval item 5 compares wake volume across the window. #844 touches none of the three paths above
 * and carries no `policy.change` row, so the old guard would have passed it and let the run read a
 * genuine lease-rate DROP as a routing result — the drop being re-lease churn disappearing once
 * refused reports could settle. A guard that watches "did routing change" while the statistic
 * depends on "did anything move the act/lease volume" is answering a question nobody asked.
 */
export const WAKE_PATHS = [
  'packages/protocol/src/residency.ts',
  'packages/server/src/store/residency.ts',
  'packages/cli/src/host',
] as const;

/** Everything a contaminated window can hide in — what the guard actually watches. */
export const WINDOW_PATHS = [...ROUTING_PATHS, ...WAKE_PATHS] as const;

export function routingCommitsSince(
  lo: number,
  hi: number,
  run: (args: string[]) => string,
): { sha: string; ts: number; subject: string }[] {
  // Argument array, never a shell string — no interpolation, no metacharacters, nothing to quote.
  const out = run([
    'log',
    `--since=${Math.floor(lo / 1000)}`,
    `--until=${Math.floor(hi / 1000)}`,
    '--format=%H%x09%ct%x09%s',
    '--',
    ...WINDOW_PATHS,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ct, ...rest] = line.split('\t');
      return { sha: sha ?? '', ts: Number(ct) * 1000, subject: rest.join('\t') };
    });
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * CONCENTRATION — the measurement that replaced the latency one (nick's call, 2026-08-14).
 *
 * WHY THIS AND NOT THE 10-MINUTE RATE. Every latency reading this Eval produced was unreadable,
 * and the reasons are structural rather than fixable: routing changed 11 times in 7 days, and
 * stanley's #844 showed a defect can sit in BOTH arms for three weeks leaving no ledger row at all.
 * A freeze excludes only the contamination you can see.
 *
 * Concentration has the properties the latency number lacks:
 *  - it REPRODUCED across a filthy window — 50% at n=18, 56% at n=57;
 *  - it is a MECHANISM you can read, not an effect teased from noise: the ladder sorts
 *    `cross_family` first (`packages/server/src/store/review.ts`), and on a claude team with one
 *    grok seat "highest grade available" resolves to the same name every time;
 *  - it is untouched by re-lease churn, refused wake reports, or stakes arming, because none of
 *    those change who got NAMED as reviewer on a ready row.
 *
 * The boundary is DETECTED FROM THE DATA (the first ready row naming a second distinct
 * `cross_family` reviewer), never asserted here — an author-chosen changepoint is how a prediction
 * gets fitted after the fact.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

export interface ConcentrationPeriod {
  label: string;
  n: number;
  topReviewer: string;
  topShare: number;
  crossFamilyShare: number;
  crossFamilySeats: string[];
}

/**
 * Model family from an attested model id. `cross_family` on a ready row is a property of the PAIR
 * (worker vs reviewer), NOT of the seat — the first draft of this detector keyed on the pair grade
 * and duly reported izzo, miley and stanley as "cross-family acceptors", which is true of those
 * pairings and useless for the question. The intervention is a second seat from a DIFFERENT MODEL
 * FAMILY becoming an acceptor, so family is what this keys on.
 */
export function familyOf(model: string | undefined): string {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'claude';
  if (m.startsWith('grok')) return 'grok';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('codex')) return 'openai';
  if (m.startsWith('gemini')) return 'google';
  if (m.startsWith('kimi')) return 'moonshot';
  return m.split('-')[0] ?? 'unknown';
}

/** The team's majority family — the one a "cross-family" acceptor is cross to. */
export function majorityFamily(seatFamily: Map<string, string>): string {
  const counts = new Map<string, number>();
  for (const f of seatFamily.values()) if (f !== 'unknown') counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'claude';
}

/**
 * Live-routed submits split at the first ask to the SECOND distinct minority-family seat.
 * That edge is read from the data, never asserted — an author-chosen changepoint is how a
 * prediction gets fitted after the fact.
 */
export function concentration(
  submits: Submit[],
  seatFamily: Map<string, string>,
): {
  boundary: number | null;
  boundarySeat: string | null;
  periods: ConcentrationPeriod[];
} {
  const rows = liveRouted(submits);
  const majority = majorityFamily(seatFamily);
  const seen = new Set<string>();
  let boundary: number | null = null;
  let boundarySeat: string | null = null;
  for (const r of rows) {
    const who = r.d.reviewer!;
    const fam = seatFamily.get(who) ?? 'unknown';
    if (fam === majority || fam === 'unknown') continue;
    if (!seen.has(who)) {
      seen.add(who);
      if (seen.size === 2) {
        boundary = r.ts;
        boundarySeat = who;
        break;
      }
    }
  }
  const describe = (label: string, rs: Submit[]): ConcentrationPeriod => {
    const counts = new Map<string, number>();
    for (const r of rs) counts.set(r.d.reviewer!, (counts.get(r.d.reviewer!) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    // Asks that landed on a seat OUTSIDE the majority family — the population the ladder favours.
    const cf = rs.filter((r) => {
      const f = seatFamily.get(r.d.reviewer!) ?? 'unknown';
      return f !== majority && f !== 'unknown';
    });
    return {
      label,
      n: rs.length,
      topReviewer: top?.[0] ?? '-',
      topShare: rs.length ? (top?.[1] ?? 0) / rs.length : 0,
      crossFamilyShare: rs.length ? cf.length / rs.length : 0,
      crossFamilySeats: [...new Set(cf.map((r) => r.d.reviewer!))].sort(),
    };
  };
  // The BEFORE arm is a BOUNDED lookback, not all history. Measured 2026-08-14: top-reviewer share
  // is 26% all-time but 55% over the trailing week, because the concentration only began when
  // ADR 253 took humans out of the pick and one minority-family seat became the ladder's top
  // answer. An all-time baseline would dilute exactly the effect this predicts a change in.
  // SEVEN days, and the choice is load-bearing so it is stated: top-reviewer share is 26%
  // all-time, 28% over 14 days, and 55% over 7 — because the concentration regime only began
  // 2026-08-12, when ADR 253 took humans out of the live pick. A 14-day arm straddles that regime
  // change and would compare the intervention against a mixture of two different systems. Both
  // spans are printed so this choice can be audited rather than taken on trust.
  const LOOKBACK_MS = 7 * 86_400_000;
  if (boundary === null) {
    const now = rows.length ? rows[rows.length - 1]!.ts : Date.now();
    return {
      boundary,
      boundarySeat,
      periods: [
        describe('all history (context only)', rows),
        describe(
          'trailing 14d (context only — straddles the 08-12 regime change)',
          rows.filter((r) => r.ts >= now - 14 * 86_400_000),
        ),
        describe(
          'trailing 7d — THE BEFORE ARM',
          rows.filter((r) => r.ts >= now - LOOKBACK_MS),
        ),
      ],
    };
  }
  return {
    boundary,
    boundarySeat,
    periods: [
      describe(
        'BEFORE (7d up to the boundary)',
        rows.filter((r) => r.ts < boundary! && r.ts >= boundary! - LOOKBACK_MS),
      ),
      describe(
        'AFTER',
        rows.filter((r) => r.ts >= boundary!),
      ),
    ],
  };
}

/**
 * THE PRE-REGISTERED PREDICTION, written 2026-08-14 while exactly one cross-family seat exists —
 * before the codex/gpt-5.6 seat has accepted anything, so it cannot be fitted afterwards.
 *
 * If the grade ladder is the mechanism, a second cross-family acceptor splits the asks that
 * currently land on one name, and top-reviewer share should fall to roughly HALF the cross-family
 * share. Observed now: cross_family ≈ 68%, top-reviewer ≈ 55%.
 *
 * PASS: top-reviewer share ≤ 40% over ≥ 20 live-routed submits after the boundary.
 * FAIL: ≥ 50% sustained over that n — the ladder is NOT what concentrates the asks, my mechanism
 *       claim in ADR 260 is wrong, and the next suspect is the quiescence filter or grading, not
 *       the sort. A FAIL is the informative outcome and must be recorded as a disproof.
 * INCONCLUSIVE: fewer than 20 submits after the boundary, or the second seat never accepts.
 *
 * ---
 * AMENDED 2026-09-01, before any affected row exists — the thresholds above are UNCHANGED and the
 * population they range over is narrowed by one value.
 *
 * dolly's #1152 gives a human a way to route an acceptance to a named seat, recorded as
 * `route: 'named'`. That row satisfies every clause of `liveRouted` as it stood — not exempt, not
 * human-required, has a reviewer, no candidate-failure flag — so it would have entered the very
 * population this prediction ranges over, and the prediction is about what the LADDER does with
 * the asks. Two ways it would have broken, both measured against the code rather than supposed:
 *
 *   - CONCENTRATION (primary). A person hand-routing repeatedly to one trusted seat drives
 *     top-reviewer share up with no involvement from the sort. That is indistinguishable, in this
 *     number, from the ladder failing to disperse the asks — so the FAIL arm could have fired on
 *     a mechanism claim that was never tested.
 *   - crossFamilyShare (secondary, the context line printed beside it). A named route grades
 *     `same_model` when the pairing cannot be proved better, honestly, so each one would have
 *     lowered a figure that claims to describe the picker's achieved diversity.
 *
 * `liveRouted` therefore excludes `named`, and this note is the pre-registration of that exclusion.
 * It is written while the count of named rows in the ledger is ZERO (#1152 unmerged as of writing),
 * which is the only condition under which such a narrowing is not a fitted result: after the first
 * named submit lands, no amendment can distinguish "excluded because it is not ladder data" from
 * "excluded because it moved the number the wrong way", and the window would be contaminated
 * permanently. Falsifier for that claim of zero: `select count(*) from audit where action =
 * 'lane.ready_for_review' and detail like '%"route":"named"%'` — a non-zero count at this commit
 * means this amendment was written too late and the window must be restarted, not patched.
 *
 * What this amendment does NOT do: it does not remove hand-routed acceptances from the ledger, and
 * it takes no position on whether naming an acceptor is good practice. They are recorded, they are
 * real reviews, and ADR 056 diversity claims read the CLOSE row, not this one. They are simply not
 * evidence about a picker that did not pick them.
 */
export const CONCENTRATION_PREDICTION = {
  passAtOrBelow: 0.4,
  failAtOrAbove: 0.5,
  minN: 20,
} as const;

export function judgeConcentration(after: ConcentrationPeriod): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
  if (after.n < CONCENTRATION_PREDICTION.minN) return 'INCONCLUSIVE';
  if (after.topShare <= CONCENTRATION_PREDICTION.passAtOrBelow) return 'PASS';
  if (after.topShare >= CONCENTRATION_PREDICTION.failAtOrAbove) return 'FAIL';
  return 'INCONCLUSIVE';
}

function concentrationMain(): void {
  const { submits, seatFamily } = load();
  const { boundary, boundarySeat, periods } = concentration(submits, seatFamily);
  console.log(
    `  families: ${[...new Set(seatFamily.values())].sort().join(', ')} — majority ${majorityFamily(seatFamily)}`,
  );
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  console.log('\n=== CONCENTRATION (ADR 260 successor measure) ===');
  console.log(
    boundary === null
      ? '  boundary: NOT YET — only one cross-family acceptor has ever been asked.\n' +
          '  This is the pre-intervention baseline; re-run once the second seat accepts.'
      : `  boundary: ${new Date(boundary).toISOString().slice(0, 16)} — first ask to ${boundarySeat}`,
  );
  for (const p of periods) {
    console.log(
      `  ${p.label}: n=${p.n}  top=${p.topReviewer} ${pct(p.topShare)}  ` +
        `minority-family share ${pct(p.crossFamilyShare)}  seats=[${p.crossFamilySeats.join(', ')}]`,
    );
  }
  const after = periods[periods.length - 1]!;
  if (boundary !== null) {
    console.log(
      `\n  PRE-REGISTERED VERDICT: ${judgeConcentration(after)} ` +
        `(pass ≤${pct(CONCENTRATION_PREDICTION.passAtOrBelow)}, fail ≥${pct(CONCENTRATION_PREDICTION.failAtOrAbove)}, min n=${CONCENTRATION_PREDICTION.minN})`,
    );
  }
}

function main() {
  const { db, submits } = load();
  const now = Date.now();
  const win = (lo: number, hi: number) => submits.filter((r) => r.ts >= lo && r.ts < hi);
  const results = [
    evaluate('BASELINE pre-arming', win(BASELINE_START, ARM)),
    evaluate('POST-ARM, increment 1 OFF', win(ARM, ON)),
    evaluate('POST-ARM, increment 1 ON', win(ON, now)),
  ];
  const wakes = { off: wakeVolume(db, ARM, ON), on: wakeVolume(db, ON, now) };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ results, wakes }, null, 2));
    return;
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  for (const r of results) {
    console.log(`\n=== ${r.name} — ${r.submits} submits ===`);
    console.log(
      `  mix: live-routed ${r.liveRouted} | wake ${r.wakeQueued} | no_candidate ${r.noCandidate} | exempt ${r.exempt}`,
    );
    console.log(
      `  [1] good <=10m ${r.good}/${r.liveRouted} = ${pct(r.goodRate)}   (any confirm ${r.confirms}/${r.liveRouted})`,
    );
    console.log(`      in denominator as misses: jumped ${r.jumped}, still open ${r.stillOpen}`);
    console.log(
      `  [2] median age-at-close ${Math.round(r.medianAgeMin)}m, >12h ${pct(r.over12hRate)}`,
    );
    console.log(`  [4] non-exempt submits/day ${r.perDay.toFixed(1)}`);
    console.log(
      `  concentration: top reviewer ${r.topReviewer?.[0] ?? '-'} ${r.topReviewer?.[1] ?? 0}/${r.liveRouted}` +
        `, cross_family share ${pct(r.crossFamilyShare)}`,
    );
  }
  console.log('\n=== [5] wake volume, before vs after increment 1 ===');
  for (const [label, w] of Object.entries(wakes)) {
    console.log(
      `  ${label.toUpperCase().padEnd(3)} ${w.hours.toFixed(1)}h  ` +
        `DECISIONS=${w.wakeDecisions} (${(w.wakeDecisions / w.hours).toFixed(2)}/h)  ` +
        `leased=${w.leased} (${(w.leased / w.hours).toFixed(2)}/h, churn-inflated)  ` +
        `woke=${w.woke} deferred=${w.deferred} failed=${w.failed} priced=${w.priced}`,
    );
  }
  console.log('\n=== [3] duplicate verdicts: N/A — increment 2 not built ===');
}

/**
 * The scheduled re-run (wanderer's ask, 2026-08-21). Guard FIRST, numbers second — and when the
 * guard fails, the numbers are not printed as a comparison at all. A run that reports "6%" beside
 * a routing change nobody noticed is worse than a run that reports nothing, because someone will
 * cite it.
 */
export function rerun(
  now: number,
  windowDays: number,
  db: ReturnType<typeof load>['db'],
  submits: Submit[],
  run: (args: string[]) => string,
): { verdict: string; body: string } {
  const lo = now - windowDays * 86_400_000;
  const policyChanges = (
    db
      .prepare('select ts from audit where action = ? and ts >= ? and ts < ?')
      .all('policy.change', lo, now) as { ts: number }[]
  ).map((r) => r.ts);
  const guard = windowGuard(policyChanges, routingCommitsSince(lo, now, run), lo, now);
  const r = evaluate(
    `re-run, last ${windowDays}d`,
    submits.filter((s) => s.ts >= lo && s.ts < now),
  );
  const share = r.liveRouted ? (r.topReviewer?.[1] ?? 0) / r.liveRouted : 0;
  const head =
    `ADR 260 re-run, ${windowDays}d to ${new Date(now).toISOString().slice(0, 10)}: ` +
    `n=${r.liveRouted} live-routed. PRIMARY top-reviewer share ` +
    `${r.topReviewer?.[0] ?? '-'} ${Math.round(share * 100)}% ` +
    `(${r.topReviewer?.[1] ?? 0}/${r.liveRouted}), cross_family ${Math.round(r.crossFamilyShare * 100)}%. ` +
    `SECONDARY good-<=10m ${Math.round(r.goodRate * 100)}% (${r.good}/${r.liveRouted}).`;

  if (!guard.clean) {
    return {
      verdict: 'UNREADABLE',
      body:
        `${head}\n\nWINDOW IS NOT CLEAN — do not cite these numbers as a before/after, and do not ` +
        `size increment 2 on them. Disqualifying:\n- ${guard.reasons.join('\n- ')}\n\n` +
        `This is the same condition that made the 2026-08-14 run unreadable. Re-run over a window ` +
        `that starts after the last item above, or accept the numbers as descriptive only.`,
    };
  }
  return {
    verdict: 'CLEAN',
    body:
      `${head}\n\nWindow is clean — no policy.change row and no commit to review.ts / ` +
      `orientation.ts / envelope.ts inside it. Per the quiet-set spec §Increments point 3, ` +
      `concentration is the primary read: a sustained high top-reviewer share is the live case for ` +
      `fan-out, and the 10-minute rate is secondary. n is still small; say so when you cite it.`,
  };
}

/**
 * Post as a service seat (ADR 232), composed from the CLI's own exported pieces rather than a
 * private helper copied out of service.ts — same token file, same envelope, no duplicate auth
 * policy. Unprovisioned means silent, exactly as the autorefresh announcement behaves: a research
 * script must never be the reason a machine looks broken.
 */
async function post(body: string): Promise<boolean> {
  // `ulid` is the npm package, as every other caller in this repo has it (cli/src/commands/send.ts).
  // This previously imported '../../packages/protocol/dist/ulid.js', a module that has NEVER
  // existed — found by dolly on 2026-08-14 the first time scripts/ was ever typechecked.
  const [{ HttpClient }, { loadConfig }, { serviceTokenPath }, { makeEnvelope }, { ulid }] =
    await Promise.all([
      import('../../packages/cli/dist/client.js'),
      import('../../packages/cli/dist/config.js'),
      import('../../packages/cli/dist/commands/service.js'),
      import('../../packages/protocol/dist/envelope.js'),
      import('ulid'),
    ]);
  const { readFileSync } = await import('node:fs');
  let token: string;
  try {
    token = readFileSync(
      process.env['MUSTERD_SERVICE_TOKEN_FILE'] ?? serviceTokenPath(),
      'utf8',
    ).trim();
  } catch {
    return false;
  }
  const config = loadConfig();
  const team = process.env['MUSTERD_SERVICE_TEAM'] ?? config.current;
  if (!token || !team) return false;
  const http = new HttpClient({ server: config.server, key: token, surface: 'cli' });
  await http.send(
    team,
    makeEnvelope({
      id: ulid(),
      team,
      from: 'autorefresh',
      to: { kind: 'team' },
      act: 'status_update',
      body,
    }),
  );
  return true;
}

async function rerunMain() {
  const { db, submits } = load();
  const daysArg = process.argv.indexOf('--days');
  const windowDays = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 7;
  const { execFileSync } = await import('node:child_process');
  const run = (args: string[]) =>
    execFileSync('git', args, {
      cwd: new URL('../..', import.meta.url).pathname,
      encoding: 'utf8',
    });
  const { verdict, body } = rerun(Date.now(), windowDays, db, submits, run);
  const text = `[${verdict}] ${body}`;
  console.log(text);
  if (process.argv.includes('--post')) {
    // A genuine failure must NOT read as the ordinary unprovisioned case. The bug above hid behind
    // exactly that catch: a broken import threw, and the run printed a benign "unprovisioned" while
    // the announcement silently never happened. For a scheduled instrument that is identical to not
    // existing — the same "the failure path writes nothing" shape this Eval spent the day on.
    try {
      const sent = await post(text);
      console.log(sent ? '\nposted to the team as a service seat' : '\nnot posted (unprovisioned)');
    } catch (err) {
      console.error(`\nPOST FAILED (not the same as unprovisioned): ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
  // A dirty window is a finding, not a failure: exit 0 so launchd does not retry it as a crash.
}

if (process.argv[1]?.endsWith('adr-260-acceptance-eval.ts')) {
  if (process.argv.includes('--concentration')) concentrationMain();
  else if (process.argv.includes('--rerun')) void rerunMain();
  else main();
}
