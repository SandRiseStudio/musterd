import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { MusterdWord } from '../brand/MusterdWord';
import { ApprovalCard } from '../live/ApprovalCard';
import { ReceptionScene } from '../live/ReceptionScene';
import type { ApprovalState, GrantLifetime } from '../live/ApprovalCard';

export const Route = createFileRoute('/approval-preview')({
  head: () => ({
    meta: [{ title: 'musterd — approval card preview' }],
    links: [
      { rel: 'stylesheet', href: liveCss },
      { rel: 'stylesheet', href: brandCss },
    ],
  }),
  component: ApprovalPreviewPage,
});

/* Synthetic fixture — no live daemon needed. Timestamps are relative to "now" so the
   expiry countdown and relative times are always meaningful when you open the page. */
const NOW = Date.now();
const BASE_REQUEST = {
  id: '01KWABCDEF1234567890ABCDEF',
  seat: 'Ada',
  role: 'backend',
  surface: 'claude-code',
  fingerprint: 'sha256:a1b2c3d4',
  requestedAt: NOW - 5 * 60 * 1000,
  expiresAt: NOW + 55 * 60 * 1000,
};
const BATCH_REQUEST = {
  ...BASE_REQUEST,
  id: '01KWABCDEF1234567890ABCDEE',
  seat: 'backend-1',
  surface: 'cursor',
  fingerprint: 'sha256:e5f6a7b8',
  batchCount: 3,
};

function ApprovalPreviewPage() {
  const [pendingState, setPendingState] = useState<'pending' | 'approved' | 'denied'>('pending');
  const [lifetime, setLifetime] = useState<GrantLifetime>('once');

  const handleApprove = (lt: GrantLifetime) => {
    setLifetime(lt);
    setPendingState('approved');
  };

  const states: ApprovalState[] = [
    pendingState === 'pending'
      ? {
          kind: 'pending',
          request: BASE_REQUEST,
          onApprove: handleApprove,
          onDeny: () => setPendingState('denied'),
        }
      : pendingState === 'approved'
        ? { kind: 'approved', request: BASE_REQUEST, lifetime, approvedAt: Date.now() }
        : { kind: 'denied', request: BASE_REQUEST, deniedAt: Date.now() },
    {
      kind: 'pending',
      request: BATCH_REQUEST,
      onApprove: () => {},
      onDeny: () => {},
    },
    {
      kind: 'approved',
      request: {
        ...BASE_REQUEST,
        id: '01KWABCDEF1234567890000001',
        seat: 'Jasmine',
        surface: 'codex',
        fingerprint: 'sha256:c9d0e1f2',
      },
      lifetime: { ttl_hours: 4 },
      approvedAt: NOW - 2 * 60 * 1000,
    },
    {
      kind: 'denied',
      request: {
        ...BASE_REQUEST,
        id: '01KWABCDEF1234567890000002',
        seat: 'unknown-1',
        role: 'unknown',
        surface: 'vscode',
        fingerprint: 'sha256:99aabbcc',
      },
      deniedAt: NOW - 8 * 60 * 1000,
    },
    {
      kind: 'expired',
      request: {
        ...BASE_REQUEST,
        id: '01KWABCDEF1234567890000003',
        seat: 'Riley',
        role: 'frontend',
        surface: 'claude-code',
        fingerprint: 'sha256:ddee1122',
        requestedAt: NOW - 62 * 60 * 1000,
        expiresAt: NOW - 2 * 60 * 1000,
      },
    },
  ];

  return (
    <main className="lc" style={{ overflowY: 'auto' }}>
      <header className="lc__topbar">
        <MusterdWord />
        <span className="lc__team">/ approval card preview</span>
        <span className="lc__spacer" />
        <span className="lc__status lc__status--live">design preview</span>
      </header>

      <div style={{ maxWidth: 1200, margin: '24px auto 0', width: '100%', padding: '0 24px' }}>
        <ReceptionScene count={states.filter((s) => s.kind === 'pending').length} />
      </div>

      <div
        style={{
          padding: '32px 24px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
          gap: '20px',
          alignItems: 'start',
          maxWidth: 1200,
          margin: '0 auto',
          width: '100%',
        }}
      >
        {states.map((s, i) => (
          <div key={i}>
            <p
              style={{
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 11,
                color: 'var(--lc-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
                marginBottom: 8,
              }}
            >
              {STATE_LABEL[s.kind]}
              {s.kind === 'pending' && i === 0 && ' (interactive)'}
            </p>
            <ApprovalCard {...s} />
          </div>
        ))}
      </div>

      {pendingState !== 'pending' && (
        <div style={{ textAlign: 'center', paddingBottom: 32 }}>
          <button
            onClick={() => setPendingState('pending')}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,233,208,0.1)',
              borderRadius: 8,
              color: 'var(--lc-muted)',
              padding: '6px 16px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Reset interactive card
          </button>
        </div>
      )}
    </main>
  );
}

const STATE_LABEL: Record<ApprovalState['kind'], string> = {
  pending: 'pending',
  approved: 'approved',
  denied: 'denied',
  expired: 'expired',
};
