import type { ActDelivery, FlowMetrics, Goal, GoalFlow, Report } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { latestFinding, readSweepSeries, type SweepFinding } from '../session/sweep-series.js';
import { resolve } from './helpers.js';

/**
 * `musterd report [--altitude ic|team|exec]` — the insight report (ADR 050), rendered from the one
 * server-side projection (ADR 084). Three altitudes over the *same* data: **ic** = the board (every
 * Goal + its status, blocked lanes), **team** = the digest (flow metrics + waiting-on), **exec** =
 * milestones + exceptions. The report writes itself from the log — no hand-compiled status.
 */

type Altitude = 'ic' | 'team' | 'exec';

/** ms → a compact human age: 2d, 3h, 12m, 45s. */
function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

function goalCounts(goals: Goal[]): { planned: number; inFlight: number; shipped: number } {
  return {
    planned: goals.filter((g) => g.status === 'planned').length,
    inFlight: goals.filter((g) => g.status === 'in-flight').length,
    shipped: goals.filter((g) => g.status === 'shipped').length,
  };
}

function renderGoalLine(g: Goal): string {
  const status =
    g.status === 'shipped'
      ? theme.ok(g.status)
      : g.status === 'in-flight'
        ? theme.warn(g.status)
        : theme.meta(g.status);
  return `  ${status}  "${g.title}"${g.wave !== null ? theme.meta(` wave:${g.wave}`) : ''}`;
}

function renderWaitingOn(r: Report, w: (s: string) => void): void {
  if (r.waiting_on.length === 0) {
    w(theme.meta('  nobody is waiting — no unresolved directed asks') + '\n');
    return;
  }
  for (const e of r.waiting_on)
    w(
      `  waiting on ${theme.memberName(e.member, 'human')} — ${e.threads} thread${e.threads === 1 ? '' : 's'}, oldest ${theme.warn(ago(e.oldest_age_ms))}\n`,
    );
}

export function renderFlow(f: FlowMetrics, w: (s: string) => void): void {
  const cycle = f.cycle_time_ms === null ? theme.meta('—') : ago(f.cycle_time_ms);
  const age = f.oldest_wip_age_ms === null ? theme.meta('—') : ago(f.oldest_wip_age_ms);
  // Absent (not zero) against a pre-295 daemon — say nothing rather than claim an empty queue.
  const queued = f.backlog === undefined ? '' : ` · queued ${theme.accent(String(f.backlog))}`;
  w(
    `  throughput ${theme.accent(String(f.throughput_7d))}/wk · cycle ${cycle} · WIP ${theme.accent(String(f.wip))} · oldest ${age}${queued}\n`,
  );
}

/** `(no goal)` — the goal-less pool reads as a group, never as a bare `null` (ADR 295). */
const goalLabel = (id: string | null) => id ?? '(no goal)';

/**
 * Flow per Goal (ADR 295), in the engine's own order — oldest-WIP first, so the dragging goal reads
 * first. Queue-shaped fields lead and throughput trails: goals are not comparable units, and the
 * line is built to answer "which goal is stuck", not to rank them.
 */
