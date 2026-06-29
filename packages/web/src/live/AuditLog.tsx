import type { AuditEntry } from './client';
import {
  auditActionMeta,
  auditTime,
  formatAuditDetail,
  initial,
  memberColor,
} from './format';

/**
 * The governance audit-log view (ADR 071) — a read-only, admin-only table of the team's append-only
 * audit records, newest-first. Presentational: the route owns fetching, auth, and paging. Each row's
 * `result` (allow/deny) sets a left accent; the `action` carries an act-style tone badge. Unknown
 * actions (P3 will add `grant.*`, `claim.*`, …) still render — the label falls back to the raw token.
 */
export function AuditLog({
  entries,
  onLoadOlder,
  loadingOlder = false,
  hasMore = false,
}: {
  entries: AuditEntry[];
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  hasMore?: boolean;
}) {
  return (
    <section className="lc-audit" aria-label="Governance audit log">
      <header className="lc-audit__head">
        <span className="lc-audit__title">AUDIT LOG</span>
        <span className="lc-audit__count">
          {entries.length} record{entries.length === 1 ? '' : 's'}
        </span>
      </header>

      {entries.length === 0 ? (
        <p className="lc-audit__empty">
          <strong>No audit records yet.</strong>
          Governance events — urgent flags, denied sends, seat reclaims and removals — append here as
          they happen.
        </p>
      ) : (
        <div className="lc-audit__scroll">
          <table className="lc-audit__table">
            <thead>
              <tr>
                <th className="lc-audit__th lc-audit__th--time">Time</th>
                <th className="lc-audit__th">Actor</th>
                <th className="lc-audit__th">Action</th>
                <th className="lc-audit__th">Target</th>
                <th className="lc-audit__th lc-audit__th--result">Result</th>
                <th className="lc-audit__th">Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <AuditRow key={e.id} e={e} />
              ))}
            </tbody>
          </table>

          {onLoadOlder && (
            <div className="lc-audit__more">
              {hasMore ? (
                <button
                  type="button"
                  className="lc-audit__older"
                  onClick={onLoadOlder}
                  disabled={loadingOlder}
                >
                  {loadingOlder && <span className="lc-spinner" aria-hidden="true" />}
                  {loadingOlder ? 'Loading…' : 'Load older'}
                </button>
              ) : (
                <span className="lc-audit__end">— start of log —</span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Seat({ name }: { name: string | null }) {
  if (!name) return <span className="lc-audit__system">system</span>;
  return (
    <span className="lc-audit__seat">
      <span className="lc-audit__avatar" style={{ background: memberColor(name, 'agent') }}>
        {initial(name)}
      </span>
      {name}
    </span>
  );
}

function AuditRow({ e }: { e: AuditEntry }) {
  const action = auditActionMeta(e.action);
  const detail = formatAuditDetail(e.detail);
  return (
    <tr className={`lc-audit__row lc-audit__row--${e.result}`}>
      <td className="lc-audit__td lc-audit__td--time">{auditTime(e.ts)}</td>
      <td className="lc-audit__td">
        <Seat name={e.actor} />
      </td>
      <td className="lc-audit__td">
        <span className={`lc-badge lc-badge--${action.tone}`}>{action.label}</span>
      </td>
      <td className="lc-audit__td">
        <Seat name={e.target} />
      </td>
      <td className="lc-audit__td lc-audit__td--result">
        <span className={`lc-result lc-result--${e.result}`}>{e.result}</span>
      </td>
      <td className="lc-audit__td lc-audit__td--detail" title={detail}>
        {detail || <span className="lc-audit__system">—</span>}
      </td>
    </tr>
  );
}
