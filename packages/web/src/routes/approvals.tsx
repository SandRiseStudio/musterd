import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import liveCss from '../live/Live.css?url';
import { ApprovalQueue } from '../live/ApprovalQueue';
import { ReceptionScene } from '../live/ReceptionScene';
import type { ApprovalRequest, GrantLifetime } from '../live/ApprovalCard';
import { AuditFetchError, decideRequest, fetchRequests, type LiveConfig, type Request } from '../live/client';

export const Route = createFileRoute('/approvals')({
  head: () => ({
    meta: [{ title: 'musterd — approvals' }],
    links: [{ rel: 'stylesheet', href: liveCss }],
  }),
  component: ApprovalsPage,
});

const POLL_MS = 10_000;

function toApprovalRequest(r: Request): ApprovalRequest {
  const seatOrRole = r.target
    ? r.target.startsWith('seat:')
      ? r.target.slice(5)
      : r.target.startsWith('role:')
        ? r.target.slice(5)
        : r.target
    : 'teammate';
  const role = r.target?.startsWith('role:') ? r.target.slice(5) : undefined;
  return {
    id: r.id,
    seat: seatOrRole,
    ...(role ? { role } : {}),
    surface: r.surface,
    fingerprint: r.from_session.slice(0, 8),
    requestedAt: r.ts,
    expiresAt: r.expires_at,
  };
}

interface LoginState {
  team: string;
  seat: string;
  token: string;
}

function ApprovalsPage() {
  const [login, setLogin] = useState<LoginState | null>(null);
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const loginForm = login ?? { team: '', seat: '', token: '' };
  const canConnect = !!(loginForm.team.trim() && loginForm.seat.trim() && loginForm.token.trim());

  const load = async (liveCfg: LiveConfig) => {
    try {
      const reqs = await fetchRequests(liveCfg, { pendingOnly: true });
      setRequests(reqs.map(toApprovalRequest));
      setError(null);
    } catch (e) {
      setError(e instanceof AuditFetchError ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!cfg) return;
    void load(cfg);
    pollRef.current = setInterval(() => void load(cfg), POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [cfg]);

  const handleConnect = () => {
    if (!loginForm.team || !loginForm.seat || !loginForm.token) return;
    const liveCfg: LiveConfig = { team: loginForm.team, as: loginForm.seat, token: loginForm.token };
    setLogin(loginForm);
    setCfg(liveCfg);
  };

  const onApprove = async (id: string, lifetime: GrantLifetime) => {
    if (!cfg) return;
    try {
      const apiLifetime =
        typeof lifetime === 'object'
          ? { decision: 'approve' as const, lifetime: 'ttl' as const, ttl_hours: lifetime.ttl_hours }
          : { decision: 'approve' as const, lifetime };
      await decideRequest(cfg, id, apiLifetime);
      void load(cfg);
    } catch (e) {
      setError(e instanceof AuditFetchError ? e.message : String(e));
    }
  };

  const onDeny = async (id: string) => {
    if (!cfg) return;
    try {
      await decideRequest(cfg, id, { decision: 'deny' });
      void load(cfg);
    } catch (e) {
      setError(e instanceof AuditFetchError ? e.message : String(e));
    }
  };

  return (
    <main className="lc">
      <header className="lc__topbar">
        <span className="lc__word">musterd</span>
        <span className="lc__team">/ approvals</span>
        <span className="lc__spacer" />
        <span className={`lc__status ${cfg ? 'lc__status--live' : 'lc__status--idle'}`}>
          {cfg ? 'live' : 'preview'}
        </span>
      </header>
      {!cfg ? (
        <div className="lc-form">
          <div className="lc-form__card">
            <h1 className="lc-form__title">Sign in at the front desk</h1>
            <p className="lc-form__sub">
              Connect as an admin seat to see who's asking in — and let them through, or turn them away.
            </p>
            <label className="lc-form__field">
              <span>Team</span>
              <input
                type="text"
                value={loginForm.team}
                placeholder="alpha"
                onChange={(e) => setLogin({ ...loginForm, team: e.target.value })}
              />
            </label>
            <label className="lc-form__field">
              <span>Admin seat</span>
              <input
                type="text"
                value={loginForm.seat}
                placeholder="your seat name"
                onChange={(e) => setLogin({ ...loginForm, seat: e.target.value })}
              />
            </label>
            <label className="lc-form__field">
              <span>Credential</span>
              <input
                type="password"
                value={loginForm.token}
                placeholder="mscr_… (admin credential)"
                onChange={(e) => setLogin({ ...loginForm, token: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              />
            </label>
            {error && <p className="lc-form__error">{error}</p>}
            <button className="lc-form__connect" disabled={!canConnect} onClick={handleConnect}>
              Open the door
            </button>
          </div>
        </div>
      ) : (
        <div className="lc__canvas lc__canvas--companion">
          {error && <div className="lc__error">{error}</div>}
          <ReceptionScene count={requests.length} />
          <ApprovalQueue requests={requests} onApprove={onApprove} onDeny={onDeny} />
        </div>
      )}
    </main>
  );
}