export function renderGoalFlow(byGoal: GoalFlow[], w: (s: string) => void): void {
  if (byGoal.length === 0) return;
  w(`\n${theme.accent('per goal')}:\n`);
  for (const g of byGoal) {
    const f = g.flow;
    const parts = [`wip ${theme.accent(String(f.wip))}`];
    if (f.oldest_wip_age_ms !== null) parts.push(`oldest ${ago(f.oldest_wip_age_ms)}`);
    if (f.backlog) parts.push(`queued ${f.backlog}`);
    if (f.cycle_time_ms !== null) parts.push(`cycle ${ago(f.cycle_time_ms)}`);
    if (f.throughput_7d) parts.push(`${f.throughput_7d}/wk`);
    w(`  ${goalLabel(g.goal_id)} — ${parts.join(' · ')}\n`);
  }
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** The coordination-density line — exchange vs broadcast-journal, with the warn when it's all journal. */
function renderCoordination(r: Report, w: (s: string) => void): void {
  const c = r.coordination;
  w(
    `  ${pct(c.exchange_ratio)} exchange · ${pct(c.journal_ratio)} broadcast journal ${theme.meta(`(${c.acts} acts / ${c.window_days}d)`)}\n`,
  );
  if (c.flag)
    w(
      `  ${theme.warn('⚠ coordination that only looks collaborative')} — mostly broadcast status_updates, little directed or threaded exchange\n`,
    );
}

/**
 * The ADR 166 liveness finding (eval item 3) — enumeration demoting a seat the slot calls live, the
 * one error direction that would make the post-flip judgement worse than the slot it replaced.
 * Rendered ONLY when the newest sweep found one: target is zero, so a line printed at zero would be
 * wallpaper within a week and the exception would stop reading as an exception. `repeated` means the
 * preceding run demoted the same workspace — a confirmed case, not a first sighting.
 */
function renderLiveness(f: SweepFinding, w: (s: string) => void): void {
  const confirmed = f.repeated.length > 0;
  w(
    `  ${theme.warn(confirmed ? 'liveness-demoted (confirmed)' : 'liveness-demoted')} — ` +
      `${f.demoted} workspace${f.demoted === 1 ? '' : 's'} judged not-live while the slot says live ` +
      `${theme.meta(`(ADR 166 eval 3, target zero · ${ago(Date.now() - f.at)} ago)`)}\n`,
  );
  for (const ws of f.workspaces)
    w(`    ${f.repeated.includes(ws) ? theme.warn('repeat') : theme.meta('first')}  ${ws}\n`);
}

function render(r: Report, altitude: Altitude, liveness?: SweepFinding): void {
  const w = process.stdout.write.bind(process.stdout);
  const c = goalCounts(r.goals);
  w(
    `${theme.accent('report')} — ${r.team} ${theme.meta(`· ${altitude} · ${c.shipped} shipped / ${c.inFlight} in-flight / ${c.planned} planned`)}\n`,
  );

  if (altitude === 'ic') {
    // The board: every Goal and its derived status.
    w(`\n${theme.accent('goals')}:\n`);
    if (r.goals.length === 0) w(theme.meta('  no declared goals') + '\n');
    for (const g of r.goals) w(renderGoalLine(g) + '\n');
    if (r.blocked.length > 0) {
      w(`\n${theme.warn('blocked')}:\n`);
      for (const b of r.blocked)
        w(`  ${theme.meta(b.id)} "${b.title}" — ${b.owner_seat ?? theme.meta('unowned')}\n`);
    }
    return;
  }

  if (altitude === 'exec') {
    // Milestones + exceptions.
    w(`\n${theme.accent('milestones')}:\n`);
    for (const g of r.goals.filter((g) => g.status !== 'planned')) w(renderGoalLine(g) + '\n');
    if (r.goals.every((g) => g.status === 'planned'))
      w(theme.meta('  nothing in flight yet') + '\n');
    w(`\n${theme.accent('exceptions')}:\n`);
    const hasExceptions =
      r.blocked.length > 0 || r.waiting_on.length > 0 || r.coordination.flag || liveness != null;
    for (const b of r.blocked) w(`  ${theme.warn('blocked')} "${b.title}"\n`);
    if (r.waiting_on.length > 0) renderWaitingOn(r, w);
    if (r.coordination.flag)
      w(`  ${theme.warn('coordination-density')} — mostly broadcast journal, little exchange\n`);
    if (liveness) renderLiveness(liveness, w);
    if (!hasExceptions) w(theme.meta('  none — on track') + '\n');
    return;
  }

  // team (default): the digest. Wake sits directly under steering — the ADR 131 O&E baseline is
  // the steering-latency metric "extended to offline recipients as the same headline number".
  w(`\n${theme.accent('flow')}:\n`);
  renderFlow(r.flow, w);
  renderGoalFlow(r.goal_flow ?? [], w);
  w(`\n${theme.accent('coordination')}:\n`);
  renderCoordination(r, w);
  w(`\n${theme.accent('steering')}:\n`);
  renderSteering(r, w);
  if (r.wake) {
    w(`\n${theme.accent('wake')}:\n`);
    renderWake(r.wake, w);
  }
  w(`\n${theme.accent('waiting on')}:\n`);
  renderWaitingOn(r, w);
  if (liveness) {
    w(`\n${theme.accent('liveness')}:\n`);
    renderLiveness(liveness, w);
  }
}

/** Wake metrics (ADR 131 inc 5) — the always-on claim's instrument panel. */
function renderWake(k: NonNullable<Report['wake']>, w: (s: string) => void): void {
  if (k.wakes === 0 && k.failed === 0 && k.deferred === 0) {
    w(theme.meta(`  no wakes (${k.window_days}d)`) + '\n');
    return;
  }
  const rate = k.answer_rate === null ? '' : ` (${Math.round(k.answer_rate * 100)}%)`;
  const lat =
    k.latency_median_ms === null
      ? theme.meta('—')
      : `median ${ago(k.latency_median_ms)} · p95 ${ago(k.latency_p95_ms!)}`;
  const resumed = k.resumed > 0 ? ` (${k.resumed} resumed)` : '';
  w(
    `  ${k.wakes} wake${k.wakes === 1 ? '' : 's'}${resumed} · ${k.answered} answered${rate} · latency ${lat} ${theme.meta(`(${k.window_days}d)`)}\n`,
  );
  if (k.cost_usd_total !== null) {
    w(
      `  cost $${k.cost_usd_total.toFixed(2)} total · $${k.cost_usd_per_wake!.toFixed(2)}/wake ${theme.meta(`(${k.cost_reported} of ${k.wakes} reported)`)}\n`,
    );
  }
  // ADR 252: spend the cost line structurally cannot show. Printed only when there is some — a zero
  // here would read as "nothing went unpriced", which the token cannot yet promise.
  if ((k.unpriced_sessions ?? 0) > 0) {
    w(
      `  ${theme.meta('unpriced')} ${k.unpriced_sessions} wake${k.unpriced_sessions === 1 ? '' : 's'} spawned a session and died unreported — paid, cost unknown\n`,
    );
  }
  // ADR 273: refused reports. Loud, and phrased as a warning rather than a statistic, because a
  // non-zero here invalidates every number above it — a refused receipt is spend this report
  // cannot see, and the ADR 269 case sat unnoticed for ~3 weeks precisely because nothing said it
  // out loud. Zero prints nothing: silence here is the honest steady state, unlike `unpriced`.
  if ((k.reports_rejected ?? 0) > 0) {
    w(
      `  ${theme.warn('refused')} ${k.reports_rejected} wake report${k.reports_rejected === 1 ? '' : 's'} rejected by this daemon — a host disagrees about the wire shape, and the numbers above are under-counted until it is zero\n`,
    );
  }
  // ADR 209/210 Eval split. Printed only when something was actually measured — a cohort of zero
  // must not render as a row of zeros, which reads like a measured result rather than no data. When
  // wakes exist but none reported a delivery, say so plainly: that is the ADR 209 baseline's real
  // state, and the sentence a reader needs in order not to trust an empty table.
  if (k.delivery_measured > 0) {
    const d = k.delivery;
    w(
      `  delivery: ${d.fresh} fresh · ${d.resumed} resumed · ${d.fresh_fallback} fresh-fallback ` +
        theme.meta(`(${k.delivery_measured} of ${k.wakes} measured)`) +
        '\n',
    );
  } else if (k.wakes > 0) {
    w(theme.meta(`  delivery: unmeasured — no wake in the window reported one (ADR 209)`) + '\n');
  }
  if (k.exact_match_measured > 0) {
    const e = k.exact_match;
    w(
      `  exact match: ${e.bound} bound · ${e.missing} missing · ${e.mismatched} mismatched · ${e.stale} stale ` +
        theme.meta(`(${k.exact_match_measured} eligible)`) +
        '\n',
    );
  }
  const quiet: string[] = [];
  if (k.failed > 0) quiet.push(`${k.failed} failed attempt${k.failed === 1 ? '' : 's'}`);
  if (k.deferred > 0) quiet.push(`${k.deferred} deferred (live local session)`);
  if (quiet.length > 0) w(theme.meta(`  ${quiet.join(' · ')}`) + '\n');
  if (k.exhausted > 0)
    w(`  ${theme.warn(`${k.exhausted} act(s) exhausted their wake attempts`)}\n`);
  for (const s of k.by_seat.filter((s) => s.over_budget))
    w(
      `  ${theme.warn('over budget')} ${theme.memberName(s.seat, 'agent')} — a wake exceeded its $${s.budget_usd} report bound\n`,
    );
}

/** Interrupt-line metrics (ADR 125) — latency + supersession + stale-work-caught. */
function renderSteering(r: Report, w: (s: string) => void): void {
  const s = r.steering;
  const lat =
    s.latency_median_ms === null
      ? theme.meta('—')
      : `median ${ago(s.latency_median_ms)} · p95 ${ago(s.latency_p95_ms!)}`;
  w(
    `  ${s.acked}/${s.steers} steers acked · latency ${lat} ${theme.meta(`(${s.window_days}d)`)}\n`,
  );
  const superLine =
    s.superseded_acts === 0
      ? theme.ok('0 superseded-steer replies')
      : theme.warn(`${s.superseded_acts} act(s) replied to a superseded steer`);
  w(`  ${superLine}\n`);
  w(
    `  stale-work ${s.stale_caught}/${s.stale_wakes} wakes caught${s.stale_wakes > 0 && s.stale_caught === 0 ? theme.warn(' — wakes fired, no course-change yet') : ''}\n`,
  );
}

/** One recipient's rung, compactly: `stanley seen 2h` / `nick answered (accept)` / `izzo unseen 3d`. */
function renderRecipient(r: ActDelivery['recipients'][number], sentTs: number): string {
  if (r.answered)
    return `${theme.memberName(r.seat, 'agent')} ${theme.ok('answered')} ${theme.meta(`(${r.answered.act}, ${ago(r.answered.ts - sentTs)} after send)`)}`;
  if (r.state === 'seen')
    return `${theme.memberName(r.seat, 'agent')} seen${r.seen_by ? theme.meta(` ~${ago(Date.now() - r.seen_by)} ago`) : ''}`;
  const raises =
    r.interrupt_raises > 0 ? theme.meta(` · ${r.interrupt_raises} interrupt raise(s)`) : '';
  return `${theme.memberName(r.seat, 'agent')} ${theme.warn('unseen')}${raises}`;
}

function renderActDelivery(d: ActDelivery, w: (s: string) => void): void {
  const urgent = d.urgent ? ` ${theme.warn('urgent')}` : '';
  w(
    `  ${theme.meta(d.id)} ${d.act}${urgent} from ${theme.memberName(d.from, 'agent')} → ${d.to_kind === 'member' ? (d.recipients[0]?.seat ?? '?') : `@${d.to_kind}`} · ${ago(d.age_ms)} ago\n`,
  );
  for (const r of d.recipients) w(`    ${renderRecipient(r, d.ts)}\n`);
}

/**
 * `musterd report delivery [<id>]` (ADR 090): no id — the open directed ledger (what's waiting on
 * whom, seen or ignored); with id — one act's per-recipient journey. Derived server-side from the
 * log + cursors + the interrupt audit; a diagnostic instrument, never a score.
 */
async function deliveryReport(parsed: Parsed, id: string | undefined): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const w = process.stdout.write.bind(process.stdout);
  if (id) {
    const ledger = await http.delivery(team, id);
    if (parsed.flags['json']) return (w(JSON.stringify(ledger) + '\n'), 0);
    w(`${theme.accent('delivery')} — ${team}\n`);
    renderActDelivery(ledger, w);
    return 0;
  }
  const report = await http.report(team);
  if (parsed.flags['json']) return (w(JSON.stringify(report.open_directed) + '\n'), 0);
  w(`${theme.accent('open directed acts')} — ${team}\n`);
  if (report.open_directed.length === 0)
    return (w(theme.meta('  none — every directed ask is answered') + '\n'), 0);
  for (const d of report.open_directed) renderActDelivery(d, w);
  return 0;
}

