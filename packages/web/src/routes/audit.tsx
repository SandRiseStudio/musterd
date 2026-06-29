import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import liveCss from '../live/Live.css?url';
import { AuditLog } from '../live/AuditLog';
import { AuditFetchError, fetchAudit, type AuditEntry, type LiveConfig } from '../live/client';

export const Route = createFileRoute('/audit')({
  head: () => ({
    meta: [{ title: 'musterd — governance audit' }],
    links: [{ rel: 'stylesheet', href: liveCss }],
  }),
  component: AuditPage,
});

const TEAM_KEY = 'musterd.audit.team';
const SEAT_KEY = 'musterd.audit.seat';
const PAGE = 100;

/** Map a fetch failure to admin-aware copy — the audit log is gated on `is_admin`/`visibility: admin`. */
function explain(err: unknown): string {
  if (err instanceof AuditFetchError) {
    if (err.status === 401) return 'That token was rejected. Enter the token for an admin seat.';
    if (err.status === 403)
      return 'That seat is not an admin — the audit log is visible to admins only (is_admin / admin visibility).';
    if (err.status === 404)
      return 'No audit endpoint on this daemon. It needs the v0.3 P2 build (ADR 071) — ask an operator to update it.';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function AuditPage() {
  const [team, setTeam] = useState('');
  const [as, setAs] = useState('');
  const [token, setToken] = useState('');
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // SSR-safe hydrate of the last team/seat (never the token — that stays in memory only).
  useState(() => {
    if (typeof window === 'undefined') return;
    setTeam(window.localStorage.getItem(TEAM_KEY) ?? '');
    setAs(window.localStorage.getItem(SEAT_KEY) ?? '');
  });

  const connect = async () => {
    const t = team.trim();
    const seat = as.trim();
    if (!t || !seat || !token.trim()) return;
    window.localStorage.setItem(TEAM_KEY, t);
    window.localStorage.setItem(SEAT_KEY, seat);
    const c: LiveConfig = { team: t, as: seat, token: token.trim() };
    setStatus('loading');
    setError(null);
    try {
      const batch = await fetchAudit(c, { limit: PAGE });
      setCfg(c);
      setEntries(batch);
      setHasMore(batch.length === PAGE);
      setStatus('loaded');
    } catch (e) {
      setError(explain(e));
      setStatus('error');
    }
  };

  const loadOlder = async () => {
    if (!cfg || entries.length === 0) return;
    setLoadingOlder(true);
    try {
      const before = entries[entries.length - 1]!.ts;
      const batch = await fetchAudit(cfg, { limit: PAGE, before });
      setEntries((prev) => [...prev, ...batch]);
      setHasMore(batch.length === PAGE);
    } catch (e) {
      setError(explain(e));
    } finally {
      setLoadingOlder(false);
    }
  };

  const refresh = async () => {
    if (!cfg) return;
    setStatus('loading');
    try {
      const batch = await fetchAudit(cfg, { limit: PAGE });
      setEntries(batch);
      setHasMore(batch.length === PAGE);
      setStatus('loaded');
    } catch (e) {
      setError(explain(e));
      setStatus('error');
    }
  };

  const connected = cfg != null && status !== 'error';

  return (
    <main className="lc">
      <header className="lc__topbar">
        <span className="lc__word">musterd</span>
        <span className="lc__team">/ {connected ? `${cfg!.team} · audit` : 'audit'}</span>
        <span className="lc__spacer" />
        {connected && (
          <button className="lc-audit__refresh" onClick={refresh} disabled={status === 'loading'}>
            Refresh
          </button>
        )}
      </header>

      {!connected ? (
        <div className="lc-form">
          <div className="lc-form__card">
            <h1 className="lc-form__title">Governance audit log</h1>
            <p className="lc-form__sub">
              The append-only record of governance decisions on a team (ADR 071). Admin-only — connect
              as a seat with admin rights.
            </p>
            <label className="lc-form__field">
              <span>Team</span>
              <input
                type="text"
                value={team}
                placeholder="ritual"
                onChange={(e) => setTeam(e.target.value)}
              />
            </label>
            <label className="lc-form__field">
              <span>Admin seat</span>
              <input
                type="text"
                value={as}
                placeholder="your seat name"
                onChange={(e) => setAs(e.target.value)}
              />
            </label>
            <label className="lc-form__field">
              <span>Token</span>
              <input
                type="password"
                value={token}
                placeholder="mskd_…"
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void connect()}
              />
            </label>
            {error && <p className="lc-form__error">{error}</p>}
            <button
              className="lc-form__connect"
              disabled={!team.trim() || !as.trim() || !token.trim() || status === 'loading'}
              onClick={() => void connect()}
            >
              {status === 'loading' && <span className="lc-spinner" aria-hidden="true" />}
              {status === 'loading' ? 'Loading…' : 'View audit log'}
            </button>
          </div>
        </div>
      ) : (
        <div className="lc__canvas">
          <AuditLog
            entries={entries}
            onLoadOlder={loadOlder}
            loadingOlder={loadingOlder}
            hasMore={hasMore}
          />
        </div>
      )}
    </main>
  );
}
