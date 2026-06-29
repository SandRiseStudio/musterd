import './ApprovalCard.css';
import { useEffect, useState } from 'react';

/* ── types ─────────────────────────────────────────────────────────────────
 * These are P3-prep: the wire types (claim frame, POST /decide) don't exist yet.
 * This component is design-only — no backend integration. ADR 072.
 */

export interface ApprovalRequest {
  id: string;
  seat: string;
  role?: string;
  surface: string;
  fingerprint: string;
  requestedAt: number;
  expiresAt: number;
  batchCount?: number;
}

export type GrantLifetime = 'once' | { ttl_hours: number } | 'standing';

export type ApprovalState =
  | {
      kind: 'pending';
      request: ApprovalRequest;
      onApprove: (lifetime: GrantLifetime) => void;
      onDeny: () => void;
    }
  | { kind: 'approved'; request: ApprovalRequest; lifetime: GrantLifetime; approvedAt: number }
  | { kind: 'denied'; request: ApprovalRequest; deniedAt: number }
  | { kind: 'expired'; request: ApprovalRequest };

/* ── component ─────────────────────────────────────────────────────────────── */

export function ApprovalCard(props: ApprovalState) {
  const req = props.request;
  const state = props.kind;

  return (
    <div className={`ac ac--${state}`}>
      <div className="ac__head">
        <div className="ac__icon">
          <StateIcon kind={state} />
        </div>
        <span className="ac__label">{HEAD_LABEL[state]}</span>
        {req.batchCount != null && req.batchCount > 1 && (
          <span className="ac__batch">×{req.batchCount}</span>
        )}
      </div>

      <div className="ac__body">
        <div className="ac__row">
          <span className="ac__row-key">Seat</span>
          <span className="ac__row-val ac__row-val--seat">
            {req.seat}
            {req.role && req.role !== req.seat ? ` (${req.role})` : ''}
          </span>
        </div>
        <div className="ac__row">
          <span className="ac__row-key">Surface</span>
          <span className="ac__row-val">
            <SurfacePill surface={req.surface} />
          </span>
        </div>
        <div className="ac__row">
          <span className="ac__row-key">Harness</span>
          <span className="ac__row-val ac__row-val--fp">{req.fingerprint}</span>
        </div>
        {state === 'pending' && (
          <ExpiryBar requestedAt={req.requestedAt} expiresAt={req.expiresAt} />
        )}
        {state === 'approved' && (
          <div className="ac__row">
            <span className="ac__row-key">Grant</span>
            <span className="ac__row-val">
              <LifetimeBadge lifetime={props.lifetime} />
            </span>
          </div>
        )}
      </div>

      {state === 'pending' && (
        <div className="ac__actions">
          <span className="ac__actions-label">Grant for…</span>
          <div className="ac__lifetime-btns">
            <button
              type="button"
              className="ac__btn"
              onClick={() => props.onApprove('once')}
              title="Single-use — expires on release"
            >
              <span className="ac__btn-title">Once</span>
              <span className="ac__btn-sub">single session</span>
            </button>
            <button
              type="button"
              className="ac__btn"
              onClick={() => props.onApprove({ ttl_hours: 4 })}
              title="Allow reconnects within 4 hours"
            >
              <span className="ac__btn-title">4 hours</span>
              <span className="ac__btn-sub">reconnects OK</span>
            </button>
            <button
              type="button"
              className="ac__btn"
              onClick={() => props.onApprove('standing')}
              title="Until you revoke — for trusted long-running harnesses"
            >
              <span className="ac__btn-title">Standing</span>
              <span className="ac__btn-sub">until revoked</span>
            </button>
          </div>
          <button type="button" className="ac__deny" onClick={props.onDeny}>
            Deny request
          </button>
        </div>
      )}

      {state === 'approved' && (
        <div className="ac__settled">
          <CheckIcon />
          Approved by you · {relTime(props.approvedAt)}
        </div>
      )}
      {state === 'denied' && (
        <div className="ac__settled">
          <XIcon />
          Denied · {relTime(props.deniedAt)}
        </div>
      )}
      {state === 'expired' && (
        <div className="ac__settled">
          <ClockIcon />
          Request expired — no admin responded in time
        </div>
      )}
    </div>
  );
}

/* ── sub-components ──────────────────────────────────────────────────────── */

function SurfacePill({ surface }: { surface: string }) {
  return (
    <span className="ac__surface">
      <span className="ac__surface-dot" />
      {surface}
    </span>
  );
}

function LifetimeBadge({ lifetime }: { lifetime: GrantLifetime }) {
  const label =
    lifetime === 'once'
      ? 'Once'
      : lifetime === 'standing'
        ? 'Standing'
        : `${lifetime.ttl_hours}h`;
  const detail =
    lifetime === 'once'
      ? 'single session'
      : lifetime === 'standing'
        ? 'until revoked'
        : 'TTL grant';
  return (
    <span className="ac__lifetime" title={detail}>
      <CheckIcon />
      {label}
    </span>
  );
}

function ExpiryBar({ requestedAt, expiresAt }: { requestedAt: number; expiresAt: number }) {
  const total = expiresAt - requestedAt;
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()));

  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, expiresAt - Date.now()));
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const pct = total > 0 ? Math.round((remaining / total) * 100) : 0;
  const urgent = remaining < 10 * 60 * 1000;
  const label = remaining <= 0 ? 'expired' : formatCountdown(remaining);

  return (
    <div className={`ac__expiry${urgent ? ' ac__expiry--urgent' : ''}`}>
      <span>Expires in {label}</span>
      <div className="ac__expiry-bar">
        <div className="ac__expiry-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ── icons ──────────────────────────────────────────────────────────────── */

function StateIcon({ kind }: { kind: ApprovalState['kind'] }) {
  if (kind === 'pending') return <KeyIcon />;
  if (kind === 'approved') return <CheckIcon />;
  if (kind === 'denied') return <XIcon />;
  return <ClockIcon />;
}
function KeyIcon() {
  return (
    <svg viewBox="0 0 15 15" aria-hidden="true">
      <circle cx="5.5" cy="7.5" r="3" />
      <path d="M8 7.5h5.5M11.5 7.5v2" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 6.5 4.7 9l5.3-6" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="m3 3 6 6M9 3 3 9" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" />
      <path d="M6 3.5v3l2 1.5" />
    </svg>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const HEAD_LABEL: Record<ApprovalState['kind'], string> = {
  pending: 'Approval request',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired',
};

function formatCountdown(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