/**
 * `musterd report coordination` (ADR 091): the coordination-health page — the density line (ADR
 * 050) plus the MAST detectors (time-to-unblock, ignored request_help, stalled threads, circular
 * handoffs). Finding 002's grep session as one command; diagnostics, never scores.
 */
async function coordinationReport(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const report = await http.report(team);
  const w = process.stdout.write.bind(process.stdout);
  const m = report.mast;
  if (parsed.flags['json'])
    return (
      w(
        JSON.stringify({
          coordination: report.coordination,
          mast: m,
          steering: report.steering,
        }) + '\n',
      ),
      0
    );

  w(`${theme.accent('coordination')} — ${team} ${theme.meta(`· last ${m.window_days}d`)}\n\n`);
  renderCoordination(report, w);
  w(`\n${theme.accent('steering')}:\n`);
  renderSteering(report, w);

  const t = m.time_to_unblock;
  w(`\n${theme.accent('time to unblock')}:\n`);
  w(
    t.closed === 0
      ? theme.meta('  no loops closed in the window') + '\n'
      : `  ${t.closed} loop${t.closed === 1 ? '' : 's'} closed · median ${ago(t.median_ms!)} · p95 ${ago(t.p95_ms!)}\n`,
  );

  w(`\n${theme.accent('ignored help')} ${theme.meta('(request_help unanswered > 1h)')}:\n`);
  if (m.ignored_help.length === 0) w(theme.meta('  none') + '\n');
  for (const d of m.ignored_help) renderActDelivery(d, w);

  w(`\n${theme.accent('stalled threads')} ${theme.meta('(quiet > 24h, no resolve)')}:\n`);
  if (m.stalled_threads.length === 0) w(theme.meta('  none') + '\n');
  for (const s of m.stalled_threads)
    w(
      `  ${theme.meta(s.thread)} — ${s.acts} acts, ${s.participants} participant${s.participants === 1 ? '' : 's'}, last ${s.last_act}, quiet ${theme.warn(ago(s.quiet_ms))}\n`,
    );

  w(`\n${theme.accent('circular handoffs')}:\n`);
  if (m.circular_handoffs.length === 0) w(theme.meta('  none') + '\n');
  for (const c of m.circular_handoffs)
    w(
      `  ${theme.warn('↻')} thread ${theme.meta(c.thread)} — handoff returned to a prior participant after ${c.hops} hop${c.hops === 1 ? '' : 's'}\n`,
    );

  w(`\n${theme.accent('model diversity')} ${theme.meta('(review/approval chains, ADR 101)')}:\n`);
  if (m.diversity.length === 0)
    w(theme.meta('  none — no single-family or unverifiable chains') + '\n');
  for (const d of m.diversity)
    w(
      d.verdict === 'flagged'
        ? `  ${theme.warn('⚑')} thread ${theme.meta(d.thread)} — ${d.kind} chain single-model-family end-to-end (all ${d.families[0]}-*) · treat agreement as weak evidence\n`
        : `  ${theme.meta('?')} thread ${theme.meta(d.thread)} — ${d.kind} chain has an unattested link · diversity unverifiable\n`,
    );
  return 0;
}

