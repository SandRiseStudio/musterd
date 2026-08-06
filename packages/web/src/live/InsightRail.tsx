import type { MemberSummary, Report } from '@musterd/protocol';
import { useState } from 'react';
import { kindOf, memberInk } from './format';
import { CollapseButton, PanelRail } from './PanelChrome';

/**
 * The insight rail (ADR 104 Inc B) — the board's right-hand read of the one server-side projection
 * (`GET /report`). Calm by default: flow, the waiting-on line (the human-work-identity payoff — the
 * board naming a human as the bottleneck), live blocked exceptions, and the coordination flag only
 * when it trips. The denser detectors (MAST, steering, wake) sit behind a "more" disclosure so the
 * rail is never a wall of metrics. Renders only what the engine derives — nothing computed here.
 */

/** Compact duration from ms (`3m`, `2h`, `4d`) — the board's `ago` grammar, for spans. */
function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function InsightRail({
  report,
  rosterIdx,
  collapsed,
  onCollapsed,
}: {
  report: Report | null;
  rosterIdx: Map<string, MemberSummary>;
  collapsed: boolean;
  onCollapsed: (c: boolean) => void;
}) {
  const [more, setMore] = useState(false);

  if (collapsed) {
    // The shared spine positions absolutely inside its panel slot — give it one (the /live idiom).
    return (
      <div className="lc-insight lc-insight--rail">
        <PanelRail
          side="right"
          label="insight"
          hint={report && report.waiting_on.length > 0 ? String(report.waiting_on.length) : undefined}
          onExpand={() => onCollapsed(false)}
        />
      </div>
    );
  }

  return (
    <aside className="lc-insight" aria-label="Team insight">
      <header className="lc-insight__head">
        <span className="lc-insight__title">insight</span>
        <span className="lc__spacer" />
        <CollapseButton side="right" label="insight" onClick={() => onCollapsed(true)} />
      </header>

      {report == null ? (
        <p className="lc-insight__empty">Reading the room…</p>
      ) : (
        <>
          <section className="lc-insight__section" aria-label="Flow">
            <h3 className="lc-insight__label">flow</h3>
            <dl className="lc-insight__stats">
              <div>
                <dt>shipped 7d</dt>
                <dd>{report.flow.throughput_7d}</dd>
              </div>
              <div>
                <dt>cycle</dt>
                <dd>{fmtMs(report.flow.cycle_time_ms)}</dd>
              </div>
              <div>
                <dt>in flight</dt>
                <dd>{report.flow.wip}</dd>
              </div>
              <div>
                <dt>oldest</dt>
                <dd>{fmtMs(report.flow.oldest_wip_age_ms)}</dd>
              </div>
            </dl>
          </section>

          <section className="lc-insight__section" aria-label="Waiting on">
            <h3 className="lc-insight__label">waiting on</h3>
            {report.waiting_on.length === 0 ? (
              <p className="lc-insight__quiet">No one. The room is answered.</p>
            ) : (
              <ul className="lc-insight__list">
                {report.waiting_on.map((w) => (
                  <li key={w.member} className="lc-insight__wait">
                    <span
                      className="lc-insight__who"
                      style={{ color: memberInk(w.member, kindOf(w.member, rosterIdx)) }}
                    >
                      {w.member}
                    </span>{' '}
                    — {w.threads} {w.threads === 1 ? 'thread' : 'threads'}, oldest{' '}
                    {fmtMs(w.oldest_age_ms)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="lc-insight__section" aria-label="Blocked">
            <h3 className="lc-insight__label">blocked</h3>
            {report.blocked.length === 0 ? (
              <p className="lc-insight__quiet">Nothing stuck.</p>
            ) : (
              <ul className="lc-insight__list">
                {report.blocked.map((b) => (
                  <li key={b.id}>
                    {b.title}
                    {b.owner_seat && <span className="lc-insight__dim"> · {b.owner_seat}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {report.coordination.flag && (
            <section className="lc-insight__section lc-insight__section--flag" aria-label="Coordination">
              <h3 className="lc-insight__label">coordination</h3>
              <p className="lc-insight__quiet">
                Journal-heavy: {Math.round(report.coordination.journal_ratio * 100)}% broadcast,{' '}
                {Math.round(report.coordination.exchange_ratio * 100)}% real exchange.
              </p>
            </section>
          )}

          <button className="lc-insight__more" onClick={() => setMore(!more)}>
            {more ? 'less' : 'more'}
          </button>

          {more && (
            <section className="lc-insight__section" aria-label="Detectors">
              <h3 className="lc-insight__label">detectors</h3>
              <ul className="lc-insight__list lc-insight__list--dim">
                <li>unblock median {fmtMs(report.mast.time_to_unblock.median_ms)}</li>
                <li>ignored help · {report.mast.ignored_help.length}</li>
                <li>stalled threads · {report.mast.stalled_threads.length}</li>
                <li>circular handoffs · {report.mast.circular_handoffs.length}</li>
                <li>
                  steers {report.steering.steers} · acked {report.steering.acked} · median{' '}
                  {fmtMs(report.steering.latency_median_ms)}
                </li>
                {report.wake && (
                  <li>
                    wakes ·{' '}
                    {report.wake.by_seat.reduce((n, s) => n + s.wakes, 0)}
                    {report.wake.cost_usd_total != null &&
                      ` · $${report.wake.cost_usd_total.toFixed(2)}`}
                  </li>
                )}
                <li>open loops · {report.open_directed.length}</li>
              </ul>
            </section>
          )}
        </>
      )}
    </aside>
  );
}
