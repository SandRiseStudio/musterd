import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Report } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { textResult } from './format.js';

/**
 * The insight report (ADR 050, server-side per ADR 084) — leadership projections over lanes + the act
 * log, computed once and rendered here. Same data at three altitudes: ic = the board, team = the flow
 * digest, exec = milestones + exceptions. Goodhart-safe: outcomes and queues, never message volume.
 */

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

function fmtReport(r: Report, altitude: 'ic' | 'team' | 'exec'): string {
  const shipped = r.goals.filter((g) => g.status === 'shipped').length;
  const inFlight = r.goals.filter((g) => g.status === 'in-flight').length;
  const planned = r.goals.filter((g) => g.status === 'planned').length;
  const lines: string[] = [
    `report — ${r.team} · ${altitude} · ${shipped} shipped / ${inFlight} in-flight / ${planned} planned`,
  ];

  const waitingLines = () =>
    r.waiting_on.length === 0
      ? ['  nobody is waiting — no unresolved directed asks']
      : r.waiting_on.map(
          (e) =>
            `  waiting on ${e.member} — ${e.threads} thread${e.threads === 1 ? '' : 's'}, oldest ${ago(e.oldest_age_ms)}`,
        );

  if (altitude === 'ic') {
    lines.push('\ngoals:');
    if (r.goals.length === 0) lines.push('  no declared goals');
    for (const g of r.goals) lines.push(`  [${g.status}] "${g.title}"`);
    if (r.blocked.length) {
      lines.push('\nblocked:');
      for (const b of r.blocked)
        lines.push(`  ${b.id} "${b.title}" — ${b.owner_seat ?? 'unowned'}`);
    }
  } else if (altitude === 'exec') {
    lines.push('\nmilestones:');
    const active = r.goals.filter((g) => g.status !== 'planned');
    if (active.length === 0) lines.push('  nothing in flight yet');
    for (const g of active) lines.push(`  [${g.status}] "${g.title}"`);
    lines.push('\nexceptions:');
    if (!r.blocked.length && !r.waiting_on.length && !r.coordination.flag)
      lines.push('  none — on track');
    for (const b of r.blocked) lines.push(`  blocked "${b.title}"`);
    if (r.waiting_on.length) lines.push(...waitingLines());
    if (r.coordination.flag)
      lines.push('  coordination-density — mostly broadcast journal, little exchange');
  } else {
    const f = r.flow;
    const c = r.coordination;
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    lines.push('\nflow:');
    lines.push(
      `  throughput ${f.throughput_7d}/wk · cycle ${f.cycle_time_ms === null ? '—' : ago(f.cycle_time_ms)} · WIP ${f.wip} · oldest ${f.oldest_wip_age_ms === null ? '—' : ago(f.oldest_wip_age_ms)}`,
    );
    lines.push('\ncoordination:');
    lines.push(
      `  ${pct(c.exchange_ratio)} exchange · ${pct(c.journal_ratio)} broadcast journal (${c.acts} acts / ${c.window_days}d)`,
    );
    if (c.flag)
      lines.push(
        '  ⚠ coordination that only looks collaborative — mostly broadcast status_updates, little directed/threaded exchange',
      );
    const s = r.steering;
    const lat =
      s.latency_median_ms === null
        ? '—'
        : `median ${ago(s.latency_median_ms)} · p95 ${ago(s.latency_p95_ms!)}`;
    lines.push('\nsteering:');
    lines.push(`  ${s.acked}/${s.steers} steers acked · latency ${lat} (${s.window_days}d)`);
    lines.push(
      s.superseded_acts === 0
        ? '  0 superseded-steer replies'
        : `  ⚠ ${s.superseded_acts} act(s) replied to a superseded steer`,
    );
    lines.push(`  stale-work ${s.stale_caught}/${s.stale_wakes} wakes caught`);
    // Wake metrics (ADR 131 inc 5), directly under steering — the O&E baseline extends the
    // steering-latency headline to offline recipients. Silent when the daemon predates them.
    const k = r.wake;
    if (k && (k.wakes > 0 || k.failed > 0 || k.deferred > 0 || k.exhausted > 0)) {
      const wlat =
        k.latency_median_ms === null
          ? '—'
          : `median ${ago(k.latency_median_ms)} · p95 ${ago(k.latency_p95_ms!)}`;
      const rate = k.answer_rate === null ? '' : ` (${Math.round(k.answer_rate * 100)}%)`;
      lines.push('\nwake:');
      lines.push(
        `  ${k.wakes} wake(s)${k.resumed > 0 ? ` (${k.resumed} resumed)` : ''} · ` +
          `${k.answered} answered${rate} · latency ${wlat} (${k.window_days}d)`,
      );
      if (k.cost_usd_total !== null)
        lines.push(
          `  cost $${k.cost_usd_total.toFixed(2)} total · $${k.cost_usd_per_wake!.toFixed(2)}/wake ` +
            `(${k.cost_reported} of ${k.wakes} reported)`,
        );
      if (k.exhausted > 0) lines.push(`  ⚠ ${k.exhausted} act(s) exhausted their wake attempts`);
      for (const seat of k.by_seat.filter((b) => b.over_budget))
        lines.push(`  ⚠ ${seat.seat} — a wake exceeded its $${seat.budget_usd} report bound`);
    }
    // Tool-call telemetry (ADR 144 inc 1) — the surface-redesign instrument panel, rendered only
    // once something has landed. Full per-tool detail lives in `musterd report tools`.
    const t = r.tool_calls;
    if (t && (t.calls > 0 || t.surface.length > 0)) {
      lines.push('\ntool surface:');
      if (t.calls > 0) {
        const worst = t.tools.filter((row) => row.bounces > 0).slice(0, 3);
        lines.push(
          `  ${t.calls} calls · ${t.bounces} invalid-input bounce${t.bounces === 1 ? '' : 's'} (${t.window_days}d)`,
        );
        for (const row of worst)
          lines.push(
            `  ⚠ ${row.tool} — ${row.bounces}/${row.calls} bounced (${Math.round((row.bounce_rate ?? 0) * 100)}%)`,
          );
      }
      for (const s of t.surface)
        lines.push(`  ${s.seat}: ${s.tools} tools ≈ ${s.est_tokens} tokens rendered at connect`);
    }
    lines.push('\nwaiting on:');
    lines.push(...waitingLines());
  }

  // The MAST detectors (ADR 091) — rendered only when something is unhealthy, so the common
  // (healthy) case costs the agent no context.
  const m = r.mast;
  if (
    m.ignored_help.length > 0 ||
    m.stalled_threads.length > 0 ||
    m.circular_handoffs.length > 0 ||
    m.diversity.length > 0
  ) {
    lines.push('\ncoordination health (MAST):');
    for (const d of m.ignored_help)
      lines.push(`  ⚠ ignored request_help ${d.id} from ${d.from} — unanswered ${ago(d.age_ms)}`);
    for (const s of m.stalled_threads)
      lines.push(
        `  ⚠ stalled thread ${s.thread} — ${s.acts} acts, quiet ${ago(s.quiet_ms)}, no resolve`,
      );
    for (const c of m.circular_handoffs)
      lines.push(`  ⚠ circular handoff on thread ${c.thread} (${c.hops} hops)`);
    // ADR 101: single-model-family (or unverifiable) review/approval chains — agreement is weak evidence.
    for (const d of m.diversity)
      lines.push(
        d.verdict === 'flagged'
          ? `  ⚑ thread ${d.thread} — ${d.kind} chain single-model-family end-to-end (all ${d.families[0]}-*): treat agreement as weak evidence`
          : `  ? thread ${d.thread} — ${d.kind} chain has an unattested link: model diversity unverifiable`,
      );
  }

  // The open directed ledger (ADR 090): loop-opening acts not yet answered, with per-recipient
  // seen/unseen state — so silence is legible (ignored vs unread) before anyone assumes consent.
  if (r.open_directed.length > 0) {
    lines.push('\nopen directed acts:');
    for (const d of r.open_directed) {
      const to = d.to_kind === 'member' ? (d.recipients[0]?.seat ?? '?') : `@${d.to_kind}`;
      lines.push(
        `  ${d.id} ${d.act}${d.urgent ? ' [urgent]' : ''} from ${d.from} → ${to} · ${ago(d.age_ms)} ago`,
      );
      for (const rec of d.recipients) {
        const state = rec.answered ? `answered (${rec.answered.act})` : rec.state;
        const raises = rec.interrupt_raises > 0 ? ` · ${rec.interrupt_raises} raise(s)` : '';
        lines.push(`    ${rec.seat}: ${state}${raises}`);
      }
    }
  }
  return lines.join('\n');
}

export function registerInsights(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_report',
    {
      description:
        'The insight report over lanes + the act log at three altitudes: ic (the Goal board), ' +
        'team (flow, steering, waiting-on — the default), exec (milestones + exceptions). ' +
        'Derived, never stored; measures outcomes and queues, not message volume.',
      inputSchema: {
        altitude: z
          .enum(['ic', 'team', 'exec'])
          .optional()
          .describe('ic = board, team = flow digest (default), exec = milestones + exceptions'),
      },
    },
    async (args) => {
      try {
        return textResult(fmtReport(await client.report(), args.altitude ?? 'team'));
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  );
}