/**
 * `musterd report residency` (ADR 131 inc 5): the wake instrument panel — the O&E headline pair
 * (wake latency, answer rate) plus operational economics (cost-per-wake, per-seat budgets) and the
 * quiet counters (failed/deferred/exhausted). Diagnostics, never a score.
 */
async function residencyReport(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const report = await http.report(team);
  const w = process.stdout.write.bind(process.stdout);
  const k = report.wake;
  if (parsed.flags['json']) return (w(JSON.stringify(k ?? null) + '\n'), 0);
  if (!k) {
    w(
      theme.meta('this daemon predates wake metrics (ADR 131 inc 5) — rebuild + restart it') + '\n',
    );
    return 0;
  }
  w(`${theme.accent('wake report')} — ${team} ${theme.meta(`· last ${k.window_days}d`)}\n\n`);
  renderWake(k, w);
  if (k.by_seat.length > 0) {
    w(`\n${theme.accent('by seat')}:\n`);
    for (const s of k.by_seat) {
      const cost =
        s.cost_usd_total === null ? theme.meta('cost —') : `$${s.cost_usd_total.toFixed(2)}`;
      const budget =
        s.budget_usd === null
          ? theme.meta('no budget bound')
          : `budget $${s.budget_usd}${s.over_budget ? ` ${theme.warn('EXCEEDED')}` : ` ${theme.ok('ok')}`}`;
      w(
        `  ${theme.memberName(s.seat, 'agent')} — ${s.wakes} wake${s.wakes === 1 ? '' : 's'} · ${cost} · ${budget}\n`,
      );
    }
  }
  return 0;
}

