import type { ActDelivery, Goal, Report } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
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

function renderFlow(r: Report, w: (s: string) => void): void {
  const f = r.flow;
  const cycle = f.cycle_time_ms === null ? theme.meta('—') : ago(f.cycle_time_ms);
  const age = f.oldest_wip_age_ms === null ? theme.meta('—') : ago(f.oldest_wip_age_ms);
  w(
    `  throughput ${theme.accent(String(f.throughput_7d))}/wk · cycle ${cycle} · WIP ${theme.accent(String(f.wip))} · oldest ${age}\n`,
  );
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

function render(r: Report, altitude: Altitude): void {
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
    const hasExceptions = r.blocked.length > 0 || r.waiting_on.length > 0 || r.coordination.flag;
    for (const b of r.blocked) w(`  ${theme.warn('blocked')} "${b.title}"\n`);
    if (r.waiting_on.length > 0) renderWaitingOn(r, w);
    if (r.coordination.flag)
      w(`  ${theme.warn('coordination-density')} — mostly broadcast journal, little exchange\n`);
    if (!hasExceptions) w(theme.meta('  none — on track') + '\n');
    return;
  }

  // team (default): the digest. Wake sits directly under steering — the ADR 131 O&E baseline is
  // the steering-latency metric "extended to offline recipients as the same headline number".
  w(`\n${theme.accent('flow')}:\n`);
  renderFlow(r, w);
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
    w(`  ${theme.accent(String(t.calls))} calls · ${t.bounces} bounces${rate}\n\n`);
    for (const row of t.tools) {
      const bounce =
        row.bounces > 0
          ? ` · ${theme.warn(`${row.bounces} bounce${row.bounces === 1 ? '' : 's'} (${pct(row.bounce_rate ?? 0)})`)}`
          : '';
      const errors = row.errors > 0 ? ` · ${row.errors} error${row.errors === 1 ? '' : 's'}` : '';
      const lat =
        row.avg_duration_ms === null
          ? ''
          : ` · avg ${row.avg_duration_ms}ms / max ${row.max_duration_ms}ms`;
      const roles = Object.entries(row.by_role)
        .sort((a, b) => b[1] - a[1])
        .map(([role, n]) => `${role} ${n}`)
        .join(', ');
      w(`  ${row.tool} — ${row.calls} call${row.calls === 1 ? '' : 's'}${bounce}${errors}${lat}\n`);
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

export async function reportCommand(parsed: Parsed): Promise<number> {
  if (parsed.positionals[0] === 'delivery') return deliveryReport(parsed, parsed.positionals[1]);
  if (parsed.positionals[0] === 'coordination') return coordinationReport(parsed);
  if (parsed.positionals[0] === 'residency') return residencyReport(parsed);
  if (parsed.positionals[0] === 'tools') return toolsReport(parsed);
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
  render(report, raw);
  return 0;
}
