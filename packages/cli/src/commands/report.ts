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

  // team (default): the digest.
  w(`\n${theme.accent('flow')}:\n`);
  renderFlow(r, w);
  w(`\n${theme.accent('coordination')}:\n`);
  renderCoordination(r, w);
  w(`\n${theme.accent('waiting on')}:\n`);
  renderWaitingOn(r, w);
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

export async function reportCommand(parsed: Parsed): Promise<number> {
  if (parsed.positionals[0] === 'delivery') return deliveryReport(parsed, parsed.positionals[1]);
  const { team, http } = resolve(parsed.flags);
  const report = await http.report(team);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return 0;
  }
  const raw = flagStr(parsed.flags, 'altitude') ?? 'team';
  if (raw !== 'ic' && raw !== 'team' && raw !== 'exec')
    throw new CliError(
      'usage: musterd report [delivery [<id>]] [--altitude ic|team|exec] [--json]',
      2,
    );
  render(report, raw);
  return 0;
}