/**
 * `musterd report tools` (ADR 144 inc 1): the MCP tool-surface instrument panel — per-tool calls,
 * bounce rate (invalid-input per call), latency, and the caller-role split, plus each seat's
 * latest attested rendered-surface weight. The before/after for every surface-redesign increment.
 */
async function toolsReport(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const report = await http.report(team);
  const w = process.stdout.write.bind(process.stdout);
  const t = report.tool_calls;
  if (parsed.flags['json']) return (w(JSON.stringify(t ?? null) + '\n'), 0);
  if (!t) {
    w(
      theme.meta(
        'this daemon predates tool-call telemetry (ADR 144 inc 1) — rebuild + restart it',
      ) + '\n',
    );
    return 0;
  }
  w(`${theme.accent('tool calls')} — ${team} ${theme.meta(`· last ${t.window_days}d`)}\n\n`);
  if (t.tools.length === 0) {
    w(theme.meta('  no tool calls recorded yet — they land as adapters flush (~30s)') + '\n');
  } else {
    const rate = t.calls > 0 ? ` · bounce ${pct(t.bounces / t.calls)}` : '';
    // Coerced calls are reported beside bounces, never folded into them: they are the mistakes the
    // inc-4 layer absorbed, and keeping them visible is what stops silent forgiveness from reading
    // as a surface that never had the defect (ADR 144 inc 4).
    const absorbed = t.coerced > 0 ? ` · ${t.coerced} coerced` : '';
    w(`  ${theme.accent(String(t.calls))} calls · ${t.bounces} bounces${rate}${absorbed}\n\n`);
    for (const row of t.tools) {
      const bounce =
        row.bounces > 0
          ? ` · ${theme.warn(`${row.bounces} bounce${row.bounces === 1 ? '' : 's'} (${pct(row.bounce_rate ?? 0)})`)}`
          : '';
      const coerced = row.coerced > 0 ? ` · ${theme.meta(`${row.coerced} coerced`)}` : '';
      const errors = row.errors > 0 ? ` · ${row.errors} error${row.errors === 1 ? '' : 's'}` : '';
      const lat =
        row.avg_duration_ms === null
          ? ''
          : ` · avg ${row.avg_duration_ms}ms / max ${row.max_duration_ms}ms`;
      const roles = Object.entries(row.by_role)
        .sort((a, b) => b[1] - a[1])
        .map(([role, n]) => `${role} ${n}`)
        .join(', ');
      w(
        `  ${row.tool} — ${row.calls} call${row.calls === 1 ? '' : 's'}${bounce}${coerced}${errors}${lat}\n`,
      );
      if (roles) w(theme.meta(`    by role: ${roles}`) + '\n');
    }
  }
  w(`\n${theme.accent('rendered surface')} ${theme.meta('(latest attestation per seat)')}:\n`);
  if (t.surface.length === 0) {
    w(theme.meta('  none attested yet — a seat attests on its first flush after connect') + '\n');
  } else {
    for (const s of t.surface)
      w(
        `  ${theme.memberName(s.seat, 'agent')} — ${s.tools} tools · ${(s.bytes / 1024).toFixed(1)}KB ≈ ${s.est_tokens} tokens ${theme.meta(`(${ago(Date.now() - s.ts)} ago)`)}\n`,
      );
  }
  return 0;
}

