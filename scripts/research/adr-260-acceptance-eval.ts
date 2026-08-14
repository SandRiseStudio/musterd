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
    db
      .prepare('select ts, detail from audit where action = ? order by ts')
      .all(action) as { ts: number; detail: string }[];
  const closes = new Map<string, { ts: number; d: ClosedDetail }[]>();
  for (const r of rows('lane.closed')) {
    const d = JSON.parse(r.detail) as ClosedDetail;
    if (!closes.has(d.lane)) closes.set(d.lane, []);
    closes.get(d.lane)!.push({ ts: r.ts, d });
  }
  const submits: Submit[] = rows('lane.ready_for_review').map((r) => {
    const d = JSON.parse(r.detail) as ReadyDetail;
    const close = (closes.get(d.lane) ?? []).find((c) => c.ts >= r.ts);
    return close ? { ts: r.ts, d, close } : { ts: r.ts, d };
  });
  return { db, submits };
}

const liveRouted = (rs: Submit[]) =>
  rs.filter(
    (r) =>
      !r.d.acceptance_exempt &&
      !r.d.human_required &&
      !r.d.no_candidate &&
      !r.d.wake_queued &&
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

  const spanDays = rs.length
    ? Math.max((rs[rs.length - 1]!.ts - rs[0]!.ts) / 86_400_000, 1e-9)
    : 1;

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
  return {
    leased: n('residency.wake_leased'),
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

/**
 * The files that decide who is asked. THE single source of truth for both directions of the
 * measurement: the window guard below disqualifies a window when one of these changes, and
 * `scripts/check-routing-freeze.ts` imports this exact array to decide what the freeze protects.
 *
 * They must never be two lists. A team that freezes one set of files while the instrument measures
 * another gets a clean-looking window over a system that moved — which is precisely the failure
 * the 2026-08-14 run produced by accident, re-created on purpose.
 */
export const ROUTING_PATHS = [
  'packages/server/src/store/review.ts',
  'packages/server/src/store/orientation.ts',
  'packages/protocol/src/envelope.ts',
] as const;

/** Commits touching the files that decide who is asked, within [lo, hi). */
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
    ...ROUTING_PATHS,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ct, ...rest] = line.split('\t');
      return { sha: sha ?? '', ts: Number(ct) * 1000, subject: rest.join('\t') };
    });
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
      `  ${label.toUpperCase().padEnd(3)} ${w.hours.toFixed(1)}h  leased=${w.leased} woke=${w.woke} ` +
        `deferred=${w.deferred} failed=${w.failed} priced=${w.priced}  leases/h=${(w.leased / w.hours).toFixed(2)}`,
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
  const r = evaluate(`re-run, last ${windowDays}d`, submits.filter((s) => s.ts >= lo && s.ts < now));
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
  const [{ HttpClient }, { loadConfig }, { serviceTokenPath }, { makeEnvelope }, { ulid }] =
    await Promise.all([
      import('../../packages/cli/dist/client.js'),
      import('../../packages/cli/dist/config.js'),
      import('../../packages/cli/dist/commands/service.js'),
      import('../../packages/protocol/dist/envelope.js'),
      import('../../packages/protocol/dist/ulid.js'),
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
    execFileSync('git', args, { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8' });
  const { verdict, body } = rerun(Date.now(), windowDays, db, submits, run);
  const text = `[${verdict}] ${body}`;
  console.log(text);
  if (process.argv.includes('--post')) {
    const sent = await post(text).catch(() => false);
    console.log(sent ? '\nposted to the team as a service seat' : '\nnot posted (unprovisioned)');
  }
  // A dirty window is a finding, not a failure: exit 0 so launchd does not retry it as a crash.
}

if (process.argv[1]?.endsWith('adr-260-acceptance-eval.ts')) {
  if (process.argv.includes('--rerun')) void rerunMain();
  else main();
}
