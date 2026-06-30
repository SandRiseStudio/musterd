import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import liveCss from '../live/Live.css?url';
import { ApprovalQueue } from '../live/ApprovalQueue';
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
      <div className="lc__canvas">
        {!cfg ? (
          <div className="lc__connect">
            <div className="lc__connect-card">
              <h2>approvals</h2>
              <p>Connect as an admin seat to review claim requests.</p>
              {(['team', 'seat', 'token'] as const).map((field) => (
                <input
                  key={field}
                  type={field === 'token' ? 'password' : 'text'}
                  placeholder={field}
                  value={loginForm[field]}
                  onChange={(e) =>
                    setLogin({ ...loginForm, [field]: e.target.value })
                  }
                />
              ))}
              <button onClick={handleConnect}>connect</button>
            </div>
          </div>
        ) : (
          <>
            {error && <div className="lc__error">{error}</div>}
            <ApprovalQueue requests={requests} onApprove={onApprove} onDeny={onDeny} />
          </>
        )}
      </div>
    </main>
  );
}