/**
 * `musterd report review` (ADR 169 O&E / ADR 192 acceptance wording, reachable per ADR 052): the
 * two-stage close panel — how often outcome acceptance was routed, how often there was nobody to
 * route to, and how often an acceptor rejected (sent work back). Metric keys stay `review.*`.
 *
 * This exists because the ADR's own eval was defined over admin-only audit rows, so the seats meant
 * to compute it could not read it. Counts only, and every transition counted here was already
 * broadcast as a `lane_state` act — the aggregate discloses nothing the team could not see live.
 */
async function reviewReport(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const report = await http.report(team);
  const w = process.stdout.write.bind(process.stdout);
  const r = report.review;
  if (parsed.flags['json']) return (w(JSON.stringify(r ?? null) + '\n'), 0);
  if (!r) {
    w(theme.meta('this daemon predates two-stage close (ADR 169) — rebuild + restart it') + '\n');
    return 0;
  }
  const days = Math.round(r.window_ms / 86_400_000);
  w(`${theme.accent('acceptance')} — ${team} ${theme.meta(`· last ${days}d`)}\n\n`);
  if (r.ready === 0) {
    w(
      theme.meta('  no lane has entered acceptance yet — `musterd lane submit <id>` starts one') +
        '\n',
    );
    return 0;
  }
  // The catch rate's denominator is ROUTED asks, never lanes marked ready: a zero over the latter
  // cannot separate "acceptors found nothing" from "nobody was eligible to look" (ADR 169/191).
  const catchRate = r.routed > 0 ? ` · caught ${pct(r.sent_back / r.routed)}` : '';
  w(
    `  ${theme.accent(String(r.ready))} entered acceptance · ${r.routed} routed · ${r.no_candidate} no counterpart${catchRate}\n`,
  );
  // ADR 234 increment 2: the exemption and the hole on one line, because either number alone
  // misleads. The exempt count without the sampled count reads as acceptance quietly eroding; the
  // sampled count is the evidence that the low tier is still being measured, which is the whole
  // condition on which the exemption was allowed to ship early.
  // ADR 348: hand-routed acceptances get their own line and their own rate. They are real asks and
  // their catches are real — hiding them would be the opposite error — but they are not the
  // picker's asks, and the rate above is a statement about the picker. Two numbers, each meaning
  // exactly one thing, rather than one number meaning neither.
  if (r.named > 0) {
    w(`  ${theme.meta(`${r.named} routed by hand (named acceptor, not the picker)`)}\n`);
  }
  if (r.acceptance_exempt > 0 || r.exempt_sampled > 0) {
    w(
      `  ${theme.meta(`${r.acceptance_exempt} exempt (declared low, no ask) · ${r.exempt_sampled} sampled in and routed anyway`)}\n`,
    );
  }
  // Rows written before the routing outcome was recorded (pre-#450) count as `ready` and abstain
  // from the split. Say so: without this line a panel reading "4 entered acceptance · 0 routed" invites
  // exactly the misreading this whole projection exists to prevent — and their closes carry the old
  // `review_timeout` label, which asserts an ask that may never have been sent.
  // ADR 234 increment 2: exempt submits are a KNOWN third outcome and must come out of this
  // subtraction. Left in, every declared-low lane would be reported as predating a 2026-07 fix.
  // ADR 348: `named` joins the subtraction for the identical reason exempt did. It is a KNOWN
  // fourth outcome; left out, every hand-routed lane would be reported as predating a 2026-07 fix.
  const unknown = r.ready - r.routed - r.no_candidate - r.acceptance_exempt - r.named;
  if (unknown > 0) {
    w(
      `  ${theme.meta(`${unknown} predate routing-outcome recording (ADR 169 follow-up) — their split is unknown, and their closes read as timeouts whether or not an ask was sent`)}\n`,
    );
  }
  if (r.routed === 0 && r.no_candidate > 0) {
    // The finding this panel exists to make legible, stated rather than left to arithmetic.
    w(
      `  ${theme.warn('acceptance never ran')} — ${theme.meta('every submitted lane found no eligible acceptor, so a zero catch rate says nothing about accepting (see `musterd report` family_posture)')}\n`,
    );
  }
  const c = r.closed;
  w(`\n  ${theme.accent('closes')} (${c.total}):\n`);
  const verifiedPct =
    c.total > 0 ? ` ${theme.meta(`(${pct(c.counterpart_confirm / c.total)})`)}` : '';
  w(`    ${theme.ok('accepted')} ${c.counterpart_confirm}${verifiedPct}\n`);
  w(`    ${theme.meta('self-closed')} ${c.self_close} · never entered acceptance\n`);
  w(`    ${theme.meta('no counterpart')} ${c.no_candidate} · sanctioned, nobody was asked\n`);
  if (c.acceptance_exempt > 0) {
    w(
      `    ${theme.meta('exempt')} ${c.acceptance_exempt} · declared low stakes, no ask was owed (ADR 234)\n`,
    );
  }
  // ADR 217: the old single line said "asked, unanswered" of every owner-close out of acceptance,
  // including the ones that closed after 8 seconds. Three lines now, because they call for three
  // different remedies — and the cut-short count is warn-coloured: it is the only one of the three
  // the owner could simply have chosen not to do.
  w(
    `    ${theme.meta('acceptance unanswered')} ${c.review_unanswered} · waited the promised window\n`,
  );
  if (c.review_cut_short > 0) {
    w(
      `    ${theme.warn('acceptance cut short')} ${c.review_cut_short} · owner closed before the window it promised\n`,
    );
  }
  if (c.review_timeout > 0) {
    w(
      `    ${theme.meta('acceptance window unknown')} ${c.review_timeout} · asked, but no promised window was recorded (pre-ADR 217)\n`,
    );
  }
  // ADR 172's counter-metric, warn-coloured because it is the one close shape that is nobody's
  // sanctioned degradation: the lane declared a risk, the risk demanded a human, no human came.
  if (c.human_review_missed > 0) {
    w(
      `    ${theme.warn('human acceptance missed')} ${c.human_review_missed} · a declared risk required a human, none accepted\n`,
    );
  }
  // And the abstention beside it (ADR 173 clause 4): without this line the count above reads as a
  // clean census, when for these closes we simply could not see what the lane required.
  if (c.human_required_unknown > 0) {
    w(
      `    ${theme.meta(`${c.human_required_unknown} of those closes could not tell whether a human was required — their ready row predates the field or would not parse, so the count above abstains over them`)}\n`,
    );
  }
  if (c.abandoned > 0) w(`    ${theme.meta('abandoned')} ${c.abandoned}\n`);
  // The two abstentions that used to be counted as self-closes. Printed only when non-zero, but
  // printed distinctly when they are: the arithmetic on this panel has to close, and a reader
  // subtracting the named buckets from `total` should never be left with an unexplained remainder.
  if (c.legacy_unlabelled > 0) {
    w(
      `    ${theme.meta(`${c.legacy_unlabelled} recorded no reason at all — legacy single-stage closes, from before the two-stage close existed`)}\n`,
    );
  }
  // Warn-coloured, unlike the legacy line: this one is actionable, and it means this build is
  // reading a log a newer musterd wrote, so other numbers on this panel may be undercounted too.
  if (c.unknown_reason > 0) {
    w(
      `    ${theme.warn(`${c.unknown_reason} carry a reason this build cannot classify`)} ${theme.meta('— a newer musterd wrote them; update this checkout before trusting the split above')}\n`,
    );
  }
  return 0;
}

export async function reportCommand(parsed: Parsed): Promise<number> {
  if (parsed.positionals[0] === 'delivery') return deliveryReport(parsed, parsed.positionals[1]);
  if (parsed.positionals[0] === 'coordination') return coordinationReport(parsed);
  if (parsed.positionals[0] === 'residency') return residencyReport(parsed);
  if (parsed.positionals[0] === 'tools') return toolsReport(parsed);
  if (parsed.positionals[0] === 'review') return reviewReport(parsed);
  const { team, http } = resolve(parsed.flags);
  const report = await http.report(team);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return 0;
  }
  const raw = flagStr(parsed.flags, 'altitude') ?? 'team';
  if (raw !== 'ic' && raw !== 'team' && raw !== 'exec')
    throw new CliError(
      'usage: musterd report [delivery [<id>] | coordination | residency | tools] [--altitude ic|team|exec] [--json]',
      2,
    );
  // Read off the local sweep series, not the server projection: the finding is a machine-local
  // measurement about this fleet's bindings and transcripts, and no daemon can see it.
  render(report, raw, latestFinding(readSweepSeries()));
  return 0;
}
