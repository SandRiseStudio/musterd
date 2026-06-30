import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import liveCss from '../live/Live.css?url';
import { ApprovalQueue } from '../live/ApprovalQueue';
import type { ApprovalRequest, GrantLifetime } from '../live/ApprovalCard';
import {
  AuditFetchError,
  decideRequest,
  fetchRequests,
  type ClaimRequest,
  type LiveConfig,
} from '../live/client';

export const Route = createFileRoute('/approvals')({
  head: () => ({
    meta: [{ title: 'musterd — approvals' }],
    links: [{ rel: 'stylesheet', href: liveCss }],
  }),
  component: ApprovalsPage,
});

const TEAM_KEY = 'musterd.approvals.team';
const SEAT_KEY = 'musterd.approvals.seat';
const POLL_MS = 10_000;

/** Map the API ClaimRequest wire to the ApprovalCard UI type. */
function toApprovalRequest(r: ClaimRequest): ApprovalRequest {
  return {
    id: r.id,
    seat: r.target_seat ?? r.target_role ?? 'unknown',
    ...(r.target_role ? { role: r.target_role } : {}),
    surface: r.surface,
    fingerprint: r.from_conn_id.slice(0, 8),
    requestedAt: r.ts,
    expiresAt: r.expires_at,
  };
}

/** Map UI GrantLifetime → API { lifetime, ttl_hours? }. */
function toApiLifetime(l: GrantLifetime): {
  lifetime: 'once' | 'ttl' | 'standing';
  ttl_hours?: number;
} {
  if (l === 'once') return { lifetime: 'once' };
  if (l === 'standing') return { lifetime: 'standing' };
  return { lifetime: 'ttl', ttl_hours: l.ttl_hours };
}

function explain(err: unknown): string {
  if (err instanceof AuditFetchError) {
    if (err.status === 401) return 'That token was rejected. Enter the token for an admin seat.';
    if (err.status === 403) return 'That seat is not an admin — the approval queue is admin-only.';
    if (err.status === 404)
      return 'No /requests endpoint on this daemon. It needs the P3.2 build (ADR 077).';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function ApprovalsPage() {
  const [team, setTeam] = useState('');
  const [as, setAs] = useState('');
  const [token, setToken] = useState('');
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // SSR-safe hydrate of the last team/seat.
  useState(() => {
    if (typeof window === 'undefined') return;
    setTeam(window.localStorage.getItem(TEAM_KEY) ?? '');
    setAs(window.localStorage.getItem(SEAT_KEY) ?? '');
  });

  // Poll for pending requests while connected.
  useEffect(() => {
    if (!cfg) return;
    const load = async () => {
      try {
        const rows = await fetchRequests(cfg, { status: 'pending', limit: 50 });
        setRequests(rows.map(toApprovalRequest));
      } catch (e) {
        setError(explain(e));
      }
    };
    void load();
    pollRef.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [cfg]);

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
      const rows = await fetchRequests(c, { status: 'pending', limit: 50 });
      setCfg(c);
      setRequests(rows.map(toApprovalRequest));
      setStatus('loaded');
    } catch (e) {
      setError(explain(e));
      setStatus('error');
    }
  };

  const onApprove = async (id: string, lifetime: GrantLifetime) => {
    if (!cfg) return;
    try {
      await decideRequest(cfg, id, { approve: true, ...toApiLifetime(lifetime) });
    } catch (e) {
      setError(explain(e));
    }
  };

  const onDeny = async (id: string) => {
    if (!cfg) return;
    try {
      await decideRequest(cfg, id, { approve: false });
    } catch (e) {
      setError(explain(e));
    }
  };

  const connected = cfg != null && status !== 'error';

  return (
    <main className="lc">
      <header className="lc__topbar">
        <span className="lc__word">musterd</span>
        <span className="lc__team">/ {connected ? `${cfg!.team} · approvals` : 'approvals'}</span>
        <span className="lc__spacer" />
        <span className="lc__status lc__status--idle">
          {connected ? `${requests.length} pending` : 'disconnected'}
        </span>
      </header>

      {!connected ? (
        <div className="lc-form">
          <div className="lc-form__card">
            <h1 className="lc-form__title">Approval queue</h1>
            <p className="lc-form__sub">
              Review and approve or deny pending seat claim requests (ADR 077). Connect as an admin
              seat to manage the queue.
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
              {status === 'loading' ? 'Loading…' : 'View approval queue'}
            </button>
          </div>
        </div>
      ) : (
        <div className="lc__canvas">
          {error && <p className="lc-form__error">{error}</p>}
          <ApprovalQueue requests={requests} onApprove={onApprove} onDeny={onDeny} />
        </div>
      )}
    </main>
  );
}
